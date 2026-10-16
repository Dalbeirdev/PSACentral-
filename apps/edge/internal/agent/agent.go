// Package agent is the edge monitoring and management agent.
//
// It collects the approved, allow-listed metadata (ARCHITECTURE §1.1.3) — database availability,
// schema version and table inventory from the catalog, versions — as the catalog-only inspector
// role, and keeps each report in a bounded on-disk outbox. Delivery to the Control Plane over the
// mTLS agent gateway, and enrollment with the single-use token, arrive in Module 7; until then the
// agent reports "not enrolled" truthfully.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/inventory"
	"psacc.local/edge/internal/remote"
)

const outboxLimit = 50

type Agent struct {
	Cfg            *config.Edge
	EnrollmentPath string
	OutboxDir      string
	StateDir       string
	// StatusFile is a copy of Status() (no secrets) for the local admin UI on the shared log volume.
	StatusFile string
	// RemoteDir is the shared directory for remote command requests / results / staged upgrade (Module 13).
	RemoteDir string
	Pool      *pgxpool.Pool
	Version   string
	Log       *slog.Logger
	prevCPU   cpuSample
	// lastInventory is the database inventory of the latest collection (drives schema snapshots).
	lastInventory inventory.Database
	// restart is set by a restart_service command addressed to the agent itself.
	restart bool
}

// Store writes a batch of reports to the outbox and keeps only the newest outboxLimit batches.
func (a *Agent) Store(items []ReportItem) (string, error) { return a.store(items, 0) }

// store names the batch after its observation time; seq distinguishes batches of one collection.
func (a *Agent) store(items []ReportItem, seq int) (string, error) {
	if err := os.MkdirAll(a.OutboxDir, 0o700); err != nil {
		return "", err
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", err
	}
	at := time.Now().UTC()
	if len(items) > 0 {
		at = items[0].ObservedAt
	}
	name := filepath.Join(a.OutboxDir, fmt.Sprintf("report-%s.json", at.Format("20060102T150405.000000000Z")))
	if seq > 0 {
		name = filepath.Join(a.OutboxDir, fmt.Sprintf("report-%s-%02d.json", at.Format("20060102T150405.000000000Z"), seq))
	}
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, name); err != nil {
		return "", err
	}
	entries, _ := filepath.Glob(filepath.Join(a.OutboxDir, "report-*.json"))
	sort.Strings(entries)
	for len(entries) > outboxLimit {
		_ = os.Remove(entries[0])
		entries = entries[1:]
	}
	return name, nil
}

// Deliver sends buffered batches, oldest first, over mTLS. A delivered or permanently rejected batch
// is removed; a batch that could not be sent (network) stays for the next cycle.
func (a *Agent) Deliver(ctx context.Context) (sent int, err error) {
	entries, _ := filepath.Glob(filepath.Join(a.OutboxDir, "report-*.json"))
	sort.Strings(entries)
	if len(entries) == 0 {
		return 0, nil
	}
	c, err := a.mtlsClient()
	if err != nil {
		return 0, err
	}
	for _, f := range entries {
		b, err := os.ReadFile(f)
		if err != nil {
			_ = os.Remove(f)
			continue
		}
		var items []ReportItem
		if json.Unmarshal(b, &items) != nil || len(items) == 0 {
			_ = os.Remove(f)
			continue
		}
		var resp struct {
			Accepted    int              `json:"accepted"`
			Rejected    []map[string]any `json:"rejected"`
			HealthState string           `json:"healthState"`
		}
		err = a.post(ctx, c, a.gatewayURL(), "/agent/v1/reports", map[string]any{"agentVersion": a.Version, "reports": items}, &resp)
		var ge *GatewayError
		if err != nil && !errors.As(err, &ge) {
			return sent, err // network: keep the batch
		}
		if err == nil || ge.Status == 400 {
			if len(resp.Rejected) > 0 {
				a.Log.Warn("reports rejected by the Control Plane", "rejected", len(resp.Rejected), "detail", resp.Rejected)
			}
			for _, it := range items {
				if fp, ok := it.Payload["fingerprint"].(string); ok && it.Type == "database_schema" && err == nil && len(resp.Rejected) == 0 {
					a.markSchemaDelivered(fp)
				}
			}
			_ = os.Remove(f)
			sent++
			continue
		}
		return sent, err // certificate refused etc.: stop
	}
	return sent, nil
}

