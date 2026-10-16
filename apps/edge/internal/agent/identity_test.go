package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/remote"
)

// fakeGateway is a TLS server signed by a test CA. It signs agent CSRs, checks client certificates
// against that CA, and can be told to refuse with a gateway error code.
type fakeGateway struct {
	srv        *httptest.Server
	caPEM      string
	caKey      *ecdsa.PrivateKey
	ca         *x509.Certificate
	refuse     atomic.Value // string error code for the next heartbeat
	heartbeats atomic.Int32
	enrolls    atomic.Int32
	reports    atomic.Int32
	lastBatch  atomic.Value // []byte of the last /reports body
}

func newFakeGateway(t *testing.T) *fakeGateway {
	t.Helper()
	g := &fakeGateway{}
	g.caKey, _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &g.caKey.PublicKey, g.caKey)
	g.ca, _ = x509.ParseCertificate(der)
	g.caPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	srvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	stmpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "gateway"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	sder, _ := x509.CreateCertificate(rand.Reader, stmpl, g.ca, &srvKey.PublicKey, g.caKey)
	pool := x509.NewCertPool()
	pool.AddCert(g.ca)
	g.srv = httptest.NewUnstartedServer(http.HandlerFunc(g.handle))
	g.srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{sder}, PrivateKey: srvKey}}, ClientCAs: pool, ClientAuth: tls.VerifyClientCertIfGiven}
	g.srv.StartTLS()
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGateway) sign(csrPEM string, life time.Duration) string {
	b, _ := pem.Decode([]byte(csrPEM))
	csr, _ := x509.ParseCertificateRequest(b.Bytes)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: csr.Subject, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(life),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, g.ca, csr.PublicKey, g.caKey)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func (g *fakeGateway) handle(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if r.URL.Path == "/agent/v1/reports" {
		var batch map[string]any
		_ = json.NewDecoder(r.Body).Decode(&batch)
		raw, _ := json.Marshal(batch)
		g.lastBatch.Store(raw)
		g.reports.Add(1)
		w.Header().Set("content-type", "application/json")
		if len(r.TLS.PeerCertificates) == 0 {
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"accepted": len(batch), "rejected": []any{}, "healthState": "unknown"})
		return
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	w.Header().Set("content-type", "application/json")
	switch r.URL.Path {
	case "/agent/v1/enroll":
		g.enrolls.Add(1)
		if code, _ := g.refuse.Load().(string); code != "" {
			w.WriteHeader(409)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": "refused"})
			return
		}
		b, _ := pem.Decode([]byte(in["csr"]))
		csr, err := x509.ParseCertificateRequest(b.Bytes)
		if err != nil || csr.CheckSignature() != nil || csr.Subject.CommonName != in["installationId"] || !strings.HasPrefix(in["token"], "psacc_enr_") {
			w.WriteHeader(400)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid-csr"})
			return
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]any{"certificate": g.sign(in["csr"], 90*time.Minute), "caCertificate": g.caPEM, "serial": "0123456789abcdef0123456789abcdef", "notAfter": time.Now().Add(90 * time.Minute)})
	case "/agent/v1/heartbeat", "/agent/v1/renew":
		if len(r.TLS.PeerCertificates) == 0 {
			w.WriteHeader(401)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "certificate-required"})
			return
		}
		if code, _ := g.refuse.Load().(string); code != "" {
			w.WriteHeader(403)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
			return
		}
		if r.URL.Path == "/agent/v1/renew" {
			_ = json.NewEncoder(w).Encode(map[string]any{"certificate": g.sign(in["csr"], 90*time.Minute), "serial": "fedcba9876543210fedcba9876543210"})
			return
		}
		g.heartbeats.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}

