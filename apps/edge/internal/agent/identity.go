package agent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"psacc.local/edge/internal/config"
)

// Machine identity on this host, kept in the agent-state volume:
//   agent.key (ECDSA P-256, 0600), agent.crt, ca.pem, state.json

type State struct {
	State           string     `json:"state"` // pending | enrolled | revoked | decommissioned | failed
	DeploymentID    string     `json:"deploymentId,omitempty"`
	InstallationID  string     `json:"installationId,omitempty"`
	Serial          string     `json:"serial,omitempty"`
	EnrolledAt      *time.Time `json:"enrolledAt,omitempty"`
	NotBefore       *time.Time `json:"notBefore,omitempty"`
	NotAfter        *time.Time `json:"notAfter,omitempty"`
	LastHeartbeatAt *time.Time `json:"lastHeartbeatAt,omitempty"`
	LastError       string     `json:"lastError,omitempty"`
	LastErrorAt     *time.Time `json:"lastErrorAt,omitempty"`
	// Schema snapshot bookkeeping (Database Explorer): the last fingerprint collected and when, and
	// the last one the Control Plane accepted.
	SchemaAttemptFingerprint   string     `json:"schemaAttemptFingerprint,omitempty"`
	SchemaAttemptAt            *time.Time `json:"schemaAttemptAt,omitempty"`
	SchemaDeliveredFingerprint string     `json:"schemaDeliveredFingerprint,omitempty"`
	// Remote commands (Module 13): the Control Plane's command-signing key pinned at enrollment and the
	// IDs of commands already handled (never executed twice).
	// Decommissioning (Module 15): when the Control Plane retired this identity, and the hand-over request the
	// worker still has to acknowledge (consumed once answered).
	DecommissionedAt   *time.Time `json:"decommissionedAt,omitempty"`
	DecommissionNotice string     `json:"decommissionNotice,omitempty"`
	CommandKeyID       string     `json:"commandKeyId,omitempty"`
	CommandPublicKey   string     `json:"commandPublicKey,omitempty"`
	ExecutedCommands   []string   `json:"executedCommands,omitempty"`
}

// GatewayError is a refusal from the agent gateway (error code + message).
type GatewayError struct {
	Status  int
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *GatewayError) Error() string {
	return fmt.Sprintf("gateway refused (%d %s): %s", e.Status, e.Code, e.Message)
}

// Terminal enrollment errors: retrying with the same package cannot succeed.
func (e *GatewayError) Terminal() bool {
	switch e.Code {
	case "invalid-token", "token-expired", "token-revoked", "token-used", "identity-mismatch", "already-enrolled", "duplicate-installation", "not-enrollable", "csr-subject", "csr-key", "deployment-decommissioned":
		return true
	}
	return false
}

func (a *Agent) path(name string) string { return filepath.Join(a.StateDir, name) }

func (a *Agent) LoadState() State {
	var s State
	b, err := os.ReadFile(a.path("state.json"))
	if err != nil || json.Unmarshal(b, &s) != nil || s.State == "" {
		return State{State: "pending"}
	}
	return s
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *Agent) SaveState(s State) error {
	if err := os.MkdirAll(a.StateDir, 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return writeAtomic(a.path("state.json"), b, 0o600)
}

func newKeyAndCSR(installationID string) (keyPEM, csrPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: installationID}}, key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}), nil
}

// pinnedPool trusts only the platform CA from the package — never the system roots.
func pinnedPool(caPEM string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(caPEM)) {
		return nil, errors.New("the package does not contain a valid platform CA certificate")
	}
	return pool, nil
}

func caFingerprint(caPEM string) string {
	b, _ := pem.Decode([]byte(caPEM))
	if b == nil {
		return ""
	}
	s := sha256.Sum256(b.Bytes)
	return hex.EncodeToString(s[:])
}

