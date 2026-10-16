// Package worker hosts the PSA integration adapter and the ticket / synchronization engine.
//
// It maintains the PSA connection's credential status, re-runs the real connection test periodically
// once credentials are present (Module 11), synchronizes tickets once the connection is verified
// (Module 12), answers remote commands the agent hands over through the shared volume (Module 13),
// and records its own liveness.
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/license"
	"psacc.local/edge/internal/psa"
	"psacc.local/edge/internal/redact"
	"psacc.local/edge/internal/remote"
	edgesync "psacc.local/edge/internal/sync"
)

type Worker struct {
	Cfg      *config.Edge
	Pool     *pgxpool.Pool
	Log      *slog.Logger
	Interval time.Duration
	// Tester runs the periodic PSA connection test; nil disables it (unit tests, no data key).
	Tester *psa.Tester
	// TestInterval is how often a configured connection is re-tested against the PSA (default 15 min).
	TestInterval time.Duration
	// SyncInterval is how often tickets are synchronized once the connection is verified (default 5 min);
	// failures back off (doubling, at most 30 min). "Sync now" from the local admin UI runs on the next tick.
	SyncInterval time.Duration
	// RemoteDir is the shared directory the agent uses to hand over remote commands (empty disables it).
	RemoteDir string
	// License files (Module 16): the package copy and the current token the agent keeps fresh.
	LicensePackagePath string
	LicenseCurrentPath string
	// LogDir (Module 17) is the shared log volume whose files the wipe removes (outbox, license, hand-over files).
	LogDir       string
	licenseState string

	mu          sync.Mutex
	lastSync    time.Time
	syncBackoff time.Duration
}

func (w *Worker) logEntry(ctx context.Context, level, msg string) {
	if _, err := w.Pool.Exec(ctx, `INSERT INTO integration_logs (level, component, message, psa_connection_id)
		SELECT $1, 'worker', $2, id FROM psa_connections WHERE instance_code = $3`, level, msg, w.Cfg.PSA.InstanceCode); err != nil {
		w.Log.Warn("integration log write failed", "err", err)
	}
}

// Tick updates the credential status of the PSA connection, runs the periodic connection test when
// credentials are present and the last test is older than TestInterval, and records the worker's
// last-seen time. It returns the connection status afterwards.
func (w *Worker) Tick(ctx context.Context) (string, error) {
	if on, _ := DeletedIn(ctx, w.Pool); on {
		return "deleted", nil // Module 17: the database was emptied on purpose; nothing runs any more
	}
	var id, status string
	var have int
	var lastTest *time.Time
	if err := w.Pool.QueryRow(ctx, `SELECT c.id, c.status, c.last_test_at,
		(SELECT count(*) FROM credential_store s WHERE s.psa_connection_id = c.id AND s.field_key <> $2)
		FROM psa_connections c WHERE c.instance_code = $1`, w.Cfg.PSA.InstanceCode, psa.CAFieldKey).Scan(&id, &status, &lastTest, &have); err != nil {
		return "", err
	}
	n := len(w.Cfg.PSA.CredentialFields)
	complete := n > 0 && have >= n
	want := "not_configured"
	if complete {
		want = "credentials_present"
	}
	// Test results (verified / failed) stand until the next test; the credential status only moves
	// between not_configured and credentials_present.
	if status != "verified" && status != "failed" && want != status {
		if _, err := w.Pool.Exec(ctx, `UPDATE psa_connections SET status = $2 WHERE id = $1`, id, want); err != nil {
			return "", err
		}
		w.logEntry(ctx, "info", "PSA connection "+w.Cfg.PSA.InstanceCode+" credential status: "+want+".")
		status = want
	}
	suspended, _ := w.Suspended(ctx)
	if dec, _ := DecommissionedIn(ctx, w.Pool); dec {
		suspended = true // Module 15: a decommissioned appliance runs no PSA work either
	}
	if on, _ := DeletionRequestedIn(ctx, w.Pool); on {
		suspended = true // Module 17: nothing talks to the PSA once the administrator asked for the deletion
	}
	// Module 16: no PSA work without a valid (or grace-period) license token; the state change is logged once.
	lic := w.License()
	if lic.State != w.licenseState {
		if lic.PSAWorkAllowed {
			w.logEntry(ctx, "info", "License token "+lic.State+": "+lic.Detail)
		} else {
			w.logEntry(ctx, "warn", "License token "+lic.State+": "+lic.Detail+" PSA connection tests and ticket synchronization are stopped until the Control Plane renews the token.")
		}
		w.licenseState = lic.State
	}
	if !lic.PSAWorkAllowed {
		suspended = true
	}
	if w.Tester != nil && complete && !suspended {
		interval := w.TestInterval
		if interval <= 0 {
			interval = 15 * time.Minute
		}
		if lastTest == nil || time.Since(*lastTest) >= interval {
			res, err := w.Tester.Test(ctx, "worker")
			if err != nil {
				w.Log.Warn("periodic PSA connection test could not run", "err", err)
			} else {
				w.Log.Info("periodic PSA connection test", "ok", res.OK, "code", res.Code, "httpStatus", res.HTTPStatus, "latencyMs", res.LatencyMs)
				if res.OK {
					status = "verified"
				} else if res.Code == psa.CodeNotConfigured {
					status = "not_configured"
				} else {
					status = "failed"
				}
			}
		}
	}
	if w.Tester != nil && !suspended {
		w.maybeSync(ctx, status)
	}
	_, err := w.Pool.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('worker.last_seen_at', $1)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, time.Now().UTC().Format(time.RFC3339))
	return status, err
}