func agentFor(t *testing.T, g *fakeGateway, caPEM string) *Agent {
	t.Helper()
	dir := t.TempDir()
	cfg := &config.Edge{}
	cfg.Deployment.Code = "DEP-00042"
	en := map[string]any{"schemaVersion": 1, "deploymentId": "11111111-1111-4111-8111-111111111111", "deploymentCode": "DEP-00042",
		"installationId": "44444444-4444-4444-8444-444444444444", "agentGatewayUrl": g.srv.URL, "caCertificate": caPEM, "caFingerprint": caFingerprint(caPEM),
		"token": "psacc_enr_" + strings.Repeat("A", 43), "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)}
	b, _ := json.Marshal(en)
	p := filepath.Join(dir, "enrollment.json")
	_ = os.WriteFile(p, b, 0o600)
	return &Agent{Cfg: cfg, EnrollmentPath: p, OutboxDir: filepath.Join(dir, "outbox"), StateDir: filepath.Join(dir, "state"), Version: "0.1.0", Log: slog.New(slog.DiscardHandler)}
}

func TestEnrollHeartbeatRenewAndRevocation(t *testing.T) {
	g := newFakeGateway(t)
	a := agentFor(t, g, g.caPEM)
	ctx := context.Background()

	a.step(ctx, time.Minute, 0) // enrolls
	s := a.LoadState()
	if s.State != "enrolled" || s.InstallationID != "44444444-4444-4444-8444-444444444444" || s.NotAfter == nil {
		t.Fatalf("not enrolled: %+v", s)
	}
	if info, _ := os.Stat(a.path("agent.key")); info.Mode().Perm() != 0o600 {
		t.Fatalf("private key mode %v", info.Mode().Perm())
	}
	if !a.Status().Enrolled {
		t.Fatal("status should report enrolled")
	}
	a.step(ctx, time.Minute, 0) // heartbeat over mTLS, then the outbox is delivered
	if g.heartbeats.Load() != 1 || g.enrolls.Load() != 1 || g.reports.Load() < 1 {
		t.Fatalf("heartbeats=%d enrolls=%d reports=%d", g.heartbeats.Load(), g.enrolls.Load(), g.reports.Load())
	}
	if left, _ := filepath.Glob(filepath.Join(a.OutboxDir, "report-*.json")); len(left) != 0 {
		t.Fatalf("outbox not drained after delivery: %d files", len(left))
	}
	batch := string(g.lastBatch.Load().([]byte))
	for _, want := range []string{`"type":"database"`, `"type":"host_resources"`, `"type":"containers"`, `"type":"versions"`, `"type":"certificates_security"`} {
		if !strings.Contains(batch, want) {
			t.Errorf("delivered batch lacks %s", want)
		}
	}
	if strings.Contains(batch, "psacc_enr_") || strings.Contains(batch, "PRIVATE KEY") {
		t.Fatal("a report batch must never carry the token or key")
	}
	before := s.Serial
	if err := a.Renew(ctx); err != nil {
		t.Fatal(err)
	}
	if a.LoadState().Serial == before {
		t.Fatal("renewal must store the new certificate")
	}
	g.refuse.Store("revoked")
	a.step(ctx, time.Minute, 0)
	if st := a.Status(); st.Enrolled || st.State != "revoked" || !strings.Contains(st.Detail, "Re-enroll") {
		t.Fatalf("revocation not honoured: %+v", st)
	}
	g.refuse.Store("")
	a.step(ctx, time.Minute, 0)
	if g.heartbeats.Load() != 1 {
		t.Fatal("a revoked agent must stop sending heartbeats")
	}
}

func TestTerminalAndRetryableEnrollmentErrors(t *testing.T) {
	g := newFakeGateway(t)
	g.refuse.Store("token-used")
	a := agentFor(t, g, g.caPEM)
	a.step(context.Background(), time.Minute, 0)
	if st := a.Status(); st.State != "failed" || !strings.Contains(st.LastError, "token-used") {
		t.Fatalf("a used token must stop enrollment: %+v", st)
	}
	// Network failure (gateway down) is retryable: still pending, with backoff.
	g2 := newFakeGateway(t)
	b := agentFor(t, g2, g2.caPEM)
	g2.srv.Close()
	if next := b.step(context.Background(), time.Minute, 0); next != 5*time.Second || b.LoadState().State != "pending" {
		t.Fatalf("retryable failure: next=%v state=%s", next, b.LoadState().State)
	}
}

func TestTheGatewayMustPresentACertificateFromThePinnedCA(t *testing.T) {
	g := newFakeGateway(t)
	other := newFakeGateway(t) // a different CA
	a := agentFor(t, g, other.caPEM)
	a.step(context.Background(), time.Minute, 0)
	if st := a.LoadState(); st.State != "pending" || !strings.Contains(st.LastError, "certificate") {
		t.Fatalf("an unpinned gateway must be refused: %+v", st)
	}
	if g.enrolls.Load() != 0 {
		t.Fatal("no request may reach an untrusted gateway")
	}
}

func TestRenewalIsDueAfterTwoThirdsOfTheLifetime(t *testing.T) {
	nb := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	na := nb.Add(90 * 24 * time.Hour)
	s := State{NotBefore: &nb, NotAfter: &na}
	if NeedsRenewal(s, nb.Add(59*24*time.Hour)) || !NeedsRenewal(s, nb.Add(61*24*time.Hour)) {
		t.Fatal("renewal threshold is wrong")
	}
}

// Module 15: a `decommissioned` answer (authenticated over the pinned CA) ends the identity for good — the
// agent stops heartbeats and reports, hands the fact to the worker through the shared volume, and says so.
func TestDecommissionedAnswerRetiresTheIdentityAndTellsTheWorker(t *testing.T) {
	g := newFakeGateway(t)
	a := agentFor(t, g, g.caPEM)
	a.RemoteDir = filepath.Join(t.TempDir(), "remote")
	ctx := context.Background()
	a.step(ctx, time.Minute, 0) // enrolls
	a.step(ctx, time.Minute, 0) // heartbeats once
	if a.LoadState().State != "enrolled" || g.heartbeats.Load() != 1 {
		t.Fatalf("precondition: state=%s heartbeats=%d", a.LoadState().State, g.heartbeats.Load())
	}
	g.refuse.Store("decommissioned")
	a.step(ctx, time.Minute, 0)
	st := a.Status()
	if st.Enrolled || st.State != "decommissioned" || st.DecommissionedAt == nil || !strings.Contains(st.Detail, "scripts/uninstall.sh") {
		t.Fatalf("decommissioning not honoured: %+v", st)
	}
	reqs, err := remote.Pending(a.RemoteDir, "edge-worker", 0)
	if err != nil || len(reqs) != 1 || reqs[0].Type != "decommission" || reqs[0].ID != a.LoadState().DecommissionNotice {
		t.Fatalf("the worker must receive one decommission hand-over: %+v (%v)", reqs, err)
	}
	// Nothing is sent any more, even when the gateway would accept again; the worker's answer is consumed.
	g.refuse.Store("")
	reports := g.reports.Load()
	if err := remote.WriteResult(a.RemoteDir, remote.Result{ID: reqs[0].ID, Service: "edge-worker", Status: "succeeded", Code: "decommissioned"}); err != nil {
		t.Fatal(err)
	}
	a.step(ctx, time.Minute, 0)
	a.step(ctx, time.Minute, 0)
	if g.heartbeats.Load() != 1 || g.reports.Load() != reports {
		t.Fatalf("a decommissioned agent must not contact the gateway: heartbeats=%d reports=%d", g.heartbeats.Load(), g.reports.Load())
	}
	if s := a.LoadState(); s.State != "decommissioned" || s.DecommissionNotice != "" {
		t.Fatalf("state after acknowledgement: %+v", s)
	}
	// A plain revocation still means "re-enroll", not "decommissioned".
	g2 := newFakeGateway(t)
	b := agentFor(t, g2, g2.caPEM)
	b.step(ctx, time.Minute, 0)
	g2.refuse.Store("revoked")
	b.step(ctx, time.Minute, 0)
	if b.Status().State != "revoked" {
		t.Fatalf("revocation must stay distinct: %+v", b.Status())
	}
}
