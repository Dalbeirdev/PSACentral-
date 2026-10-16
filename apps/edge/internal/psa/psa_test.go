package psa

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakePSA records the last request and answers according to the handler. TLS with a self-signed
// certificate, like an on-premise PSA with a private CA.
type fakePSA struct {
	srv  *httptest.Server
	last *http.Request
	body string
}

func newFake(t *testing.T, h func(w http.ResponseWriter, r *http.Request, f *fakePSA)) *fakePSA {
	t.Helper()
	f := &fakePSA{}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.last = r.Clone(context.Background())
		b := make([]byte, 4096)
		n, _ := r.Body.Read(b)
		f.body = string(b[:n])
		h(w, r, f)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakePSA) caPEM() string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.srv.Certificate().Raw}))
}

func conn(f *fakePSA, provider, auth, endpointPath string, cfg map[string]any, creds map[string]string) *Conn {
	return &Conn{Provider: provider, AuthMethod: auth, Endpoint: f.srv.URL + endpointPath, Config: cfg, Credentials: creds, CACertPEM: f.caPEM(), Timeout: 5 * time.Second}
}

func jsonOK(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(body))
}

func TestAutotaskSendsTheReferenceHeadersAndQueriesOneCompany(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) {
		if r.Header.Get("ApiIntegrationCode") != "code-1" || r.Header.Get("UserName") != "api@tenant" || r.Header.Get("Secret") != "s3cret-value" {
			w.WriteHeader(401)
			return
		}
		jsonOK(w, `{"items":[{"id":1}],"pageDetails":{"count":1}}`)
	})
	r := Run(context.Background(), conn(f, "autotask", "api_user", "/ATServicesRest", map[string]any{"zone": "custom"}, map[string]string{"username": "api@tenant", "secret": "s3cret-value", "integrationCode": "code-1"}))
	if !r.OK || r.Code != CodeOK || r.HTTPStatus != 200 {
		t.Fatalf("unexpected result: %+v", r)
	}
	if f.last.Method != "POST" || f.last.URL.Path != "/ATServicesRest/V1.0/Companies/query" || !strings.Contains(f.body, `"MaxRecords":1`) {
		t.Fatalf("unexpected request: %s %s %s", f.last.Method, f.last.URL.Path, f.body)
	}
	if r.Identity["api"] != "Autotask REST v1.0" || r.Identity["host"] == "" {
		t.Fatalf("identity: %v", r.Identity)
	}
	if strings.Contains(r.Detail, "s3cret") {
		t.Fatal("secret leaked into the detail")
	}
	bad := Run(context.Background(), conn(f, "autotask", "api_user", "/ATServicesRest", nil, map[string]string{"username": "api@tenant", "secret": "wrong", "integrationCode": "code-1"}))
	if bad.OK || bad.Code != CodeAuthFailed || bad.HTTPStatus != 401 {
		t.Fatalf("expected auth_failed, got %+v", bad)
	}
}

func TestConnectWiseUsesBasicCompanyPlusPublicKeyAndClientID(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) {
		want := "Basic " + base64.StdEncoding.EncodeToString([]byte("acme+pub:priv"))
		if r.Header.Get("Authorization") != want || r.Header.Get("clientId") != "cid" {
			w.WriteHeader(401)
			return
		}
		jsonOK(w, `[{"id":1,"name":"Acme"}]`)
	})
	r := Run(context.Background(), conn(f, "connectwise", "api_member_keys", "/v4_6_release/apis/3.0", map[string]any{"companyId": "acme", "site": "onprem"}, map[string]string{"publicKey": "pub", "privateKey": "priv", "clientId": "cid"}))
	if !r.OK || f.last.URL.Path != "/v4_6_release/apis/3.0/company/companies" || f.last.URL.Query().Get("pageSize") != "1" {
		t.Fatalf("unexpected: %+v %s", r, f.last.URL.String())
	}
	if r.Identity["company"] != "acme" {
		t.Fatalf("identity: %v", r.Identity)
	}
}