// maybeSync runs the ticket synchronization when it is due (interval or backoff) or requested from the
// local admin UI, and only while the connection is verified.
func (w *Worker) maybeSync(ctx context.Context, status string) {
	store := &edgesync.PgStore{Pool: w.Pool, InstanceCode: w.Cfg.PSA.InstanceCode}
	requested, err := store.RequestedManualRun(ctx)
	if err != nil {
		w.Log.Warn("sync request check failed", "err", err)
	}
	interval := w.SyncInterval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	wait := interval
	if w.syncBackoff > 0 {
		wait = w.syncBackoff
	}
	if !requested && !w.lastSync.IsZero() && time.Since(w.lastSync) < wait {
		return
	}
	if status != "verified" && !requested {
		return // nothing to do until a connection test verifies the PSA
	}
	trigger := "scheduled"
	if requested {
		trigger = "manual"
	} else if w.lastSync.IsZero() {
		trigger = "initial"
	}
	w.runSync(ctx, trigger)
}

// runSync runs one synchronization pass now and keeps the backoff bookkeeping.
func (w *Worker) runSync(ctx context.Context, trigger string) (*edgesync.Summary, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	interval := w.SyncInterval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	store := &edgesync.PgStore{Pool: w.Pool, InstanceCode: w.Cfg.PSA.InstanceCode}
	w.lastSync = time.Now()
	eng := &edgesync.Engine{Store: store, Log: w.Log, Conn: func(ctx context.Context) (*psa.Conn, error) {
		c, _, err := w.Tester.LoadConn(ctx)
		return c, err
	}}
	sum, err := eng.Run(ctx, trigger)
	if err != nil {
		w.Log.Warn("synchronization could not run", "err", err)
		w.syncBackoff = min(max(w.syncBackoff*2, interval), 30*time.Minute)
		return nil, err
	}
	w.Log.Info("synchronization", "trigger", trigger, "status", sum.Status, "received", sum.Received, "created", sum.Created, "updated", sum.Updated, "conflicts", sum.Conflicts, "sent", sum.Sent, "failed", sum.Failed, "code", sum.ErrorCode)
	if sum.Status == "failed" {
		w.syncBackoff = min(max(w.syncBackoff*2, interval), 30*time.Minute)
	} else {
		w.syncBackoff = 0
	}
	return &sum, nil
}

