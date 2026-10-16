// Package psa holds the appliance-side PSA adapters: real authentication and API tests executed in the
// client's Docker environment (Module 11). The Control Plane never calls a PSA API; it only receives the
// sanitized result (codes, HTTP status, latency) through the agent.
//
// Every adapter performs one minimal, read-only request that proves authentication and API access —
// the same probe the reference connectors use (Autotask: one company; ConnectWise: one company).
// Response bodies are never stored or logged; credentials never appear in results.
package psa

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"psacc.local/edge/internal/redact"
)

// Result codes (stable identifiers, safe to report).
const (
	CodeOK            = "ok"
	CodeAuthFailed    = "auth_failed"
	CodeForbidden     = "forbidden"
	CodeNotFound      = "not_found"
	CodeRateLimited   = "rate_limited"
	CodeServerError   = "server_error"
	CodeBadResponse   = "bad_response"
	CodeUnreachable   = "endpoint_unreachable"
	CodeTLSError      = "tls_error"
	CodeTimeout       = "timeout"
	CodeNotConfigured = "not_configured"
	CodeUnsupported   = "unsupported"
	CodeInvalidConfig = "invalid_config"
)

// Conn is everything an adapter needs for one test. Credentials are decrypted just for the call.
type Conn struct {
	Provider    string
	AuthMethod  string
	Endpoint    string         // derived by the Control Plane adapter, e.g. https://webservices5.autotask.net/ATServicesRest
	Config      map[string]any // non-secret provider configuration from the package
	Credentials map[string]string
	// CACertPEM optionally trusts a private CA (on-premise PSA servers). Empty = system roots only.
	CACertPEM string
	Client    *http.Client // optional; built from Timeout/CACertPEM when nil
	Timeout   time.Duration
	// cache holds per-connection lookups made during one sync (picklists, board statuses, bearer tokens).
	cache map[string]any
}

// Result is what gets stored and reported. Detail is redacted and short; Identity holds only
// non-secret facts about the remote system (API name, host, a version when the API returns one).
type Result struct {
	OK         bool              `json:"ok"`
	Code       string            `json:"code"`
	HTTPStatus int               `json:"httpStatus,omitempty"`
	Latency    time.Duration     `json:"-"`
	LatencyMs  int               `json:"latencyMs"`
	Detail     string            `json:"detail"`
	Identity   map[string]string `json:"identity,omitempty"`
}

func (c *Conn) cred(key string) string { return strings.TrimSpace(c.Credentials[key]) }

func (c *Conn) str(key string) string {
	if v, ok := c.Config[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

func (c *Conn) missing(keys ...string) []string {
	var out []string
	for _, k := range keys {
		if c.cred(k) == "" {
			out = append(out, k)
		}
	}
	return out
}

// NewHTTPClient builds the client used for tests: short timeout, TLS 1.2+, system roots plus an
// optional private CA, at most two redirects, and no proxy surprises (environment proxies are honoured).
func NewHTTPClient(caPEM string, timeout time.Duration) (*http.Client, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if strings.TrimSpace(caPEM) != "" {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM([]byte(caPEM)) {
			return nil, errors.New("the custom CA certificate is not valid PEM")
		}
		tlsCfg.RootCAs = pool
	}
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSClientConfig:       tlsCfg,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
		MaxIdleConns:          2,
		DisableCompression:    false,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 2 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}, nil
}

// Run executes the provider's test. It never panics on missing configuration and never returns an
// error for remote failures: those are results.
func Run(ctx context.Context, c *Conn) Result {
	if c.Timeout == 0 {
		c.Timeout = 20 * time.Second
	}
	if c.Client == nil {
		cl, err := NewHTTPClient(c.CACertPEM, c.Timeout)
		if err != nil {
			return Result{Code: CodeInvalidConfig, Detail: err.Error()}
		}
		c.Client = cl
	}
	if c.Endpoint == "" {
		return Result{Code: CodeInvalidConfig, Detail: "The package carries no API endpoint for this PSA instance."}
	}
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return Result{Code: CodeInvalidConfig, Detail: "The API endpoint must be an https URL."}
	}
	ctx, cancel := context.WithTimeout(ctx, c.Timeout+2*time.Second)
	defer cancel()
	start := time.Now()
	var r Result
	switch c.Provider {
	case "autotask":
		r = testAutotask(ctx, c)
	case "connectwise":
		r = testConnectWise(ctx, c)
	case "halopsa":
		r = testHalo(ctx, c)
	case "kaseya_bms":
		r = testKaseya(ctx, c)
	case "freshservice":
		r = testFreshservice(ctx, c)
	case "servicenow":
		r = testServiceNow(ctx, c)
	case "custom_rest":
		r = testCustomREST(ctx, c)
	default:
		r = Result{Code: CodeUnsupported, Detail: "No adapter for provider " + redact.Text(c.Provider, 40) + "."}
	}
	r.Latency = time.Since(start)
	r.LatencyMs = int(r.Latency / time.Millisecond)
	if r.Identity == nil {
		r.Identity = map[string]string{}
	}
	if _, ok := r.Identity["host"]; !ok {
		r.Identity["host"] = u.Host
	}
	r.Detail = redact.Text(r.Detail, 500)
	return r
}

// ---- shared mechanics ----

type probe struct {
	method  string
	url     string
	headers map[string]string
	body    []byte
	form    url.Values
}

