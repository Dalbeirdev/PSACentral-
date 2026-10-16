package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"psacc.local/edge/internal/config"
)

func newAgent(t *testing.T, expires time.Time) *Agent {
	t.Helper()
	dir := t.TempDir()
	cfg := &config.Edge{}
	cfg.Deployment.ID, cfg.Deployment.InstallationID, cfg.Deployment.Code = "dep-id", "inst-id", "DEP-00042"
	cfg.ControlPlane.AgentGatewayURL = "https://gateway.example.test"
	en := map[string]any{"schemaVersion": 1, "deploymentId": "dep-id", "deploymentCode": "DEP-00042", "installationId": "inst-id",
		"agentGatewayUrl": "https://gateway.example.test", "token": "psacc_enr_secretvalue", "expiresAt": expires.Format(time.RFC3339)}
	b, _ := json.Marshal(en)
	p := filepath.Join(dir, "enrollment.json")
	_ = os.WriteFile(p, b, 0o600)
	return &Agent{Cfg: cfg, EnrollmentPath: p, OutboxDir: filepath.Join(dir, "outbox"), StateDir: filepath.Join(dir, "state"), Version: "test", Log: slog.New(slog.NewTextHandler(os.Stderr, nil))}
}

func TestStatusIsHonestlyNotEnrolled(t *testing.T) {
	a := newAgent(t, time.Now().Add(time.Hour))
	st := a.Status()
	if st.Enrolled || st.State != "pending" || st.TokenExpired || !strings.Contains(st.Detail, "Not enrolled") {
		t.Fatalf("unexpected status %+v", st)
	}
	expired := newAgent(t, time.Now().Add(-time.Hour)).Status()
	if !expired.TokenExpired || !strings.Contains(expired.Detail, "expired") {
		t.Fatalf("expired token not reported: %+v", expired)
	}
}

func TestReportsAreBufferedBoundedAndContainNoSecrets(t *testing.T) {
	a := newAgent(t, time.Now().Add(time.Hour))
	for i := 0; i < outboxLimit+5; i++ {
		items := a.CollectAll(context.Background()) // no database pool: reported as unavailable
		for k := range items {
			items[k].ObservedAt = items[k].ObservedAt.Add(time.Duration(i) * time.Millisecond)
		}
		name, err := a.Store(items)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(name)
		if strings.Contains(string(b), "psacc_enr_") {
			t.Fatal("the enrollment token must never be part of a report")
		}
		if !strings.Contains(string(b), `"database_unavailable"`) {
			t.Fatal("an unavailable database must be reported as such")
		}
	}
	files, _ := filepath.Glob(filepath.Join(a.OutboxDir, "report-*.json"))
	if len(files) != outboxLimit {
		t.Fatalf("outbox holds %d reports, want %d", len(files), outboxLimit)
	}
	if st := a.Status(); st.BufferedReports != outboxLimit || st.LastReportAt == nil {
		t.Fatalf("status: %+v", st)
	}
}