// HandleRemote answers a remote command the agent handed over through the shared volume (Module 13).
// The worker does the work with its own privileges; the agent only relays the outcome.
func (w *Worker) HandleRemote(ctx context.Context, r remote.Request) (remote.Result, bool) {
	switch r.Type {
	case "suspend":
		reason, _ := r.Params["reason"].(string)
		if err := w.setSuspended(ctx, true, reason); err != nil {
			return remote.Result{Status: "failed", Code: "store_error", Message: redact.Text(err.Error(), 300)}, false
		}
		w.logEntry(ctx, "warn", "Suspended by the provider (signed remote command). PSA connection tests and ticket synchronization are paused; tickets, data and the local admin stay available.")
		return remote.Result{Status: "succeeded", Code: "suspended", Message: "PSA work paused on the appliance; data and the local UI stay available."}, false
	case "decommission":
		// Module 15: the agent learned from the Control Plane that this deployment's identity was retired.
		detail, _ := r.Params["detail"].(string)
		if err := w.setDecommissioned(ctx, detail); err != nil {
			return remote.Result{Status: "failed", Code: "store_error", Message: redact.Text(err.Error(), 300)}, false
		}
		w.logEntry(ctx, "warn", "Decommissioned by the provider: the management identity is retired and the Control Plane is no longer contacted. PSA connection tests and ticket synchronization have stopped; tickets, data and the local admin stay on this host until the operator removes the appliance (scripts/uninstall.sh).")
		return remote.Result{Status: "succeeded", Code: "decommissioned", Message: "PSA work stopped; data and the local UI stay until the host operator removes the appliance."}, false
	case "wipe-data":
		// Module 17: the agent relays the local administrator's deletion once the Control Plane has been told
		// (or the administrator chose to go ahead without it). The confirmation is the deployment code.
		confirm, _ := r.Params["confirm"].(string)
		counts, err := w.WipeAllData(ctx, confirm)
		if err != nil {
			return remote.Result{Status: "failed", Code: "wipe_error", Message: redact.Text(err.Error(), 300)}, false
		}
		b, _ := json.Marshal(counts)
		w.Log.Warn("all data on this appliance deleted at the local administrator's request", "tables", len(counts))
		return remote.Result{Status: "succeeded", Code: "wiped", Message: string(b)}, false
	case "resume":
		if err := w.setSuspended(ctx, false, ""); err != nil {
			return remote.Result{Status: "failed", Code: "store_error", Message: redact.Text(err.Error(), 300)}, false
		}
		w.logEntry(ctx, "info", "Resumed by the provider (signed remote command). PSA connection tests and ticket synchronization run again.")
		return remote.Result{Status: "succeeded", Code: "resumed", Message: "PSA work resumed on the appliance."}, false
	case "test_psa_connection":
		if s, _ := w.Suspended(ctx); s {
			return remote.Result{Status: "failed", Code: "suspended", Message: "The deployment is suspended; resume it first."}, false
		}
		if w.Tester == nil {
			return remote.Result{Status: "failed", Code: "not_available", Message: "No PSA tester on this worker."}, false
		}
		res, err := w.Tester.Test(ctx, "remote")
		if err != nil {
			return remote.Result{Status: "failed", Code: "test_error", Message: redact.Text(err.Error(), 300)}, false
		}
		status := "failed"
		if res.OK {
			status = "succeeded"
		}
		msg := "Connection test " + res.Code
		if res.HTTPStatus != 0 {
			msg += " (HTTP " + strconv.Itoa(res.HTTPStatus) + ")"
		}
		msg += ", " + strconv.Itoa(res.LatencyMs) + " ms."
		return remote.Result{Status: status, Code: res.Code, Message: msg}, false
	case "run_sync":
		if s, _ := w.Suspended(ctx); s {
			return remote.Result{Status: "failed", Code: "suspended", Message: "The deployment is suspended; resume it first."}, false
		}
		if w.Tester == nil || !psa.SyncSupported(w.Cfg.PSA.Provider) {
			return remote.Result{Status: "failed", Code: "sync_unsupported", Message: "Ticket synchronization is not implemented for this provider."}, false
		}
		sum, err := w.runSync(ctx, "remote")
		if err != nil {
			return remote.Result{Status: "failed", Code: "sync_error", Message: redact.Text(err.Error(), 300)}, false
		}
		status := "succeeded"
		if sum.Status == "failed" {
			status = "failed"
		}
		code := sum.Status
		if sum.ErrorCode != "" {
			code = sum.ErrorCode
		}
		return remote.Result{Status: status, Code: code, Message: "Synchronization " + sum.Status + ": " + strconv.Itoa(sum.Received) + " received, " + strconv.Itoa(sum.Sent) + " sent, " + strconv.Itoa(sum.Failed) + " failed, " + strconv.Itoa(sum.Conflicts) + " conflict(s)."}, false
	case "restart_service":
		w.logEntry(ctx, "info", "Restart requested by a signed remote command; the worker exits and Docker Compose starts it again.")
		return remote.Result{Status: "succeeded", Code: "restarting", Message: "The worker exits after this answer; Docker Compose starts it again."}, true
	}
	return remote.Result{Status: "failed", Code: "type_not_allowed", Message: "The worker does not handle this request."}, false
}

