package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"psacc.local/edge/internal/remote"
)

// commandSigner is the Control Plane's command key as the tests need it.
type commandSigner struct {
	pub   ed25519.PublicKey
	priv  ed25519.PrivateKey
	pem   string
	keyID string
}

func newSigner(t *testing.T) *commandSigner {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	p := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	_, id, err := parsePublicKey(p)
	if err != nil {
		t.Fatal(err)
	}
	return &commandSigner{pub: pub, priv: priv, pem: p, keyID: id}
}

func (s *commandSigner) command(typ, deploymentID, installationID string, params map[string]any, ttl time.Duration) SignedCommand {
	c := SignedCommand{ID: newID(), Type: typ, DeploymentID: deploymentID, InstallationID: installationID, Params: params,
		IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpiresAt: time.Now().UTC().Add(ttl).Format(time.RFC3339Nano), KeyID: s.keyID}
	if c.Params == nil {
		c.Params = map[string]any{}
	}
	msg, _ := canonical(c)
	c.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(s.priv, msg))
	return c
}

// commandGateway extends the fake gateway: heartbeats carry queued commands, results are recorded.
type commandGateway struct {
	*fakeGateway
	signer   *commandSigner
	mu       sync.Mutex
	queue    []SignedCommand
	results  []commandResult
	offerKey bool
}

func newCommandGateway(t *testing.T) *commandGateway {
	t.Helper()
	g := &commandGateway{fakeGateway: newFakeGateway(t), signer: newSigner(t), offerKey: true}
	g.srv.Config.Handler = http.HandlerFunc(g.handleCommands)
	return g
}

func (g *commandGateway) handleCommands(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/agent/v1/enroll":
		// Reuse the base enrollment, then append the signing key the way the real gateway does.
		rec := &recorder{header: http.Header{}}
		g.fakeGateway.handle(rec, r)
		var body map[string]any
		_ = json.Unmarshal(rec.body, &body)
		if rec.status == 201 && g.offerKey {
			body["commandSigningKey"] = map[string]string{"keyId": g.signer.keyID, "publicKeyPem": g.signer.pem}
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(rec.status)
		_ = json.NewEncoder(w).Encode(body)
	case "/agent/v1/heartbeat":
		if len(r.TLS.PeerCertificates) == 0 {
			w.WriteHeader(401)
			return
		}
		g.heartbeats.Add(1)
		g.mu.Lock()
		cmds := g.queue
		g.queue = nil
		g.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "commands": cmds, "commandSigningKey": map[string]string{"keyId": g.signer.keyID, "publicKeyPem": g.signer.pem}})
	case "/agent/v1/command-results":
		if len(r.TLS.PeerCertificates) == 0 {
			w.WriteHeader(401)
			return
		}
		var res commandResult
		_ = json.NewDecoder(r.Body).Decode(&res)
		g.mu.Lock()
		g.results = append(g.results, res)
		g.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	default:
		g.fakeGateway.handle(w, r)
	}
}

func (g *commandGateway) enqueue(c SignedCommand) {
	g.mu.Lock()
	g.queue = append(g.queue, c)
	g.mu.Unlock()
}

func (g *commandGateway) resultFor(id string) *commandResult {
	g.mu.Lock()
	defer g.mu.Unlock()
	for i := len(g.results) - 1; i >= 0; i-- { // the latest answer for a command (an upgrade is first staged, then reported)
		if g.results[i].CommandID == id {
			return &g.results[i]
		}
	}
	return nil
}

type recorder struct {
	header http.Header
	status int
	body   []byte
}

func (r *recorder) Header() http.Header         { return r.header }
func (r *recorder) Write(b []byte) (int, error) { r.body = append(r.body, b...); return len(b), nil }
func (r *recorder) WriteHeader(s int)           { r.status = s }

func enrolledCommandAgent(t *testing.T) (*commandGateway, *Agent) {
	t.Helper()
	g := newCommandGateway(t)
	a := agentFor(t, g.fakeGateway, g.caPEM)
	a.RemoteDir = filepath.Join(t.TempDir(), "remote")
	a.Cfg.Image.Repository = "psacc/psa-edge"
	a.step(context.Background(), time.Minute, 0) // enrolls
	s := a.LoadState()
	if s.State != "enrolled" || s.CommandKeyID != g.signer.keyID || s.CommandPublicKey == "" {
		t.Fatalf("the signing key must be pinned at enrollment: %+v", s)
	}
	return g, a
}

