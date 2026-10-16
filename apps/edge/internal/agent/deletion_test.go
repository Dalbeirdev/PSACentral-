package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"psacc.local/edge/internal/remote"
)

func deletionAgent(t *testing.T, g *fakeGateway) *Agent {
	t.Helper()
	a := agentFor(t, g, g.caPEM)
	dir := t.TempDir()
	a.RemoteDir = filepath.Join(dir, "remote")
	a.DeletionDirPath = filepath.Join(dir, "deletion")
	a.StatusFile = filepath.Join(dir, "agent-status.json")
	a.LicenseCurrentPath = filepath.Join(dir, "license", "current.json")
	ctx := context.Background()
	a.step(ctx, time.Minute, 0) // enrolls
	a.step(ctx, time.Minute, 0) // heartbeats once
	if a.LoadState().State != "enrolled" {
		t.Fatalf("precondition: %s", a.LoadState().State)
	}
	_ = os.MkdirAll(filepath.Dir(a.LicenseCurrentPath), 0o755)
	_ = os.WriteFile(a.LicenseCurrentPath, []byte(`{"token":"psacc-lic.v1.AAAA.BBBB"}`), 0o644)
	return a
}

func TestClientDeletionDeregistersWipesAndEndsWithNoIdentity(t *testing.T) {
	g := newFakeGateway(t)
	a := deletionAgent(t, g)
	ctx := context.Background()
	heartbeats, reports := g.heartbeats.Load(), g.reports.Load()
	if err := WriteDeletionRequest(a.DeletionDir(), DeletionRequest{RequestedAt: time.Now().UTC(), RequestedBy: "localadmin", Reason: "Contract ended"}); err != nil {
		t.Fatal(err)
	}
	// 1. The Control Plane is told over the machine certificate, with the installation binding.
	a.step(ctx, time.Minute, 0)
	st := ReadDeletionStatus(a.DeletionDir())
	if st == nil || st.Phase != "deregistered" || !st.ControlPlaneNotified || st.DeregisteredAt == nil || st.AuditEventID == nil || st.ControlPlaneDeleted["deployments"] != 1 || g.deletes.Load() != 1 {
		t.Fatalf("deregistration: %+v (deletes=%d)", st, g.deletes.Load())
	}
	body, _ := g.lastDelete.Load().(map[string]string)
	if body["installationId"] != "44444444-4444-4444-8444-444444444444" || body["requestedBy"] != "localadmin" || body["reason"] != "Contract ended" || body["requestedAt"] == "" {
		t.Fatalf("delete body: %+v", body)
	}
	// 2. The wipe is handed to the worker with the deployment code as confirmation; the agent waits.
	a.step(ctx, time.Minute, 0)
	reqs, err := remote.Pending(a.RemoteDir, "edge-worker", 0)
	if err != nil || len(reqs) != 1 || reqs[0].Type != "wipe-data" || reqs[0].Params["confirm"] != "DEP-00042" {
		t.Fatalf("wipe hand-over: %+v (%v)", reqs, err)
	}
	if st = ReadDeletionStatus(a.DeletionDir()); st.Phase != "wiping" {
		t.Fatalf("phase after hand-over: %s", st.Phase)
	}
	a.step(ctx, time.Minute, 0)
	if st = ReadDeletionStatus(a.DeletionDir()); st.Phase != "wiping" || a.LoadState().State != "enrolled" {
		t.Fatalf("the agent must wait for the worker, identity intact: %s / %s", st.Phase, a.LoadState().State)
	}
	// 3. The worker answers: the agent deletes its own identity last and reports what remains for the host operator.
	if err := remote.WriteResult(a.RemoteDir, remote.Result{ID: reqs[0].ID, Service: "edge-worker", Status: "succeeded", Code: "wiped", Message: `{"helpdesk_tickets":3,"audit_events":12,"local_admin_users":1}`}); err != nil {
		t.Fatal(err)
	}
	a.step(ctx, time.Minute, 0)
	st = ReadDeletionStatus(a.DeletionDir())
	if st.Phase != "wiped" || st.WipedAt == nil || st.Deleted["helpdesk_tickets"] != 3 || len(st.Remaining) != 3 || !strings.Contains(st.Remaining[0], "--wipe --confirm DEP-00042") {
		t.Fatalf("final status: %+v", st)
	}
	if s := a.LoadState(); s.State != "deleted" || s.DeletedAt == nil || s.DeletionWipeRequest != "" {
		t.Fatalf("final state: %+v", s)
	}
	for _, f := range []string{"agent.key", "agent.crt", "ca.pem"} {
		if _, err := os.Stat(a.path(f)); err == nil {
			t.Fatalf("%s must be deleted", f)
		}
	}
	for _, p := range []string{a.LicenseCurrentPath, a.OutboxDir} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("%s must be deleted", p)
		}
	}
	// 4. Final: nothing is collected or sent any more; the status is honest and carries no token.
	a.step(ctx, time.Minute, 0)
	a.step(ctx, time.Minute, 0)
	if g.heartbeats.Load() != heartbeats || g.reports.Load() != reports || g.deletes.Load() != 1 {
		t.Fatalf("a deleted agent must not contact the gateway: heartbeats=%d reports=%d deletes=%d", g.heartbeats.Load(), g.reports.Load(), g.deletes.Load())
	}
	es := a.Status()
	if es.State != "deleted" || es.Enrolled || es.DeletedAt == nil || es.Deletion == nil || es.Deletion.Phase != "wiped" || !strings.Contains(es.Detail, "scripts/uninstall.sh --wipe --confirm DEP-00042") {
		t.Fatalf("status: %+v", es)
	}
	if b, _ := os.ReadFile(a.StatusFile); !strings.Contains(string(b), `"phase":"wiped"`) || strings.Contains(string(b), "psacc-lic.v1.") {
		t.Fatalf("status file: %s", b)
	}
}