func (w *Worker) Run(ctx context.Context) error {
	if psa.SyncSupported(w.Cfg.PSA.Provider) {
		w.logEntry(ctx, "info", "Worker started for "+w.Cfg.PSA.Provider+" ("+w.Cfg.PSA.InstanceCode+"). Connection tests and ticket synchronization run on this appliance; the Control Plane receives counts and statuses only.")
	} else {
		w.logEntry(ctx, "info", "Worker started for "+w.Cfg.PSA.Provider+" ("+w.Cfg.PSA.InstanceCode+"). Connection tests run on this appliance; ticket synchronization is not implemented for this provider in this version, so no ticket data is exchanged with the PSA.")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	exitRequested := make(chan struct{}, 1)
	if w.RemoteDir != "" {
		go func() {
			if err := remote.Serve(ctx, w.RemoteDir, "edge-worker", 2*time.Second, w.HandleRemote); err == nil {
				exitRequested <- struct{}{}
				cancel()
			}
		}()
	}
	t := time.NewTicker(w.Interval)
	defer t.Stop()
	for {
		if _, err := w.Tick(ctx); err != nil && ctx.Err() == nil {
			w.Log.Warn("worker tick failed", "err", err)
		}
		select {
		case <-ctx.Done():
			select {
			case <-exitRequested:
				return ErrRestartRequested
			default:
				return nil
			}
		case <-t.C:
		}
	}
}

// Suspended reports whether the provider suspended this deployment (app_metadata `service.suspended`,
// written by a signed remote command, Module 14) and since when.
func (w *Worker) Suspended(ctx context.Context) (bool, string) {
	return SuspendedIn(ctx, w.Pool)
}

// SuspendedIn reads the suspension flag with any pool (the local admin UI uses it too).
func SuspendedIn(ctx context.Context, pool *pgxpool.Pool) (bool, string) {
	var v string
	if err := pool.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'service.suspended'`).Scan(&v); err != nil || v == "" {
		return false, ""
	}
	return true, v
}

func (w *Worker) setSuspended(ctx context.Context, on bool, reason string) error {
	if !on {
		_, err := w.Pool.Exec(ctx, `DELETE FROM app_metadata WHERE key = 'service.suspended'`)
		return err
	}
	v := time.Now().UTC().Format(time.RFC3339) + "|" + redact.Text(reason, 200)
	_, err := w.Pool.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('service.suspended', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, v)
	return err
}

// DecommissionedIn reads the decommission flag (`service.decommissioned`, "<RFC3339>|<detail>", Module 15).
func DecommissionedIn(ctx context.Context, pool *pgxpool.Pool) (bool, string) {
	var v string
	if err := pool.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'service.decommissioned'`).Scan(&v); err != nil || v == "" {
		return false, ""
	}
	return true, v
}

// DeletionRequestedIn reads the deletion flag the local admin UI sets (`service.deletion_requested`, "<RFC3339>|<user>", Module 17).
func DeletionRequestedIn(ctx context.Context, pool *pgxpool.Pool) (bool, string) {
	var v string
	if err := pool.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'service.deletion_requested'`).Scan(&v); err != nil || v == "" {
		return false, ""
	}
	return true, v
}

// DeletedIn reads the marker edge_wipe_all_data() leaves (`service.deleted`, "<RFC3339>|<code>", Module 17).
func DeletedIn(ctx context.Context, pool *pgxpool.Pool) (bool, string) {
	var v string
	if err := pool.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'service.deleted'`).Scan(&v); err != nil || v == "" {
		return false, ""
	}
	return true, v
}

// WipeAllData empties every application table through the schema owner's edge_wipe_all_data() (the
// application role cannot delete audit rows or logs itself) and removes the files on the shared log volume
// this process can reach: the report outbox, the license token and the hand-over files. The confirmation
// must be this appliance's deployment code. Returns the rows deleted per table.
func (w *Worker) WipeAllData(ctx context.Context, confirm string) (map[string]int64, error) {
	var raw []byte
	if err := w.Pool.QueryRow(ctx, `SELECT edge_wipe_all_data($1)::text`, confirm).Scan(&raw); err != nil {
		return nil, err
	}
	counts := map[string]int64{}
	if err := json.Unmarshal(raw, &counts); err != nil {
		return nil, err
	}
	dir := w.LogDir
	if dir == "" {
		dir = "/var/log/psa-edge"
	}
	for _, p := range []string{filepath.Join(dir, "outbox"), filepath.Join(dir, "license"), filepath.Join(dir, "schema")} {
		_ = os.RemoveAll(p)
	}
	if w.RemoteDir != "" {
		_ = os.RemoveAll(filepath.Join(w.RemoteDir, "requests"))
		_ = os.Remove(remote.OrderPath(w.RemoteDir))
		_ = os.Remove(remote.StatusPath(w.RemoteDir))
	}
	return counts, nil
}

func (w *Worker) setDecommissioned(ctx context.Context, detail string) error {
	v := time.Now().UTC().Format(time.RFC3339) + "|" + redact.Text(detail, 200)
	_, err := w.Pool.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('service.decommissioned', $1) ON CONFLICT (key) DO NOTHING`, v)
	return err
}

// License evaluates the appliance's license token (Module 16).
func (w *Worker) License() license.Status {
	pkg, cur := w.LicensePackagePath, w.LicenseCurrentPath
	if pkg == "" {
		pkg = "/etc/psa-edge/license.json"
	}
	if cur == "" {
		cur = "/var/log/psa-edge/license/current.json"
	}
	return license.Current(pkg, cur, w.Cfg.Deployment.ID, w.Cfg.Deployment.InstallationID, time.Now())
}

// ErrRestartRequested: a remote restart_service command asked the worker to exit (exit status 0).
var ErrRestartRequested = errors.New("restart requested")