const depID, instID = "11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444"

func TestCanonicalFormMatchesTheContract(t *testing.T) {
	c := SignedCommand{ID: "id", Type: "restart_service", DeploymentID: "d", InstallationID: "i", Params: map[string]any{"service": "edge-api", "b": 1.0, "a": true, "n": nil, "h": "<&>"},
		IssuedAt: "2026-10-15T10:00:00.000Z", ExpiresAt: "2026-10-15T11:00:00.000Z", KeyID: "0123456789abcdef"}
	got, err := canonical(c)
	if err != nil {
		t.Fatal(err)
	}
	// Exactly what JSON.stringify produces in @psacc/contracts canonicalCommand(): fixed key order, params sorted, no spaces, no HTML escaping.
	want := `{"id":"id","type":"restart_service","deploymentId":"d","installationId":"i","params":{"a":true,"b":1,"h":"<&>","n":null,"service":"edge-api"},"issuedAt":"2026-10-15T10:00:00.000Z","expiresAt":"2026-10-15T11:00:00.000Z","keyId":"0123456789abcdef"}`
	if string(got) != want {
		t.Fatalf("canonical form differs:\n got %s\nwant %s", got, want)
	}
}

func TestVerifyRefusesForgedForeignExpiredAndUnknownCommands(t *testing.T) {
	s := newSigner(t)
	other := newSigner(t)
	now := time.Now()
	good := s.command("refresh_health", depID, instID, nil, time.Hour)
	if code := Verify(good, s.pem, s.keyID, depID, instID, now); code != "" {
		t.Fatalf("a valid command must verify, got %q", code)
	}
	cases := map[string]struct {
		c    SignedCommand
		pem  string
		kid  string
		want string
	}{
		"other key":      {other.command("refresh_health", depID, instID, nil, time.Hour), s.pem, s.keyID, "unknown_key"},
		"tampered":       {func() SignedCommand { c := good; c.Params = map[string]any{"x": 1}; return c }(), s.pem, s.keyID, "bad_signature"},
		"foreign target": {s.command("refresh_health", "other-dep", instID, nil, time.Hour), s.pem, s.keyID, "target_mismatch"},
		"expired":        {s.command("refresh_health", depID, instID, nil, -time.Minute), s.pem, s.keyID, "expired"},
		"unknown type":   {s.command("wipe_disk", depID, instID, nil, time.Hour), s.pem, s.keyID, "type_not_allowed"},
		"bad signature": {func() SignedCommand {
			c := good
			c.Signature = base64.StdEncoding.EncodeToString(make([]byte, 64))
			return c
		}(), s.pem, s.keyID, "bad_signature"},
	}
	for name, tc := range cases {
		if code := Verify(tc.c, tc.pem, tc.kid, depID, instID, now); code != tc.want {
			t.Errorf("%s: got %q want %q", name, code, tc.want)
		}
	}
}

func TestCommandsAreVerifiedExecutedOnceAndAnswered(t *testing.T) {
	g, a := enrolledCommandAgent(t)
	ctx := context.Background()
	refresh := g.signer.command("refresh_health", depID, instID, nil, time.Hour)
	forged := newSigner(t).command("refresh_health", depID, instID, nil, time.Hour)
	g.enqueue(refresh)
	g.enqueue(forged)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(refresh.ID); r == nil || r.Status != "succeeded" || r.Code != "reports_delivered" || r.AgentVersion != "0.1.0" {
		t.Fatalf("refresh_health result: %+v", r)
	}
	if r := g.resultFor(forged.ID); r == nil || r.Status != "failed" || r.Code != "unknown_key" {
		t.Fatalf("a forged command must be refused and reported: %+v", r)
	}
	// Re-delivery of the same command (e.g. the gateway did not see the result yet) must not run it again.
	before := g.reports.Load()
	g.enqueue(refresh)
	a.step(ctx, time.Minute, 0)
	if n := len(g.results); n != 2 {
		t.Fatalf("a command must be answered once, got %d results", n)
	}
	_ = before
	recs := remote.ReadStatus(a.remoteDir())
	if len(recs) != 2 || !recs[0].Reported || !recs[1].Reported {
		t.Fatalf("the local admin history must list both commands as reported: %+v", recs)
	}
	if st := a.Status(); st.Commands["signingKeyId"] != g.signer.keyID || st.Commands["resultsWaiting"] != 0 {
		t.Fatalf("status must expose the pinned key and an empty result queue: %+v", st.Commands)
	}
}