type EnrollmentStatus struct {
	Enrolled            bool       `json:"enrolled"`
	State               string     `json:"state"`
	Detail              string     `json:"detail"`
	GatewayURL          string     `json:"gatewayUrl"`
	Serial              string     `json:"serial,omitempty"`
	CertificateNotAfter *time.Time `json:"certificateNotAfter,omitempty"`
	LastHeartbeatAt     *time.Time `json:"lastHeartbeatAt,omitempty"`
	LastError           string     `json:"lastError,omitempty"`
	TokenExpiresAt      *time.Time `json:"tokenExpiresAt,omitempty"`
	TokenExpired        bool       `json:"tokenExpired"`
	LastReportAt        *time.Time `json:"lastReportAt,omitempty"`
	BufferedReports     int        `json:"bufferedReports"`
	DecommissionedAt    *time.Time `json:"decommissionedAt,omitempty"`
	// Commands: remote command capability (pinned key, queued results, staged upgrade); never secrets.
	Commands map[string]any `json:"commands,omitempty"`
}

func (a *Agent) Status() EnrollmentStatus {
	s := a.LoadState()
	st := EnrollmentStatus{State: s.State, Enrolled: s.State == "enrolled", GatewayURL: a.gatewayURL(), Serial: s.Serial,
		CertificateNotAfter: s.NotAfter, LastHeartbeatAt: s.LastHeartbeatAt, LastError: s.LastError}
	if en, err := config.LoadEnrollment(a.EnrollmentPath); err == nil {
		t := en.ExpiresAt
		st.TokenExpiresAt = &t
		st.TokenExpired = time.Now().After(t)
	} else if s.State != "enrolled" {
		st.State = "no_enrollment_file"
	}
	switch st.State {
	case "enrolled":
		st.Detail = "Enrolled with the Control Plane; communicating over mutual TLS with this installation's machine certificate."
	case "revoked":
		st.Detail = "The machine certificate was revoked or replaced. Re-enroll with a new package from the dashboard."
	case "decommissioned":
		st.Detail = "The provider decommissioned this deployment: its management identity is retired and the appliance no longer reports to the Control Plane. Tickets, data and the local admin stay on this host until the operator removes the appliance (scripts/uninstall.sh)."
		st.DecommissionedAt = s.DecommissionedAt
	case "failed":
		st.Detail = "Enrollment was refused and cannot succeed with this package: " + s.LastError
	case "no_enrollment_file":
		st.Detail = "No enrollment file was found."
	default:
		st.Detail = "Not enrolled yet. The agent keeps trying to reach the agent gateway."
		if st.TokenExpired {
			st.Detail = "The enrollment token in this package has expired. Generate a new package in the dashboard."
		}
	}
	st.Commands = a.commandsSummary()
	entries, _ := filepath.Glob(filepath.Join(a.OutboxDir, "report-*.json"))
	st.BufferedReports = len(entries)
	if len(entries) > 0 {
		sort.Strings(entries)
		base := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(entries[len(entries)-1]), "report-"), ".json")
		if t, err := time.Parse("20060102T150405.000000000Z", base); err == nil {
			st.LastReportAt = &t
		}
	}
	return st
}

