package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"psacc.local/edge/internal/agent"
	"psacc.local/edge/internal/config"
)

func writeDeletionStatus(t *testing.T, dir string, st agent.DeletionStatus) {
	t.Helper()
	b, _ := json.Marshal(st)
	if err := os.WriteFile(filepath.Join(dir, "status.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// Module 17: the deletion page in each of its states, and the lock-down of every other page once requested.
func TestDeletionPageStatesAndLockDown(t *testing.T) {
	cfg := &config.Edge{}
	cfg.Deployment.Code, cfg.Client.DisplayName = "DEP-00042", "Test Client A"
	dir := t.TempDir()
	s := &Server{Cfg: cfg, Version: "test", Log: slog.New(slog.NewTextHandler(io.Discard, nil)), DeletionDir: dir}
	h, err := s.Handler()
	if err != nil {
		t.Fatal(err)
	}
	se := &session{Username: "localadmin", CSRF: strings.Repeat("c", 40)}
	render := func(se *session) string {
		w := httptest.NewRecorder()
		s.render(w, 200, "deletion.html", viewData{Title: "Deletion", Session: se, Fields: map[string]string{}, Data: s.deletionView()})
		return w.Body.String()
	}
	// 1. Nothing requested: the confirmation form (typed ID, password, acknowledgement) and what happens.
	body := render(se)
	for _, want := range []string{`data-testid="deletion-form"`, `name="confirm"`, `name="password"`, `name="acknowledge"`, "DEP-00042", "PSA work stops at once", "Irreversible"} {
		if !strings.Contains(body, want) {
			t.Fatalf("form must contain %q: %s", want, body[:300])
		}
	}
	now := time.Now().UTC()
	if err := agent.WriteDeletionRequest(dir, agent.DeletionRequest{RequestedAt: now, RequestedBy: "localadmin", Reason: "Contract ended"}); err != nil {
		t.Fatal(err)
	}
	// 2. Requested, the agent not yet there: progress without a session.
	body = render(nil)
	if !strings.Contains(body, `data-testid="deletion-progress"`) || !strings.Contains(body, "waiting for the agent") || strings.Contains(body, `data-testid="deletion-form"`) {
		t.Fatalf("progress page: %s", body[:300])
	}
	// 3. Retrying: attempts and the last error are shown; the page refreshes itself.
	writeDeletionStatus(t, dir, agent.DeletionStatus{Phase: "deregistering", RequestedAt: now, RequestedBy: "localadmin", Attempts: 2, LastAttemptAt: &now, LastError: "dial tcp 10.0.0.1:8443: connection refused"})
	body = render(nil)
	for _, want := range []string{"Deregistering from the Control Plane", "connection refused", "attempt 2", `http-equiv="refresh"`, "not yet"} {
		if !strings.Contains(body, want) {
			t.Fatalf("retrying page must contain %q: %s", want, body[:400])
		}
	}
	// 4. Refused: the administrator may delete locally anyway (signed in), or is asked to sign in.
	writeDeletionStatus(t, dir, agent.DeletionStatus{Phase: "refused", RequestedAt: now, RequestedBy: "localadmin", Attempts: 1, LastError: "revoked: refused"})
	body = render(se)
	if !strings.Contains(body, `data-testid="deletion-refused"`) || !strings.Contains(body, `data-testid="deletion-local-form"`) || !strings.Contains(body, "revoked: refused") || strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("refused page (signed in): %s", body[:400])
	}
	if body = render(nil); strings.Contains(body, `data-testid="deletion-local-form"`) || !strings.Contains(body, "Sign in") {
		t.Fatalf("refused page (anonymous): %s", body[:400])
	}
	// 5. Done: what was deleted here and on the Control Plane, and the one host-side command left.
	audit := "99999999-9999-4999-8999-999999999999"
	writeDeletionStatus(t, dir, agent.DeletionStatus{Phase: "wiped", RequestedAt: now, RequestedBy: "localadmin", Attempts: 1, ControlPlaneNotified: true, DeregisteredAt: &now, WipedAt: &now,
		Deleted: map[string]int64{"helpdesk_tickets": 3, "credential_store": 2}, Remaining: []string{"The Docker containers (uninstall)"}, ControlPlaneDeleted: map[string]int64{"deployments": 1, "reports": 7}, AuditEventID: &audit})
	body = render(nil)
	for _, want := range []string{`data-testid="deletion-done"`, audit, "helpdesk_tickets: 3", "deployments: 1", "scripts/uninstall.sh --wipe --confirm DEP-00042", "The Docker containers (uninstall)", "no <span class=\"mono\">--force</span>"} {
		if !strings.Contains(body, want) {
			t.Fatalf("done page must contain %q: %s", want, body[:400])
		}
	}
	// Lock-down: every other page redirects to /deletion; /deletion itself is readable without a session.
	for _, path := range []string{"/", "/tickets", "/setup", "/login", "/sync", "/api/status"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8480"+path, nil))
		if w.Code != 303 || w.Header().Get("Location") != "/deletion" {
			t.Fatalf("%s must redirect to /deletion once requested: %d %s", path, w.Code, w.Header().Get("Location"))
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8480/deletion", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `data-testid="deletion-done"`) {
		t.Fatalf("the deletion page must be readable without a session: %d", w.Code)
	}
	// The navigation (rendered for a signed-in administrator) offers the page.
	if !strings.Contains(render(se), `href="/deletion"`) {
		t.Fatalf("navigation must link the deletion page")
	}
}
