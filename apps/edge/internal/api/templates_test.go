package api

import (
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/inventory"
	"psacc.local/edge/internal/license"
	"psacc.local/edge/internal/remote"
)

// Every page renders with realistic data; template errors would otherwise only appear at runtime.
func TestTemplatesRender(t *testing.T) {
	cfg := &config.Edge{}
	cfg.Deployment.Code, cfg.Client.DisplayName = "DEP-00042", "Test Client A"
	cfg.PSA.DisplayName, cfg.PSA.Provider = "A — Autotask", "autotask"
	s := &Server{Cfg: cfg, Version: "test", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if _, err := s.Handler(); err != nil {
		t.Fatal(err)
	}
	rows := int64(42)
	now := time.Now()
	se := &session{Username: "localadmin", CSRF: strings.Repeat("c", 40)}
	status := Status{
		Deployment: map[string]string{"code": "DEP-00042", "client": "Test Client A (CL-00027)", "installationId": "inst"},
		Database: inventory.Database{Available: true, ServerVersion: "17.6", SchemaVersion: "0001", MigrationsApplied: 1,
			Tables: []inventory.Table{{Schema: "public", Name: "helpdesk_tickets", EstimatedRows: &rows}, {Schema: "public", Name: "sync_runs"}}},
		PSA:        map[string]any{"instance": "PSA-00030", "provider": "autotask", "credentialsPresent": 1, "credentialFields": 2, "status": "not_configured"},
		Services:   []map[string]any{{"name": "Help Desk", "usesPsa": true, "enabled": true}},
		Backup:     map[string]any{"lastStatus": "none"},
		Enrollment: map[string]any{"enrolled": true, "state": "enrolled", "detail": "Enrolled", "lastHeartbeatAt": "2026-10-14T12:00:00Z"},
		RecentLogs: []map[string]any{{"at": now, "level": "info", "component": "worker", "message": "<script>alert(1)</script>"}},
		// A synchronization has happened: the branch that reads the run details must render too.
		Sync:         map[string]any{"lastStatus": "succeeded", "lastRunAt": now, "itemsReceived": 3, "itemsSent": 1, "itemsFailed": 0, "pendingOutbound": 0},
		Lifecycle:    map[string]any{"suspended": true, "since": "2026-10-15T12:00:00Z", "reason": "Invoice overdue"},
		License:      map[string]any{"code": "LIC-00007", "displayName": "Help Desk Standard", "endsAt": "2027-06-30"},
		LicenseCheck: license.Status{State: "valid", KeySource: "image", PSAWorkAllowed: true, VerifiedAt: "2026-10-16T08:00:00Z", Detail: "License LIC-00007; token valid until 2026-11-15."},
		Remote: map[string]any{"version": "0.1.0", "commands": []remote.CommandRecord{{ID: "c1", Type: "refresh_health", ReceivedAt: now, Status: "succeeded", Code: "reports_delivered", Message: "1 batch", Reported: true}},
			"stagedUpgrade": &remote.UpgradeOrder{CommandID: "c2", Image: "psacc/psa-edge:0.2.0", Version: "0.2.0", ExpiresAt: now}},
	}
	cases := map[string]viewData{
		"setup.html":       {Title: "First-run setup", Error: "Use at least 12 characters."},
		"login.html":       {Title: "Sign in", Fields: map[string]string{"username": "localadmin"}},
		"credentials.html": {Title: "PSA credentials", Session: se, Data: map[string]any{"Rows": []credentialRow{{Key: "secret", Label: "API secret", Secret: true, Set: true, UpdatedAt: &now}}, "Status": "credentials_present"}},
		"tickets.html":     {Title: "Tickets", Session: se, Data: map[string]any{"Tickets": []ticketRow{{ID: "t1", Title: "<b>Printer</b>", Status: "open", Priority: "high", Origin: "psa", SyncState: "synced", CreatedAt: now, UpdatedAt: now}}, "Total": 1, "Page": 1, "PageSize": 50, "HasMore": false, "Status": "", "Query": "", "Sync": "", "Counts": map[string]int{"open": 1}, "Statuses": []string{"new", "open"}, "Saved": ""}},
		"ticket.html":      {Title: "Ticket", Session: se, Data: map[string]any{"T": &ticketRow{ID: "t1", Title: "Printer", Status: "open", Priority: "high", Origin: "psa", SyncState: "pending_push", CreatedAt: now, UpdatedAt: now}, "Events": []ticketEvent{{ID: "e1", Type: "note_added", Source: "portal", Payload: map[string]any{"text": "hello <script>"}, At: now, PushedAt: &now}}, "Statuses": []string{"new", "open"}, "Saved": "note", "Provider": "autotask"}},
		"ticket-new.html":  {Title: "New ticket", Session: se, Fields: map[string]string{}, Data: map[string]any{"Priorities": []string{"low", "normal"}, "CanCreateInPSA": false, "Provider": "autotask"}},
		"sync.html":        {Title: "Synchronization", Session: se, Data: map[string]any{"Runs": []syncRunRow{{ID: "r1", Trigger: "manual", Status: "partial", StartedAt: now, ItemsReceived: 3, Pages: 1}}, "Pending": 1, "Conflicts24h": 0, "LocalOnly": 0, "PushFailed": 0, "LastSucceededAt": &now, "Watermark": &now, "Runs24h": 2, "Failed24h": 0, "Requested": (*string)(nil), "ConnectionStatus": "verified", "Supported": true, "Provider": "autotask", "Interval": "5m0s"}},
		"dashboard.html":   {Title: "Appliance status", Session: se, Data: status},
		"removal.html":     {Title: "Removal", Session: se, Data: map[string]any{"Code": "DEP-00042", "Project": "psacc-dep-00042", "Decommissioned": true, "Since": "2026-10-16T08:00:00Z", "AgentState": "decommissioned"}},
	}
	for name, d := range cases {
		w := httptest.NewRecorder()
		s.render(w, 200, name, d)
		body := w.Body.String()
		if !strings.Contains(body, "</html>") || strings.Contains(body, "<no value>") {
			t.Errorf("%s did not render completely", name)
		}
		if name == "dashboard.html" {
			for _, want := range []string{"42", "not analysed yet", "&lt;script&gt;", "UTC"} {
				if !strings.Contains(body, want) {
					t.Errorf("dashboard is missing %q", want)
				}
			}
		}
		if name == "credentials.html" && (!strings.Contains(body, `type="password"`) || !strings.Contains(body, `name="csrf"`)) {
			t.Error("credentials form must use password inputs for secrets and carry the CSRF token")
		}
		if name == "dashboard.html" && (!strings.Contains(body, "scripts/upgrade.sh") || !strings.Contains(body, "reports_delivered")) {
			t.Error("dashboard must show the staged upgrade instructions and the command history")
		}
		if name == "dashboard.html" && (!strings.Contains(body, "suspended-banner") || !strings.Contains(body, "Invoice overdue") || !strings.Contains(body, "LIC-00007")) {
			t.Error("dashboard must show the provider suspension and the license identifier")
		}
		if name == "removal.html" && (!strings.Contains(body, "decommissioned-banner") || !strings.Contains(body, "--wipe --confirm DEP-00042") || !strings.Contains(body, "-Wipe -Confirm DEP-00042")) {
			t.Error("the removal page must show the decommissioned banner and the typed-confirmation wipe commands")
		}
		if name == "dashboard.html" && (!strings.Contains(body, `data-testid="license-state"`) || strings.Contains(body, "license-banner")) {
			t.Error("dashboard must show the license token state and no banner while the token is valid")
		}
		if name == "dashboard.html" && (!strings.Contains(body, "Services on this appliance") || !strings.Contains(body, "received 3")) {
			t.Error("dashboard must render completely after a synchronization (the run details and every later section)")
		}
		if name == "ticket.html" && (!strings.Contains(body, "pushed "+now.UTC().Format("2006-01-02 15:04:05 UTC")) || strings.Contains(body, "pushed —")) {
			t.Error("a pushed event must show the time it was pushed")
		}
	}
}

// Module 13: the dashboard shows a staged upgrade read from the shared volume exactly as the API reads it.
func TestDashboardShowsTheStagedUpgradeFromTheSharedVolume(t *testing.T) {
	dir := t.TempDir()
	if err := remote.StageUpgrade(dir, remote.UpgradeOrder{CommandID: "c2", Repository: "psacc/psa-edge", Version: "0.2.0", Image: "psacc/psa-edge:0.2.0", StagedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour), FromVersion: "0.1.0"}); err != nil {
		t.Fatal(err)
	}
	_ = remote.WriteStatus(dir, []remote.CommandRecord{{ID: "c2", Type: "upgrade", ReceivedAt: time.Now(), Status: "staged", Code: "staged", Message: "Upgrade staged"}})
	cfg := &config.Edge{}
	cfg.Deployment.Code, cfg.Client.DisplayName, cfg.Client.Code = "DEP-00042", "Test Client A", "CL-00027"
	s := &Server{Cfg: cfg, Version: "0.1.0", Log: slog.New(slog.NewTextHandler(io.Discard, nil)), RemoteDir: dir}
	if _, err := s.Handler(); err != nil {
		t.Fatal(err)
	}
	st := Status{Deployment: map[string]string{"code": "DEP-00042", "client": "Test Client A (CL-00027)"}, Remote: s.remoteStatus(), Enrollment: map[string]any{"enrolled": true}, PSA: map[string]any{}, Backup: map[string]any{}}
	w := httptest.NewRecorder()
	s.render(w, 200, "dashboard.html", viewData{Title: "Appliance status", Session: &session{Username: "localadmin", CSRF: strings.Repeat("c", 40)}, Data: st})
	body := w.Body.String()
	for _, want := range []string{`data-testid="staged-upgrade"`, "psacc/psa-edge:0.2.0", "scripts/upgrade.sh", "</html>"} {
		if !strings.Contains(body, want) {
			t.Errorf("dashboard is missing %q", want)
		}
	}
}