// step runs one cycle: enroll if needed, renew when due, heartbeat, and buffer a report.
// It returns the delay before the next cycle (backoff after failures).
func (a *Agent) step(ctx context.Context, interval, backoff time.Duration) time.Duration {
	s := a.LoadState()
	next := interval
	if s.State == "decommissioned" {
		// Module 15: nothing is collected or sent any more; the worker is told once and its answer consumed.
		a.decommissionedStep(s)
		return interval
	}
	switch s.State {
	case "pending":
		if err := a.Enroll(ctx); err != nil {
			s = a.onGatewayError(s, err)
			_ = a.SaveState(s)
			a.Log.Warn("enrollment failed", "err", s.LastError, "state", s.State)
			if s.State == "pending" { // retryable: back off up to 5 minutes
				next = min(max(backoff*2, 5*time.Second), 5*time.Minute)
			}
		} else {
			s = a.LoadState()
			a.Log.Info("enrolled with the Control Plane", "serial", s.Serial, "notAfter", s.NotAfter)
		}
	case "enrolled":
		if NeedsRenewal(s, time.Now()) {
			if err := a.Renew(ctx); err != nil {
				a.Log.Warn("certificate renewal failed", "err", redactErr(err))
			} else {
				s = a.LoadState()
				a.Log.Info("certificate renewed", "serial", s.Serial)
			}
		}
		a.checkUpgradeApplied()
		hb, err := a.Heartbeat(ctx)
		if err != nil {
			s = a.onGatewayError(s, err)
			a.Log.Warn("heartbeat failed", "err", s.LastError, "state", s.State)
			if s.State == "decommissioned" {
				s = a.notifyDecommissioned(s)
			}
			if s.State == "enrolled" { // Control Plane unreachable: keep working locally, retry with backoff
				next = min(max(backoff*2, 5*time.Second), interval)
			}
		} else {
			now := time.Now().UTC()
			s.LastHeartbeatAt, s.LastError, s.LastErrorAt = &now, "", nil
			a.pinKey(&s, hb.CommandSigningKey)
		}
		_ = a.SaveState(s)
		if err == nil && len(hb.Commands) > 0 {
			if a.handleCommands(ctx, hb.Commands) {
				a.restart = true
			}
		}
	}
	items := a.CollectAll(ctx)
	if _, err := a.Store(items); err != nil {
		a.Log.Warn("reports not stored", "err", err)
	}
	a.collectSchema(ctx, a.lastInventory, time.Now().UTC())
	if s = a.LoadState(); s.State == "enrolled" {
		if n, err := a.Deliver(ctx); err != nil {
			a.Log.Warn("report delivery failed", "err", redactErr(err))
		} else if n > 0 {
			a.Log.Info("reports delivered", "batches", n)
		}
		a.flushResults(ctx)
	}
	if a.StatusFile != "" {
		if b, err := json.Marshal(a.Status()); err == nil {
			_ = writeAtomic(a.StatusFile, b, 0o644)
		}
	}
	return next
}

func (a *Agent) Run(ctx context.Context, interval time.Duration) error {
	a.Log.Info("agent started", "deployment", a.Cfg.Deployment.Code, "gateway", a.gatewayURL(), "state", a.LoadState().State)
	delay := time.Duration(0)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		delay = a.step(ctx, interval, delay)
		if a.restart {
			a.Log.Info("exiting for a remote restart; Docker Compose starts the agent again")
			return ErrRestartRequested
		}
	}
}

var ErrNotEnrolled = errors.New("not enrolled")

// notifyDecommissioned hands the retirement to the worker through the shared volume (it pauses PSA work
// and records the flag for the local admin). The hand-over is a local request, not a remote command.
func (a *Agent) notifyDecommissioned(s State) State {
	now := time.Now().UTC()
	id := newRequestID()
	req := remote.Request{ID: id, Type: "decommission", Service: "edge-worker", Params: map[string]any{"at": now.Format(time.RFC3339), "detail": s.LastError}, CreatedAt: now}
	if err := remote.WriteRequest(a.remoteDir(), req); err != nil {
		a.Log.Warn("decommission hand-over not written", "err", err)
	} else {
		s.DecommissionNotice = id
	}
	a.Log.Warn("deployment decommissioned by the Control Plane: management identity retired, reporting stopped; data and the local admin stay on this host",
		"since", now.Format(time.RFC3339))
	return s
}

// newRequestID: a random UUID-shaped id for a local hand-over request.
func newRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
}

// decommissionedStep keeps the status file current and consumes the worker's acknowledgement.
func (a *Agent) decommissionedStep(s State) {
	if s.DecommissionNotice != "" {
		if r, err := remote.ReadResult(a.remoteDir(), s.DecommissionNotice, true); err == nil && r != nil {
			a.Log.Info("worker acknowledged the decommissioning", "code", r.Code)
			s.DecommissionNotice = ""
			_ = a.SaveState(s)
		}
	}
	if a.StatusFile != "" {
		if b, err := json.Marshal(a.Status()); err == nil {
			_ = writeAtomic(a.StatusFile, b, 0o644)
		}
	}
}