func TestClientDeletionRefusedByTheControlPlaneLeavesTheDecisionToTheAdministrator(t *testing.T) {
	g := newFakeGateway(t)
	a := deletionAgent(t, g)
	ctx := context.Background()
	g.refuse.Store("revoked")
	if err := WriteDeletionRequest(a.DeletionDir(), DeletionRequest{RequestedAt: time.Now().UTC(), RequestedBy: "localadmin"}); err != nil {
		t.Fatal(err)
	}
	a.step(ctx, time.Minute, 0)
	st := ReadDeletionStatus(a.DeletionDir())
	if st.Phase != "refused" || st.ControlPlaneNotified || !strings.Contains(st.LastError, "revoked") || st.Attempts != 1 {
		t.Fatalf("refusal: %+v", st)
	}
	// Nothing is retried and nothing is deleted until the administrator decides.
	a.step(ctx, time.Minute, 0)
	if g.deletes.Load() != 1 || a.LoadState().State != "enrolled" {
		t.Fatalf("no retry, identity kept: deletes=%d state=%s", g.deletes.Load(), a.LoadState().State)
	}
	if reqs, _ := remote.Pending(a.RemoteDir, "edge-worker", 0); len(reqs) != 0 {
		t.Fatalf("no wipe before the decision: %+v", reqs)
	}
	// The administrator chooses to delete locally anyway: the wipe runs, the Control Plane stays untold.
	req := *ReadDeletionRequest(a.DeletionDir())
	req.LocalOnly = true
	if err := WriteDeletionRequest(a.DeletionDir(), req); err != nil {
		t.Fatal(err)
	}
	a.step(ctx, time.Minute, 0) // deregistered (locally)
	a.step(ctx, time.Minute, 0) // wipe handed over
	reqs, _ := remote.Pending(a.RemoteDir, "edge-worker", 0)
	if len(reqs) != 1 || reqs[0].Type != "wipe-data" {
		t.Fatalf("wipe hand-over: %+v", reqs)
	}
	_ = remote.WriteResult(a.RemoteDir, remote.Result{ID: reqs[0].ID, Service: "edge-worker", Status: "succeeded", Code: "wiped", Message: `{}`})
	a.step(ctx, time.Minute, 0)
	st = ReadDeletionStatus(a.DeletionDir())
	if st.Phase != "wiped" || st.ControlPlaneNotified || st.DeregisteredAt != nil || a.LoadState().State != "deleted" || g.deletes.Load() != 1 {
		t.Fatalf("local-only deletion: %+v state=%s deletes=%d", st, a.LoadState().State, g.deletes.Load())
	}
}

func TestClientDeletionRetriesWhileTheControlPlaneIsUnreachable(t *testing.T) {
	g := newFakeGateway(t)
	a := deletionAgent(t, g)
	ctx := context.Background()
	g.srv.Close() // the Control Plane is down
	if err := WriteDeletionRequest(a.DeletionDir(), DeletionRequest{RequestedAt: time.Now().UTC(), RequestedBy: "localadmin"}); err != nil {
		t.Fatal(err)
	}
	delay := a.step(ctx, time.Minute, 0)
	st := ReadDeletionStatus(a.DeletionDir())
	if st.Phase != "deregistering" || st.Attempts != 1 || st.LastError == "" || st.ControlPlaneNotified || delay <= 0 || delay > 5*time.Minute {
		t.Fatalf("retry state: %+v delay=%s", st, delay)
	}
	a.step(ctx, time.Minute, delay)
	if st = ReadDeletionStatus(a.DeletionDir()); st.Attempts != 2 || st.Phase != "deregistering" {
		t.Fatalf("second attempt: %+v", st)
	}
	// Identity and data are untouched while the Control Plane has not confirmed.
	if _, err := os.Stat(a.path("agent.key")); err != nil || a.LoadState().State != "enrolled" {
		t.Fatalf("identity must be kept while retrying: state=%s", a.LoadState().State)
	}
	if reqs, _ := remote.Pending(a.RemoteDir, "edge-worker", 0); len(reqs) != 0 {
		t.Fatalf("no wipe without confirmation: %+v", reqs)
	}
}

func TestWorkerFailureIsRetriedBeforeTheIdentityGoes(t *testing.T) {
	g := newFakeGateway(t)
	a := deletionAgent(t, g)
	ctx := context.Background()
	_ = WriteDeletionRequest(a.DeletionDir(), DeletionRequest{RequestedAt: time.Now().UTC(), RequestedBy: "localadmin"})
	a.step(ctx, time.Minute, 0) // deregistered
	a.step(ctx, time.Minute, 0) // wipe handed over
	reqs, _ := remote.Pending(a.RemoteDir, "edge-worker", 0)
	_ = remote.WriteResult(a.RemoteDir, remote.Result{ID: reqs[0].ID, Service: "edge-worker", Status: "failed", Code: "wipe_error", Message: "confirmation does not match"})
	a.step(ctx, time.Minute, 0)
	st := ReadDeletionStatus(a.DeletionDir())
	if st.Phase != "deregistered" || !strings.Contains(st.LastError, "wipe_error") || a.LoadState().State != "enrolled" {
		t.Fatalf("worker failure must keep the identity and retry: %+v state=%s", st, a.LoadState().State)
	}
	a.step(ctx, time.Minute, 0)
	if again, _ := remote.Pending(a.RemoteDir, "edge-worker", 0); len(again) != 1 || again[0].ID == reqs[0].ID {
		t.Fatalf("a new wipe request must be handed over: %+v", again)
	}
}