func TestRotateAndRestartCommands(t *testing.T) {
	g, a := enrolledCommandAgent(t)
	ctx := context.Background()
	before := a.LoadState().Serial
	rotate := g.signer.command("rotate_certificate", depID, instID, nil, time.Hour)
	g.enqueue(rotate)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(rotate.ID); r == nil || r.Status != "succeeded" || r.Code != "certificate_renewed" {
		t.Fatalf("rotate result: %+v", r)
	}
	if a.LoadState().Serial == before {
		t.Fatal("rotation must install the new certificate")
	}
	restart := g.signer.command("restart_service", depID, instID, map[string]any{"service": "edge-agent"}, time.Hour)
	g.enqueue(restart)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(restart.ID); r == nil || r.Status != "succeeded" || r.Code != "restarting" {
		t.Fatalf("restart result must be reported before exiting: %+v", r)
	}
	if !a.restart {
		t.Fatal("the agent must exit for a restart after reporting")
	}
	unknown := g.signer.command("restart_service", depID, instID, map[string]any{"service": "edge-postgres"}, time.Hour)
	g.enqueue(unknown)
	a.restart = false
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(unknown.ID); r == nil || r.Status != "failed" || r.Code != "unknown_service" {
		t.Fatalf("restarting the database must be refused: %+v", r)
	}
}

func TestCommandsHandedToTheWorkerThroughTheSharedVolume(t *testing.T) {
	g, a := enrolledCommandAgent(t)
	ctx := context.Background()
	RemoteWait = 5 * time.Second
	t.Cleanup(func() { RemoteWait = 90 * time.Second })
	// A fake worker answers test_psa_connection; nothing answers run_sync.
	stop := make(chan struct{})
	go func() {
		ctx, cancel := context.WithCancel(ctx)
		go func() { <-stop; cancel() }()
		_ = remote.Serve(ctx, a.remoteDir(), "edge-worker", 200*time.Millisecond, func(_ context.Context, r remote.Request) (remote.Result, bool) {
			if r.Type == "test_psa_connection" {
				return remote.Result{Status: "succeeded", Code: "ok", Message: "Connection test ok (HTTP 200), 12 ms."}, false
			}
			if r.Type == "suspend" {
				reason, _ := r.Params["reason"].(string)
				return remote.Result{Status: "succeeded", Code: "suspended", Message: "paused: " + reason}, false
			}
			return remote.Result{Status: "failed", Code: "ignored", Message: "x"}, false
		})
	}()
	t.Cleanup(func() { close(stop) })
	test := g.signer.command("test_psa_connection", depID, instID, nil, time.Hour)
	g.enqueue(test)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(test.ID); r == nil || r.Status != "succeeded" || r.Code != "ok" || !strings.Contains(r.Message, "HTTP 200") {
		t.Fatalf("worker-relayed result: %+v", r)
	}
	// Module 14: suspend is relayed to the worker with its reason.
	sus := g.signer.command("suspend", depID, instID, map[string]any{"reason": "Invoice overdue"}, time.Hour)
	g.enqueue(sus)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(sus.ID); r == nil || r.Status != "succeeded" || r.Code != "suspended" || !strings.Contains(r.Message, "Invoice overdue") {
		t.Fatalf("suspend result: %+v", r)
	}
	// A request nobody serves (edge-api down) fails honestly with no_response.
	restart := g.signer.command("restart_service", depID, instID, map[string]any{"service": "edge-api"}, time.Hour)
	g.enqueue(restart)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(restart.ID); r == nil || r.Status != "failed" || r.Code != "no_response" {
		t.Fatalf("an unanswered request must fail with no_response: %+v", r)
	}
}