func TestOAuthProvidersExchangeATokenThenCallTheAPI(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) {
		switch r.URL.Path {
		case "/auth/token", "/api/token", "/oauth_token.do", "/oauth/token":
			if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" || !strings.Contains(f.body, "client_id=cid") && !strings.Contains(f.body, "username=u") {
				w.WriteHeader(400)
				return
			}
			jsonOK(w, `{"access_token":"tok-123","token_type":"bearer"}`)
		default:
			if r.Header.Get("Authorization") != "Bearer tok-123" {
				w.WriteHeader(401)
				return
			}
			jsonOK(w, `{"result":[]}`)
		}
	})
	cases := []struct {
		provider, auth, path string
		cfg                  map[string]any
		creds                map[string]string
		wantPath             string
	}{
		{"halopsa", "oauth2_client_credentials", "/api", map[string]any{"tenantUrl": f.srv.URL, "scope": "all"}, map[string]string{"clientId": "cid", "clientSecret": "cs"}, "/api/Client"},
		{"kaseya_bms", "username_password", "/api", map[string]any{"tenant": "acme"}, map[string]string{"username": "u", "password": "p"}, "/api/crm/accounts"},
		{"servicenow", "oauth2_password", "/api/now", map[string]any{"instanceUrl": f.srv.URL, "incidentTable": "incident"}, map[string]string{"clientId": "cid", "clientSecret": "cs", "username": "u", "password": "p"}, "/api/now/table/incident"},
		{"custom_rest", "oauth2_client_credentials", "/v1", map[string]any{"tokenUrl": f.srv.URL + "/oauth/token", "healthPath": "/health"}, map[string]string{"clientId": "cid", "clientSecret": "cs"}, "/v1/health"},
	}
	for _, c := range cases {
		r := Run(context.Background(), conn(f, c.provider, c.auth, c.path, c.cfg, c.creds))
		if !r.OK {
			t.Fatalf("%s: %+v", c.provider, r)
		}
		if f.last.URL.Path != c.wantPath {
			t.Fatalf("%s: called %s, want %s", c.provider, f.last.URL.Path, c.wantPath)
		}
	}
}

func TestBasicAuthProvidersAndTheCustomAPIKeyHeader(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) {
		ok := r.Header.Get("Authorization") == "Basic "+base64.StdEncoding.EncodeToString([]byte("key-1:X")) ||
			r.Header.Get("Authorization") == "Basic "+base64.StdEncoding.EncodeToString([]byte("u:p")) ||
			r.Header.Get("X-Custom-Key") == "key-2"
		if !ok {
			w.WriteHeader(401)
			return
		}
		jsonOK(w, `{"tickets":[]}`)
	})
	if r := Run(context.Background(), conn(f, "freshservice", "api_key", "/api/v2", nil, map[string]string{"apiKey": "key-1"})); !r.OK || f.last.URL.Path != "/api/v2/tickets" {
		t.Fatalf("freshservice: %+v", r)
	}
	if r := Run(context.Background(), conn(f, "servicenow", "basic", "/api/now", map[string]any{"incidentTable": "sc_task"}, map[string]string{"username": "u", "password": "p"})); !r.OK || f.last.URL.Path != "/api/now/table/sc_task" {
		t.Fatalf("servicenow basic: %+v", r)
	}
	if r := Run(context.Background(), conn(f, "custom_rest", "api_key", "/api", map[string]any{"apiKeyHeader": "X-Custom-Key", "ticketsPath": "/tickets"}, map[string]string{"apiKey": "key-2"})); !r.OK || f.last.URL.Path != "/api/tickets" {
		t.Fatalf("custom api key: %+v", r)
	}
	if r := Run(context.Background(), conn(f, "custom_rest", "basic", "/api", nil, map[string]string{"username": "u", "password": "p"})); !r.OK {
		t.Fatalf("custom basic: %+v", r)
	}
}