func (a *Agent) client(caPEM string, cert *tls.Certificate) (*http.Client, error) {
	pool, err := pinnedPool(caPEM)
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	if cert != nil {
		cfg.Certificates = []tls.Certificate{*cert}
	}
	tr := &http.Transport{TLSClientConfig: cfg, Proxy: http.ProxyFromEnvironment, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second}
	return &http.Client{Transport: tr, Timeout: 30 * time.Second}, nil
}

func (a *Agent) post(ctx context.Context, c *http.Client, gateway, path string, body any, out any) error {
	b, _ := json.Marshal(body)
	u, err := url.JoinPath(gateway, path)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		ge := &GatewayError{Status: res.StatusCode}
		_ = json.Unmarshal(data, ge)
		if ge.Code == "" {
			ge.Code = fmt.Sprintf("http-%d", res.StatusCode)
		}
		return ge
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Enroll exchanges the single-use token for a machine certificate.
func (a *Agent) Enroll(ctx context.Context) error {
	en, err := config.LoadEnrollment(a.EnrollmentPath)
	if err != nil {
		return err
	}
	if en.CACertificate == "" {
		return &GatewayError{Code: "package-too-old", Message: "This package has no platform CA certificate. Generate a new package in the dashboard."}
	}
	if fp := caFingerprint(en.CACertificate); en.CAFingerprint != "" && fp != en.CAFingerprint {
		return &GatewayError{Code: "ca-mismatch", Message: "The CA certificate in the package does not match its fingerprint."}
	}
	if time.Now().After(en.ExpiresAt) {
		return &GatewayError{Code: "token-expired", Message: "The enrollment token in this package has expired. Generate a new package in the dashboard."}
	}
	keyPEM, csrPEM, err := newKeyAndCSR(en.InstallationID)
	if err != nil {
		return err
	}
	c, err := a.client(en.CACertificate, nil)
	if err != nil {
		return err
	}
	var resp struct {
		Certificate       string          `json:"certificate"`
		CACertificate     string          `json:"caCertificate"`
		Serial            string          `json:"serial"`
		NotAfter          time.Time       `json:"notAfter"`
		CommandSigningKey *SigningKey     `json:"commandSigningKey"`
		License           *licenseRenewal `json:"license"`
	}
	if err := a.post(ctx, c, en.AgentGatewayURL, "/agent/v1/enroll", map[string]string{
		"token": en.Token, "deploymentId": en.DeploymentID, "installationId": en.InstallationID, "csr": string(csrPEM), "agentVersion": a.Version,
	}, &resp); err != nil {
		return err
	}
	if caFingerprint(resp.CACertificate) != caFingerprint(en.CACertificate) {
		return errors.New("the gateway returned a different CA than the package pins")
	}
	if err := os.MkdirAll(a.StateDir, 0o700); err != nil {
		return err
	}
	if err := writeAtomic(a.path("agent.key"), keyPEM, 0o600); err != nil {
		return err
	}
	if err := writeAtomic(a.path("agent.crt"), []byte(resp.Certificate), 0o644); err != nil {
		return err
	}
	if err := writeAtomic(a.path("ca.pem"), []byte(en.CACertificate), 0o644); err != nil {
		return err
	}
	cert, err := a.certificate()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	nb, na := cert.Leaf.NotBefore, cert.Leaf.NotAfter
	st := State{State: "enrolled", DeploymentID: en.DeploymentID, InstallationID: en.InstallationID, Serial: resp.Serial, EnrolledAt: &now, NotBefore: &nb, NotAfter: &na, LastHeartbeatAt: &now}
	a.pinKey(&st, resp.CommandSigningKey)
	a.storeLicense(resp.License, "enrollment")
	return a.SaveState(st)
}

func (a *Agent) certificate() (*tls.Certificate, error) {
	c, err := tls.LoadX509KeyPair(a.path("agent.crt"), a.path("agent.key"))
	if err != nil {
		return nil, err
	}
	if c.Leaf == nil && len(c.Certificate) > 0 {
		c.Leaf, err = x509.ParseCertificate(c.Certificate[0])
	}
	return &c, err
}

func (a *Agent) gatewayURL() string {
	if en, err := config.LoadEnrollment(a.EnrollmentPath); err == nil && en.AgentGatewayURL != "" {
		return en.AgentGatewayURL
	}
	return a.Cfg.ControlPlane.AgentGatewayURL
}

func (a *Agent) mtlsClient() (*http.Client, error) {
	ca, err := os.ReadFile(a.path("ca.pem"))
	if err != nil {
		return nil, err
	}
	cert, err := a.certificate()
	if err != nil {
		return nil, err
	}
	return a.client(string(ca), cert)
}

// Heartbeat proves liveness with the machine certificate.
// Heartbeat reports liveness and returns the gateway's answer, which may carry signed remote commands.
func (a *Agent) Heartbeat(ctx context.Context) (heartbeatResponse, error) {
	var resp heartbeatResponse
	c, err := a.mtlsClient()
	if err != nil {
		return resp, err
	}
	err = a.post(ctx, c, a.gatewayURL(), "/agent/v1/heartbeat", map[string]any{"agentVersion": a.Version, "observedAt": time.Now().UTC().Format(time.RFC3339Nano)}, &resp)
	return resp, err
}

// NeedsRenewal is true after two thirds of the certificate's lifetime.
func NeedsRenewal(s State, now time.Time) bool {
	if s.NotBefore == nil || s.NotAfter == nil {
		return false
	}
	life := s.NotAfter.Sub(*s.NotBefore)
	return now.After(s.NotBefore.Add(life * 2 / 3))
}

// Renew obtains a new certificate for the same installation, authenticated by the current one.
func (a *Agent) Renew(ctx context.Context) error {
	s := a.LoadState()
	if s.State != "enrolled" {
		return errors.New("not enrolled")
	}
	keyPEM, csrPEM, err := newKeyAndCSR(s.InstallationID)
	if err != nil {
		return err
	}
	c, err := a.mtlsClient()
	if err != nil {
		return err
	}
	var resp struct {
		Certificate string `json:"certificate"`
		Serial      string `json:"serial"`
	}
	if err := a.post(ctx, c, a.gatewayURL(), "/agent/v1/renew", map[string]string{"csr": string(csrPEM)}, &resp); err != nil {
		return err
	}
	// Replace key and certificate together (the old certificate is already retired by the gateway).
	if err := writeAtomic(a.path("agent.key.next"), keyPEM, 0o600); err != nil {
		return err
	}
	if err := writeAtomic(a.path("agent.crt"), []byte(resp.Certificate), 0o644); err != nil {
		return err
	}
	if err := os.Rename(a.path("agent.key.next"), a.path("agent.key")); err != nil {
		return err
	}
	cert, err := a.certificate()
	if err != nil {
		return err
	}
	nb, na := cert.Leaf.NotBefore, cert.Leaf.NotAfter
	s.Serial, s.NotBefore, s.NotAfter = resp.Serial, &nb, &na
	return a.SaveState(s)
}

// onGatewayError records an error; certificate refusals end the machine identity.
func (a *Agent) onGatewayError(s State, err error) State {
	now := time.Now().UTC()
	s.LastError, s.LastErrorAt = redactErr(err), &now
	var ge *GatewayError
	if errors.As(err, &ge) {
		switch {
		case s.State == "enrolled" && ge.Code == "decommissioned":
			// Module 15: the Control Plane retired this identity for good (authenticated answer over the pinned CA).
			s.State, s.DecommissionedAt = "decommissioned", &now
		case s.State == "enrolled" && (ge.Code == "revoked" || ge.Code == "superseded" || ge.Code == "expired" || ge.Code == "unknown" || ge.Code == "certificate-required"):
			s.State = "revoked"
		case s.State != "enrolled" && ge.Terminal():
			s.State = "failed"
		}
	}
	return s
}

func redactErr(err error) string {
	m := err.Error()
	if i := strings.Index(m, "psacc_enr_"); i >= 0 {
		m = m[:i] + "psacc_enr_[REDACTED]"
	}
	if len(m) > 300 {
		m = m[:300]
	}
	return m
}
