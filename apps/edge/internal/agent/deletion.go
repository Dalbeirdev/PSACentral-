package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"psacc.local/edge/internal/remote"
)

// Module 17: client-initiated deletion ("Delete all data and deregister").
//
// The local administrator confirms the deletion in the local admin UI; the API writes request.json on the
// shared log volume. From then on the agent drives the phases, one per cycle, and writes status.json for
// the UI and `edge-agent status`:
//
//	requested → deregistering (POST /agent/v1/delete over the machine certificate; retried while the
//	Control Plane is unreachable; `refused` when it answers 4xx, which leaves the decision to delete locally
//	anyway to the administrator) → deregistered (the worker is asked to wipe the database and the shared
//	files) → wiping → wiped (the agent deletes its own identity last; only Docker resources remain, which the
//	host operator removes with the uninstall script).

const (
	deletionRequestFile = "request.json"
	deletionStatusFile  = "status.json"
)

// DeletionRequest is written by the local admin UI (edge-api) after the administrator confirmed.
type DeletionRequest struct {
	RequestedAt time.Time `json:"requestedAt"`
	RequestedBy string    `json:"requestedBy"`
	Reason      string    `json:"reason,omitempty"`
	// LocalOnly: delete the local data without the Control Plane's confirmation (chosen by the administrator
	// after a refusal, or when this appliance has no identity to speak with).
	LocalOnly bool `json:"localOnly,omitempty"`
}

// DeletionStatus mirrors packages/contracts applianceDeletionStatusSchema.
type DeletionStatus struct {
	Phase                string           `json:"phase"`
	RequestedAt          time.Time        `json:"requestedAt"`
	RequestedBy          string           `json:"requestedBy"`
	Reason               string           `json:"reason"`
	Attempts             int              `json:"attempts"`
	LastAttemptAt        *time.Time       `json:"lastAttemptAt"`
	LastError            string           `json:"lastError"`
	ControlPlaneNotified bool             `json:"controlPlaneNotified"`
	DeregisteredAt       *time.Time       `json:"deregisteredAt"`
	WipedAt              *time.Time       `json:"wipedAt"`
	Deleted              map[string]int64 `json:"deleted"`
	Remaining            []string         `json:"remaining"`
	ControlPlaneDeleted  map[string]int64 `json:"controlPlaneDeleted"`
	AuditEventID         *string          `json:"auditEventId"`
}

type deletionAnswer struct {
	Status         string           `json:"status"`
	DeploymentCode string           `json:"deploymentCode"`
	DeletedAt      string           `json:"deletedAt"`
	AuditEventID   *string          `json:"auditEventId"`
	Deleted        map[string]int64 `json:"deleted"`
}

// DeletionDir is the shared directory of the deletion request and status (edge-logs volume).
func (a *Agent) DeletionDir() string {
	if a.DeletionDirPath != "" {
		return a.DeletionDirPath
	}
	return "/var/log/psa-edge/deletion"
}

// ReadDeletionRequest returns the administrator's request, or nil when none was made.
func ReadDeletionRequest(dir string) *DeletionRequest {
	b, err := os.ReadFile(filepath.Join(dir, deletionRequestFile))
	if err != nil {
		return nil
	}
	var r DeletionRequest
	if json.Unmarshal(b, &r) != nil || r.RequestedBy == "" {
		return nil
	}
	return &r
}

// WriteDeletionRequest records the administrator's decision (used by edge-api and the tests).
func WriteDeletionRequest(dir string, r DeletionRequest) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, deletionRequestFile), b, 0o644)
}

// ReadDeletionStatus returns the agent's progress, or nil before the agent picked the request up.
func ReadDeletionStatus(dir string) *DeletionStatus {
	b, err := os.ReadFile(filepath.Join(dir, deletionStatusFile))
	if err != nil {
		return nil
	}
	var s DeletionStatus
	if json.Unmarshal(b, &s) != nil || s.Phase == "" {
		return nil
	}
	return &s
}