func TestOutcomesAreClassifiedAndNeverLeakCredentials(t *testing.T) {
	status := 200
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) {
		if status == -1 {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html>login page</html>"))
			return
		}
		w.WriteHeader(status)
	})
	creds := map[string]string{"apiKey": "super-secret-key"}
	mk := func() *Conn { return conn(f, "freshservice", "api_key", "/api/v2", nil, creds) }
	for _, c := range []struct {
		status int
		code   string
	}{{403, CodeForbidden}, {404, CodeNotFound}, {429, CodeRateLimited}, {503, CodeServerError}, {302, CodeBadResponse}, {-1, CodeBadResponse}} {
		status = c.status
		r := Run(context.Background(), mk())
		if r.OK || r.Code != c.code {
			t.Fatalf("status %d: got %+v", c.status, r)
		}
		if strings.Contains(r.Detail, "super-secret") {
			t.Fatal("credential leaked")
		}
	}
	// Missing credentials never reach the network.
	r := Run(context.Background(), conn(f, "autotask", "api_user", "/x", nil, map[string]string{"username": "only"}))
	if r.Code != CodeNotConfigured || !strings.Contains(r.Detail, "secret, integrationCode") {
		t.Fatalf("not_configured: %+v", r)
	}
	if r := Run(context.Background(), &Conn{Provider: "jira", Endpoint: "https://x.example"}); r.Code != CodeUnsupported {
		t.Fatalf("unsupported: %+v", r)
	}
	if r := Run(context.Background(), &Conn{Provider: "autotask", Endpoint: "http://plain.example"}); r.Code != CodeInvalidConfig {
		t.Fatalf("http endpoint: %+v", r)
	}
}

func TestTLSWithoutTheCustomCAIsATLSErrorAndUnreachableHostsAreReported(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) { jsonOK(w, `{}`) })
	c := conn(f, "freshservice", "api_key", "/api/v2", nil, map[string]string{"apiKey": "k"})
	c.CACertPEM = "" // self-signed server, system roots only
	if r := Run(context.Background(), c); r.Code != CodeTLSError || !strings.Contains(r.Detail, "CA certificate") {
		t.Fatalf("expected tls_error, got %+v", r)
	}
	bad := conn(f, "freshservice", "api_key", "/api/v2", nil, map[string]string{"apiKey": "k"})
	bad.CACertPEM = "not a certificate"
	if r := Run(context.Background(), bad); r.Code != CodeInvalidConfig {
		t.Fatalf("expected invalid_config for bad PEM, got %+v", r)
	}
	down := &Conn{Provider: "freshservice", AuthMethod: "api_key", Endpoint: "https://127.0.0.1:1/api/v2", Credentials: map[string]string{"apiKey": "k"}, Timeout: 3 * time.Second}
	if r := Run(context.Background(), down); r.Code != CodeUnreachable {
		t.Fatalf("expected endpoint_unreachable, got %+v", r)
	}
}

func TestTimeoutIsReported(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) {
		time.Sleep(1500 * time.Millisecond)
		jsonOK(w, `{}`)
	})
	c := conn(f, "freshservice", "api_key", "/api/v2", nil, map[string]string{"apiKey": "k"})
	c.Timeout = 500 * time.Millisecond
	if r := Run(context.Background(), c); r.Code != CodeTimeout {
		t.Fatalf("expected timeout, got %+v", r)
	}
}

func TestCustomCAIsParsedFromPEM(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, r *http.Request, f *fakePSA) {})
	block, _ := pem.Decode([]byte(f.caPEM()))
	if block == nil {
		t.Fatal("pem")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		t.Fatal(err)
	}
	if _, err := NewHTTPClient(f.caPEM(), time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestTesterAcceptsLocalAdminWorkerAndRemoteRequesters(t *testing.T) {
	for _, by := range []string{"local_admin", "worker", "remote"} {
		if !ValidTester(by) {
			t.Errorf("%s must be a valid requester", by)
		}
	}
	for _, by := range []string{"", "root", "agent", "REMOTE"} {
		if ValidTester(by) {
			t.Errorf("%q must not be a valid requester", by)
		}
	}
	if _, err := (&Tester{}).Test(context.Background(), "root"); err == nil || err.Error() != "invalid tester" {
		t.Fatalf("an unknown requester must be refused before any database access: %v", err)
	}
}