func TestUpgradeIsStagedVerifiedAndReportedWhenTheNewVersionRuns(t *testing.T) {
	g, a := enrolledCommandAgent(t)
	ctx := context.Background()
	bad := g.signer.command("upgrade", depID, instID, map[string]any{"repository": "evil/image", "version": "9.9.9", "digest": nil}, time.Hour)
	g.enqueue(bad)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(bad.ID); r == nil || r.Status != "failed" || r.Code != "repository_mismatch" {
		t.Fatalf("a foreign repository must be refused: %+v", r)
	}
	same := g.signer.command("upgrade", depID, instID, map[string]any{"repository": "psacc/psa-edge", "version": "0.1.0", "digest": nil}, time.Hour)
	g.enqueue(same)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(same.ID); r == nil || r.Status != "succeeded" || r.Code != "already_running" {
		t.Fatalf("the running version must be reported as already running: %+v", r)
	}
	digest := "sha256:" + strings.Repeat("ab", 32)
	up := g.signer.command("upgrade", depID, instID, map[string]any{"repository": "psacc/psa-edge", "version": "0.2.0", "digest": digest}, time.Hour)
	g.enqueue(up)
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(up.ID); r == nil || r.Status != "staged" || r.Code != "staged" || !strings.Contains(r.Message, "scripts/upgrade.sh") {
		t.Fatalf("upgrade must be staged for the host operator: %+v", r)
	}
	o, err := remote.ReadOrder(a.remoteDir())
	if err != nil || o == nil || o.Image != "psacc/psa-edge:0.2.0@"+digest || o.CommandID != up.ID || o.FromVersion != "0.1.0" {
		t.Fatalf("staged order: %+v %v", o, err)
	}
	if st := a.Status(); st.Commands["stagedUpgrade"] == nil {
		t.Fatal("status must expose the staged upgrade")
	}
	// The host operator applied it: the "new" agent starts, sees the order matches its version and reports success.
	a.Version = "0.2.0"
	a.step(ctx, time.Minute, 0)
	if r := g.resultFor(up.ID); r == nil || r.Status != "succeeded" || r.Code != "upgraded" || r.AgentVersion != "0.2.0" {
		t.Fatalf("after the upgrade the agent must report success: %+v", r)
	}
	if o, _ := remote.ReadOrder(a.remoteDir()); o != nil {
		t.Fatal("the order must be cleared once applied")
	}
	// Results survive an outage: queue a result while the gateway is down, deliver it on the next step.
	a.queueResult(commandResult{CommandID: newID(), Status: "succeeded", Code: "x", Message: "m", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), FinishedAt: time.Now().UTC().Format(time.RFC3339Nano), AgentVersion: "0.2.0"})
	if files, _ := filepath.Glob(filepath.Join(a.resultsQueueDir(), "*.json")); len(files) != 1 {
		t.Fatal("result must be queued on disk")
	}
	a.step(ctx, time.Minute, 0)
	if files, _ := filepath.Glob(filepath.Join(a.resultsQueueDir(), "*.json")); len(files) != 0 {
		t.Fatal("queued results must be delivered")
	}
	if b, _ := os.ReadFile(filepath.Join(a.StateDir, "state.json")); strings.Contains(string(b), "PRIVATE KEY") {
		t.Fatal("state must not hold private material")
	}
}

func TestRemoteChannelFiles(t *testing.T) {
	dir := t.TempDir()
	id := newID()
	if err := remote.WriteRequest(dir, remote.Request{ID: "../../etc", Type: "x", Service: "edge-worker"}); err == nil {
		t.Fatal("an invalid id must be refused")
	}
	if err := remote.WriteRequest(dir, remote.Request{ID: id, Type: "run_sync", Service: "edge-worker"}); err != nil {
		t.Fatal(err)
	}
	reqs, _ := remote.Pending(dir, "edge-worker", time.Hour)
	if len(reqs) != 1 || reqs[0].ID != id {
		t.Fatalf("pending: %+v", reqs)
	}
	if other, _ := remote.Pending(dir, "edge-api", time.Hour); len(other) != 0 {
		t.Fatal("requests are addressed to one service")
	}
	if err := remote.WriteResult(dir, remote.Result{ID: id, Status: "succeeded", Code: "ok"}); err != nil {
		t.Fatal(err)
	}
	if reqs, _ := remote.Pending(dir, "edge-worker", time.Hour); len(reqs) != 0 {
		t.Fatal("answered requests are removed")
	}
	r, err := remote.ReadResult(dir, id, true)
	if err != nil || r == nil || r.Code != "ok" {
		t.Fatalf("result: %+v %v", r, err)
	}
	if r, _ := remote.ReadResult(dir, id, true); r != nil {
		t.Fatal("a consumed result is gone")
	}
}

// newID is a random UUID-shaped identifier (the remote channel validates the shape).
func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