func (a *Agent) writeDeletionStatus(st *DeletionStatus) {
	if st.Deleted == nil {
		st.Deleted = map[string]int64{}
	}
	if st.Remaining == nil {
		st.Remaining = []string{}
	}
	if st.ControlPlaneDeleted == nil {
		st.ControlPlaneDeleted = map[string]int64{}
	}
	if err := os.MkdirAll(a.DeletionDir(), 0o755); err != nil {
		a.Log.Warn("deletion status directory", "err", err)
		return
	}
	b, err := json.Marshal(st)
	if err == nil {
		err = writeAtomic(filepath.Join(a.DeletionDir(), deletionStatusFile), b, 0o644)
	}
	if err != nil {
		a.Log.Warn("deletion status not written", "err", err)
	}
}

func (a *Agent) writeStatusFile() {
	if a.StatusFile == "" {
		return
	}
	if b, err := json.Marshal(a.Status()); err == nil {
		_ = writeAtomic(a.StatusFile, b, 0o644)
	}
}

// remainingAfterWipe lists what only the host operator can remove (the appliance has no Docker access by design).
func (a *Agent) remainingAfterWipe() []string {
	return []string{
		"The Docker containers, networks and data volumes of this appliance: run scripts/uninstall.sh --wipe --confirm " + a.Cfg.Deployment.Code + " from the package folder (Windows: scripts\\uninstall.ps1 -Wipe -Confirm " + a.Cfg.Deployment.Code + ").",
		"The backups volume (removed by the same command).",
		"The package folder itself, and the PSA Edge image once no other appliance on this host uses it.",
	}
}

// deletionStep runs one phase of the deletion and returns the delay until the next cycle.
func (a *Agent) deletionStep(ctx context.Context, s State, req *DeletionRequest, backoff, interval time.Duration) time.Duration {
	st := ReadDeletionStatus(a.DeletionDir())
	if st == nil {
		st = &DeletionStatus{Phase: "requested", RequestedAt: req.RequestedAt, RequestedBy: req.RequestedBy, Reason: req.Reason}
		a.Log.Warn("deletion of all data requested by the local administrator; PSA work stops, the Control Plane is told, then everything on this appliance is deleted",
			"requestedBy", req.RequestedBy, "requestedAt", req.RequestedAt.UTC().Format(time.RFC3339))
	}
	now := time.Now().UTC()
	next := interval
	switch st.Phase {
	case "requested", "deregistering", "refused":
		if st.Phase == "refused" && !req.LocalOnly {
			break // the administrator decides: retry is pointless, deleting locally anyway is their call
		}
		if req.LocalOnly && !st.ControlPlaneNotified {
			st.Phase, st.LastError = "deregistered", ""
			a.Log.Warn("deleting local data without the Control Plane's confirmation, as the local administrator chose")
			break
		}
		st.Phase = "deregistering"
		st.Attempts++
		st.LastAttemptAt = &now
		ans, err := a.deregister(ctx, s, req)
		var ge *GatewayError
		switch {
		case err == nil:
			st.ControlPlaneNotified, st.DeregisteredAt, st.LastError = true, &now, ""
			st.ControlPlaneDeleted, st.AuditEventID = ans.Deleted, ans.AuditEventID
			st.Phase = "deregistered"
			a.Log.Warn("deregistered from the Control Plane: its records of this deployment are deleted", "answer", ans.Status, "deployment", ans.DeploymentCode)
		case errors.As(err, &ge) && ge.Status >= 400 && ge.Status < 500:
			st.Phase, st.LastError = "refused", ge.Code+": "+ge.Message
			a.Log.Warn("the Control Plane refused the deregistration; the local administrator can still delete the local data", "code", ge.Code, "status", ge.Status)
		default:
			st.LastError = redactErr(err)
			next = min(max(backoff*2, 5*time.Second), 5*time.Minute)
			a.Log.Warn("deregistration not delivered; retrying", "err", st.LastError, "attempt", st.Attempts)
		}
	case "deregistered":
		id := newRequestID()
		r := remote.Request{ID: id, Type: "wipe-data", Service: "edge-worker", Params: map[string]any{"confirm": a.Cfg.Deployment.Code}, CreatedAt: now}
		if err := remote.WriteRequest(a.remoteDir(), r); err != nil {
			st.LastError = "wipe hand-over not written: " + err.Error()
			next = min(max(backoff*2, 5*time.Second), 5*time.Minute)
		} else {
			s.DeletionWipeRequest = id
			_ = a.SaveState(s)
			st.Phase, st.LastError = "wiping", ""
			next = 3 * time.Second
		}
	case "wiping":
		if s.DeletionWipeRequest == "" {
			st.Phase = "deregistered"
			break
		}
		r, err := remote.ReadResult(a.remoteDir(), s.DeletionWipeRequest, true)
		if err != nil || r == nil {
			next = 3 * time.Second // the worker polls the hand-over directory every two seconds
			break
		}
		if r.Status != "succeeded" {
			st.LastError = r.Code + ": " + r.Message
			s.DeletionWipeRequest = ""
			_ = a.SaveState(s)
			st.Phase = "deregistered"
			next = min(max(backoff*2, 5*time.Second), 5*time.Minute)
			a.Log.Warn("the worker could not wipe the data; retrying", "code", r.Code)
			break
		}
		var counts map[string]int64
		if json.Unmarshal([]byte(r.Message), &counts) == nil {
			st.Deleted = counts
		}
		a.wipeIdentity(s, now)
		st.Phase, st.WipedAt, st.LastError = "wiped", &now, ""
		st.Remaining = a.remainingAfterWipe()
		a.Log.Warn("all data on this appliance is deleted; the machine identity is gone. Only the Docker resources remain for the host operator to remove", "deployment", a.Cfg.Deployment.Code)
	case "wiped":
		// Final. Nothing is collected, sent or stored any more.
	}
	a.writeDeletionStatus(st)
	a.writeStatusFile()
	return next
}