// do sends one request and classifies the outcome. Bodies are read only far enough to decide
// whether the response is the JSON the API promises; they are never kept.
func do(ctx context.Context, c *Conn, p probe, expectJSON bool) (Result, []byte) {
	var rdr io.Reader
	if p.form != nil {
		rdr = strings.NewReader(p.form.Encode())
	} else if p.body != nil {
		rdr = strings.NewReader(string(p.body))
	}
	req, err := http.NewRequestWithContext(ctx, p.method, p.url, rdr)
	if err != nil {
		return Result{Code: CodeInvalidConfig, Detail: "The request could not be built: " + err.Error()}, nil
	}
	req.Header.Set("User-Agent", "psa-edge/0.1 (connection test)")
	req.Header.Set("Accept", "application/json")
	if p.form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else if p.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range p.headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Client.Do(req)
	if err != nil {
		return classifyTransport(err), nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return Result{Code: CodeAuthFailed, HTTPStatus: resp.StatusCode, Detail: "The PSA rejected the credentials (HTTP 401)."}, body
	case resp.StatusCode == http.StatusForbidden:
		return Result{Code: CodeForbidden, HTTPStatus: resp.StatusCode, Detail: "The credentials are valid but lack permission for this API (HTTP 403)."}, body
	case resp.StatusCode == http.StatusNotFound:
		return Result{Code: CodeNotFound, HTTPStatus: resp.StatusCode, Detail: "The API path was not found (HTTP 404); check the endpoint or zone."}, body
	case resp.StatusCode == http.StatusTooManyRequests:
		return Result{Code: CodeRateLimited, HTTPStatus: resp.StatusCode, Detail: "The PSA is rate limiting this integration (HTTP 429)."}, body
	case resp.StatusCode >= 500:
		return Result{Code: CodeServerError, HTTPStatus: resp.StatusCode, Detail: fmt.Sprintf("The PSA returned a server error (HTTP %d).", resp.StatusCode)}, body
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return Result{Code: CodeBadResponse, HTTPStatus: resp.StatusCode, Detail: fmt.Sprintf("Unexpected HTTP %d from the PSA.", resp.StatusCode)}, body
	}
	if expectJSON && !json.Valid(body) {
		ct := resp.Header.Get("Content-Type")
		return Result{Code: CodeBadResponse, HTTPStatus: resp.StatusCode, Detail: "The endpoint answered, but not with the JSON the API promises (content type " + redact.Text(ct, 60) + "); check the endpoint."}, body
	}
	return Result{OK: true, Code: CodeOK, HTTPStatus: resp.StatusCode, Detail: "Authentication and API access succeeded."}, body
}

func classifyTransport(err error) Result {
	var ne net.Error
	msg := err.Error()
	switch {
	case errors.As(err, &ne) && ne.Timeout(), errors.Is(err, context.DeadlineExceeded), strings.Contains(msg, "Client.Timeout"):
		return Result{Code: CodeTimeout, Detail: "The PSA did not answer in time."}
	case isTLSError(err):
		return Result{Code: CodeTLSError, Detail: "TLS handshake failed: " + shortErr(msg) + ". For on-premise servers with a private CA, add the CA certificate below."}
	case strings.Contains(msg, "too many redirects"):
		return Result{Code: CodeBadResponse, Detail: "The endpoint redirected repeatedly; check the endpoint."}
	default:
		return Result{Code: CodeUnreachable, Detail: "The endpoint could not be reached: " + shortErr(msg) + "."}
	}
}

func isTLSError(err error) bool {
	var ce x509.CertificateInvalidError
	var ue x509.UnknownAuthorityError
	var he x509.HostnameError
	var re tls.RecordHeaderError
	if errors.As(err, &ce) || errors.As(err, &ue) || errors.As(err, &he) || errors.As(err, &re) {
		return true
	}
	m := err.Error()
	return strings.Contains(m, "x509:") || strings.Contains(m, "tls:")
}

// shortErr strips Go's "Method \"url\": " prefix and anything that could echo request details.
func shortErr(msg string) string {
	if i := strings.LastIndex(msg, ": "); i >= 0 && i < len(msg)-2 {
		msg = msg[i+2:]
	}
	return redact.Text(msg, 120)
}

func basicAuth(user, pass string) string {
	return "Basic " + base64Encode(user+":"+pass)
}

// tokenRequest performs an OAuth 2.0 token request (form encoded) and returns the bearer token.
func tokenRequest(ctx context.Context, c *Conn, tokenURL string, form url.Values, headers map[string]string) (string, Result) {
	r, body := do(ctx, c, probe{method: http.MethodPost, url: tokenURL, form: form, headers: headers}, true)
	if !r.OK {
		if r.Code == CodeBadResponse || r.Code == CodeAuthFailed {
			r.Detail = "The token endpoint rejected the client credentials (HTTP " + fmt.Sprint(r.HTTPStatus) + ")."
			if r.HTTPStatus == http.StatusBadRequest || r.HTTPStatus == http.StatusUnauthorized {
				r.Code = CodeAuthFailed
			}
		}
		return "", r
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if json.Unmarshal(body, &tok) != nil || strings.TrimSpace(tok.AccessToken) == "" {
		return "", Result{Code: CodeBadResponse, HTTPStatus: r.HTTPStatus, Detail: "The token endpoint answered without an access token."}
	}
	return tok.AccessToken, r
}