// Module 16: a blocked license token shows the banner on the status page and disables Sync now.
func TestDashboardAndSyncShowABlockedLicenseToken(t *testing.T) {
	cfg := &config.Edge{}
	cfg.Deployment.Code, cfg.Client.DisplayName = "DEP-00042", "Test Client A"
	cfg.PSA.DisplayName, cfg.PSA.Provider = "A — Autotask", "autotask"
	s := &Server{Cfg: cfg, Version: "test", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if _, err := s.Handler(); err != nil {
		t.Fatal(err)
	}
	se := &session{Username: "localadmin", CSRF: strings.Repeat("c", 40)}
	status := Status{Deployment: map[string]string{"code": "DEP-00042"}, Enrollment: map[string]any{"enrolled": true, "state": "enrolled"},
		Lifecycle: map[string]any{"suspended": false}, Remote: map[string]any{"version": "0.1.0"},
		LicenseCheck: license.Status{State: "revoked", KeySource: "image", PSAWorkAllowed: false, VerifiedAt: "2026-10-16T08:00:00Z", Detail: "The Control Plane reported the license as inactive: License LIC-00007 is suspended."}}
	w := httptest.NewRecorder()
	s.render(w, 200, "dashboard.html", viewData{Title: "Appliance status", Session: se, Data: status})
	if body := w.Body.String(); !strings.Contains(body, `data-testid="license-banner"`) || !strings.Contains(body, "LIC-00007 is suspended") {
		t.Fatalf("blocked license must show the banner: %s", body[:200])
	}
	w = httptest.NewRecorder()
	now := time.Now()
	s.render(w, 200, "sync.html", viewData{Title: "Synchronization", Session: se, Data: map[string]any{"Runs": []syncRunRow{}, "Pending": 0, "Conflicts24h": 0, "LocalOnly": 0, "PushFailed": 0, "LastSucceededAt": &now, "Watermark": &now, "Runs24h": 0, "Failed24h": 0, "Requested": (*string)(nil), "ConnectionStatus": "verified", "Supported": true, "Provider": "autotask", "Interval": "5m0s", "Suspended": false, "Decommissioned": false, "LicenseBlocked": true, "LicenseState": "expired", "LicenseDetail": "The token expired."}})
	if body := w.Body.String(); !strings.Contains(body, `data-testid="license-banner"`) || !strings.Contains(body, `type="submit" disabled>Sync now`) {
		t.Fatalf("sync page must show the banner and disable Sync now: %s", body[:300])
	}
}