// deregister tells the Control Plane over the machine certificate. Without an identity there is nothing to say.
func (a *Agent) deregister(ctx context.Context, s State, req *DeletionRequest) (deletionAnswer, error) {
	var out deletionAnswer
	if s.State != "enrolled" && s.State != "decommissioned" {
		return out, &GatewayError{Status: 403, Code: "no-identity", Message: "This appliance has no usable machine certificate (state " + s.State + "), so the Control Plane cannot be told from here."}
	}
	c, err := a.mtlsClient()
	if err != nil {
		return out, &GatewayError{Status: 403, Code: "no-identity", Message: "The machine certificate cannot be loaded: " + redactErr(err)}
	}
	installation := s.InstallationID
	if installation == "" {
		installation = a.Cfg.Deployment.InstallationID
	}
	err = a.post(ctx, c, a.gatewayURL(), "/agent/v1/delete", map[string]any{
		"installationId": installation, "requestedBy": req.RequestedBy, "reason": req.Reason, "requestedAt": req.RequestedAt.UTC().Format(time.RFC3339),
	}, &out)
	return out, err
}

// wipeIdentity deletes the machine certificate and key, the outbox and the current license token, and
// leaves a final state record. It runs last, after the Control Plane and the worker are done.
func (a *Agent) wipeIdentity(s State, now time.Time) {
	for _, f := range []string{"agent.key", "agent.crt", "ca.pem"} {
		_ = os.Remove(a.path(f))
	}
	if a.OutboxDir != "" {
		_ = os.RemoveAll(a.OutboxDir)
	}
	if a.LicenseCurrentPath != "" {
		_ = os.Remove(a.LicenseCurrentPath)
	}
	_ = a.SaveState(State{State: "deleted", DeploymentID: s.DeploymentID, InstallationID: s.InstallationID, DeletedAt: &now})
}
