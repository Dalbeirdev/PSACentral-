package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"psacc.local/edge/internal/remote"
)

// Remote commands (Module 13). The Control Plane signs each command with its Ed25519 command key; the
// agent pins that key at enrollment (over the gateway TLS it already pins) and refuses anything that
// is not signed for this very deployment and installation, is expired, has an unknown type, or was
// executed before. Nothing here is destructive; the allow-list is fixed in this binary.

// SignedCommand mirrors @psacc/contracts SignedCommand.
type SignedCommand struct {
	ID             string         `json:"id"`
	Type           string         `json:"type"`
	DeploymentID   string         `json:"deploymentId"`
	InstallationID string         `json:"installationId"`
	Params         map[string]any `json:"params"`
	IssuedAt       string         `json:"issuedAt"`
	ExpiresAt      string         `json:"expiresAt"`
	KeyID          string         `json:"keyId"`
	Signature      string         `json:"signature"`
}

// SigningKey is the Control Plane's command-signing public key as the gateway sends it.
type SigningKey struct {
	KeyID        string `json:"keyId"`
	PublicKeyPem string `json:"publicKeyPem"`
}

type heartbeatResponse struct {
	Status                   string          `json:"status"`
	HeartbeatIntervalSeconds int             `json:"heartbeatIntervalSeconds"`
	Commands                 []SignedCommand `json:"commands"`
	CommandSigningKey        *SigningKey     `json:"commandSigningKey"`
}

// commandResult is what the agent sends back (@psacc/contracts commandResultSchema).
type commandResult struct {
	CommandID    string `json:"commandId"`
	Status       string `json:"status"` // succeeded | failed | staged
	Code         string `json:"code"`
	Message      string `json:"message"`
	StartedAt    string `json:"startedAt"`
	FinishedAt   string `json:"finishedAt"`
	AgentVersion string `json:"agentVersion"`
}

// AllowedCommands is the fixed allow-list of this agent version.
var AllowedCommands = map[string]bool{
	"refresh_health": true, "test_psa_connection": true, "run_sync": true, "restart_service": true, "rotate_certificate": true, "upgrade": true,
	// Module 14: reversible lifecycle commands (the worker pauses / resumes PSA work; nothing is deleted).
	"suspend": true, "resume": true,
}

var (
	semver     = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$`)
	repository = regexp.MustCompile(`^[a-z0-9]+([._/-][a-z0-9]+)*$`)
	digestRe   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	// RemoteWait bounds how long the agent waits for the worker / API to answer a request.
	RemoteWait = 90 * time.Second
	// maxExecuted bounds the dedupe list kept in the agent state.
	maxExecuted = 200
)

// ErrRestartRequested is returned by Run when a restart_service command targeted the agent itself:
// the process exits 0 and Compose starts it again.
var ErrRestartRequested = errors.New("restart requested")

// canonical builds exactly the bytes the Control Plane signed (see contracts canonicalCommand()).
func canonical(c SignedCommand) ([]byte, error) {
	keys := make([]string, 0, len(c.Params))
	for k := range c.Params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	field := func(name string, v any) error {
		b.WriteString(`"` + name + `":`)
		var vb bytes.Buffer
		e := json.NewEncoder(&vb)
		e.SetEscapeHTML(false)
		if err := e.Encode(v); err != nil {
			return err
		}
		b.Write(bytes.TrimRight(vb.Bytes(), "\n"))
		return nil
	}
	b.WriteString("{")
	for i, kv := range []struct {
		k string
		v any
	}{{"id", c.ID}, {"type", c.Type}, {"deploymentId", c.DeploymentID}, {"installationId", c.InstallationID}} {
		if i > 0 {
			b.WriteString(",")
		}
		if err := field(kv.k, kv.v); err != nil {
			return nil, err
		}
	}
	b.WriteString(`,"params":{`)
	for i, k := range keys {
		if i > 0 {
			b.WriteString(",")
		}
		if err := field(k, c.Params[k]); err != nil {
			return nil, err
		}
	}
	b.WriteString("}")
	for _, kv := range []struct {
		k string
		v any
	}{{"issuedAt", c.IssuedAt}, {"expiresAt", c.ExpiresAt}, {"keyId", c.KeyID}} {
		b.WriteString(",")
		if err := field(kv.k, kv.v); err != nil {
			return nil, err
		}
	}
	b.WriteString("}")
	_ = enc
	return b.Bytes(), nil
}

func parsePublicKey(pemText string) (ed25519.PublicKey, string, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, "", errors.New("not a PEM public key")
	}
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, "", err
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, "", errors.New("not an Ed25519 key")
	}
	sum := sha256.Sum256(block.Bytes)
	return pub, hex.EncodeToString(sum[:])[:16], nil
}

// Verify checks signature, key, target, expiry and type. It returns a stable refusal code or "".
func Verify(c SignedCommand, keyPem, keyID, deploymentID, installationID string, now time.Time) string {
	if !AllowedCommands[c.Type] {
		return "type_not_allowed"
	}
	if c.DeploymentID != deploymentID || c.InstallationID != installationID {
		return "target_mismatch"
	}
	exp, err := time.Parse(time.RFC3339Nano, c.ExpiresAt)
	if err != nil || !exp.After(now) {
		return "expired"
	}
	if c.KeyID != keyID {
		return "unknown_key"
	}
	pub, id, err := parsePublicKey(keyPem)
	if err != nil || id != keyID {
		return "unknown_key"
	}
	sig, err := base64.StdEncoding.DecodeString(c.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return "bad_signature"
	}
	msg, err := canonical(c)
	if err != nil || !ed25519.Verify(pub, msg, sig) {
		return "bad_signature"
	}
	return ""
}

// remoteDir is where requests, results, the staged order and the command history live.
func (a *Agent) remoteDir() string {
	if a.RemoteDir != "" {
		return a.RemoteDir
	}
	return remote.DefaultDir
}

func (a *Agent) resultsQueueDir() string { return filepath.Join(a.StateDir, "command-results") }

// pinKey stores the signing key on first sight (enrollment response, or the first heartbeat for agents
// enrolled before Module 13). A different key later is logged and ignored: rotation is a future command.
func (a *Agent) pinKey(s *State, k *SigningKey) {
	if k == nil || k.PublicKeyPem == "" {
		return
	}
	if s.CommandKeyID == "" {
		if _, id, err := parsePublicKey(k.PublicKeyPem); err == nil && id == k.KeyID {
			s.CommandKeyID, s.CommandPublicKey = k.KeyID, k.PublicKeyPem
			a.Log.Info("command signing key pinned", "keyId", k.KeyID)
		} else {
			a.Log.Warn("command signing key rejected", "keyId", k.KeyID)
		}
		return
	}
	if s.CommandKeyID != k.KeyID {
		a.Log.Warn("gateway presents a different command signing key; commands are ignored until re-enrollment", "pinned", s.CommandKeyID, "offered", k.KeyID)
	}
}

func (a *Agent) executed(s State, id string) bool {
	for _, e := range s.ExecutedCommands {
		if e == id {
			return true
		}
	}
	return false
}

// handleCommands verifies and executes the commands of one heartbeat. Results are queued on disk and
// delivered by flushResults (so an outage between execution and reporting loses nothing).
func (a *Agent) handleCommands(ctx context.Context, cmds []SignedCommand) (restart bool) {
	s := a.LoadState()
	for _, c := range cmds {
		if a.executed(s, c.ID) {
			continue
		}
		s.ExecutedCommands = append(s.ExecutedCommands, c.ID)
		if len(s.ExecutedCommands) > maxExecuted {
			s.ExecutedCommands = s.ExecutedCommands[len(s.ExecutedCommands)-maxExecuted:]
		}
		_ = a.SaveState(s)
		started := time.Now().UTC()
		rec := remote.CommandRecord{ID: c.ID, Type: c.Type, ReceivedAt: started}
		if code := Verify(c, s.CommandPublicKey, s.CommandKeyID, s.DeploymentID, s.InstallationID, started); code != "" {
			a.Log.Warn("remote command refused", "id", c.ID, "type", c.Type, "code", code)
			rec.Status, rec.Code, rec.Message = "failed", code, "Refused by the agent before execution."
			a.recordCommand(rec)
			a.queueResult(commandResult{CommandID: c.ID, Status: "failed", Code: code, Message: rec.Message, StartedAt: started.Format(time.RFC3339Nano), FinishedAt: time.Now().UTC().Format(time.RFC3339Nano), AgentVersion: a.Version})
			continue
		}
		a.Log.Info("remote command accepted", "id", c.ID, "type", c.Type)
		res, exit := a.execute(ctx, c)
		res.CommandID, res.AgentVersion = c.ID, a.Version
		res.StartedAt = started.Format(time.RFC3339Nano)
		res.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
		rec.Status, rec.Code, rec.Message = res.Status, res.Code, res.Message
		a.recordCommand(rec)
		a.queueResult(res)
		a.Log.Info("remote command finished", "id", c.ID, "type", c.Type, "status", res.Status, "code", res.Code)
		if exit {
			restart = true
		}
	}
	return restart
}

func (a *Agent) execute(ctx context.Context, c SignedCommand) (commandResult, bool) {
	switch c.Type {
	case "refresh_health":
		items := a.CollectAll(ctx)
		if _, err := a.Store(items); err != nil {
			return commandResult{Status: "failed", Code: "store_error", Message: redactErr(err)}, false
		}
		n, err := a.Deliver(ctx)
		if err != nil {
			return commandResult{Status: "failed", Code: "delivery_failed", Message: redactErr(err)}, false
		}
		return commandResult{Status: "succeeded", Code: "reports_delivered", Message: fmt.Sprintf("%d report batch(es) delivered.", n)}, false
	case "rotate_certificate":
		if err := a.Renew(ctx); err != nil {
			return commandResult{Status: "failed", Code: "renewal_failed", Message: redactErr(err)}, false
		}
		return commandResult{Status: "succeeded", Code: "certificate_renewed", Message: "New machine certificate issued; serial " + a.LoadState().Serial + "."}, false
	case "restart_service":
		svc, _ := c.Params["service"].(string)
		switch svc {
		case "edge-agent":
			return commandResult{Status: "succeeded", Code: "restarting", Message: "The agent exits after reporting; Docker Compose starts it again."}, true
		case "edge-api", "edge-worker":
			return a.viaService(ctx, svc, c, "restart_service"), false
		default:
			return commandResult{Status: "failed", Code: "unknown_service", Message: "The service cannot be restarted remotely."}, false
		}
	case "test_psa_connection", "run_sync", "suspend", "resume":
		return a.viaService(ctx, "edge-worker", c, c.Type), false
	case "upgrade":
		return a.stageUpgrade(c), false
	}
	return commandResult{Status: "failed", Code: "type_not_allowed", Message: "Unknown command type."}, false
}

// viaService hands a command to the worker or the local API through the shared volume and waits for
// its answer.
func (a *Agent) viaService(ctx context.Context, service string, c SignedCommand, typ string) commandResult {
	req := remote.Request{ID: c.ID, Type: typ, Service: service, Params: c.Params, CreatedAt: time.Now().UTC()}
	if err := remote.WriteRequest(a.remoteDir(), req); err != nil {
		return commandResult{Status: "failed", Code: "request_not_written", Message: redactErr(err)}
	}
	deadline := time.Now().Add(RemoteWait)
	for time.Now().Before(deadline) {
		if r, err := remote.ReadResult(a.remoteDir(), c.ID, true); err == nil && r != nil {
			return commandResult{Status: r.Status, Code: r.Code, Message: r.Message}
		}
		select {
		case <-ctx.Done():
			return commandResult{Status: "failed", Code: "cancelled", Message: "The agent stopped before the service answered."}
		case <-time.After(time.Second):
		}
	}
	return commandResult{Status: "failed", Code: "no_response", Message: service + " did not answer within " + RemoteWait.String() + " (not running, or an older image without remote command support)."}
}

// stageUpgrade verifies the target and writes the order for the host operator. The appliance has no
// Docker socket (by design), so the image change is applied on the host with scripts/upgrade.sh; the
// agent reports success itself once the new version runs (see checkUpgradeApplied).
func (a *Agent) stageUpgrade(c SignedCommand) commandResult {
	repo, _ := c.Params["repository"].(string)
	version, _ := c.Params["version"].(string)
	var digest *string
	if d, ok := c.Params["digest"].(string); ok && d != "" {
		if !digestRe.MatchString(d) {
			return commandResult{Status: "failed", Code: "invalid_target", Message: "The image digest is not valid."}
		}
		digest = &d
	}
	if !repository.MatchString(repo) || !semver.MatchString(version) {
		return commandResult{Status: "failed", Code: "invalid_target", Message: "The image reference is not valid."}
	}
	if repo != a.Cfg.Image.Repository {
		return commandResult{Status: "failed", Code: "repository_mismatch", Message: "The order names a different image repository than this appliance was installed from."}
	}
	if version == a.Version {
		_ = remote.ClearOrder(a.remoteDir())
		return commandResult{Status: "succeeded", Code: "already_running", Message: "This appliance already runs version " + version + "."}
	}
	image := repo + ":" + version
	if digest != nil {
		image += "@" + *digest
	}
	exp, _ := time.Parse(time.RFC3339Nano, c.ExpiresAt)
	if err := remote.StageUpgrade(a.remoteDir(), remote.UpgradeOrder{CommandID: c.ID, Repository: repo, Version: version, Digest: digest, Image: image, StagedAt: time.Now().UTC(), ExpiresAt: exp, FromVersion: a.Version}); err != nil {
		return commandResult{Status: "failed", Code: "stage_failed", Message: redactErr(err)}
	}
	return commandResult{Status: "staged", Code: "staged", Message: "Upgrade to " + image + " staged. On the appliance host run: scripts/upgrade.sh"}
}

// checkUpgradeApplied reports a staged upgrade as succeeded once this (new) version runs, or drops an
// expired order.
func (a *Agent) checkUpgradeApplied() {
	o, err := remote.ReadOrder(a.remoteDir())
	if err != nil || o == nil {
		return
	}
	now := time.Now().UTC()
	if o.Version == a.Version {
		_ = remote.ClearOrder(a.remoteDir())
		a.queueResult(commandResult{CommandID: o.CommandID, Status: "succeeded", Code: "upgraded", Message: "The appliance now runs version " + a.Version + " (was " + o.FromVersion + ").", StartedAt: o.StagedAt.Format(time.RFC3339Nano), FinishedAt: now.Format(time.RFC3339Nano), AgentVersion: a.Version})
		a.recordCommand(remote.CommandRecord{ID: o.CommandID, Type: "upgrade", ReceivedAt: o.StagedAt, Status: "succeeded", Code: "upgraded", Message: "Running version " + a.Version + "."})
		a.Log.Info("staged upgrade applied", "version", a.Version, "from", o.FromVersion)
		return
	}
	if !o.ExpiresAt.IsZero() && now.After(o.ExpiresAt) {
		_ = remote.ClearOrder(a.remoteDir())
		a.Log.Warn("staged upgrade order expired before it was applied", "version", o.Version)
	}
}

// queueResult persists a result until the gateway accepts it.
func (a *Agent) queueResult(r commandResult) {
	_ = os.MkdirAll(a.resultsQueueDir(), 0o700)
	b, _ := json.Marshal(r)
	_ = writeAtomic(filepath.Join(a.resultsQueueDir(), r.CommandID+".json"), b, 0o600)
}

// flushResults delivers queued results; terminal refusals (unknown or closed command) are dropped.
func (a *Agent) flushResults(ctx context.Context) {
	entries, _ := filepath.Glob(filepath.Join(a.resultsQueueDir(), "*.json"))
	if len(entries) == 0 {
		return
	}
	c, err := a.mtlsClient()
	if err != nil {
		return
	}
	sort.Strings(entries)
	for _, p := range entries {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var r commandResult
		if err := json.Unmarshal(b, &r); err != nil {
			_ = os.Remove(p)
			continue
		}
		err = a.post(ctx, c, a.gatewayURL(), "/agent/v1/command-results", r, nil)
		var ge *GatewayError
		if err == nil || (errors.As(err, &ge) && (ge.Status == 404 || ge.Status == 409 || ge.Status == 400)) {
			if err != nil {
				a.Log.Warn("command result not accepted", "id", r.CommandID, "code", ge.Code)
			}
			_ = os.Remove(p)
			a.markReported(r.CommandID)
			continue
		}
		a.Log.Warn("command result delivery failed; will retry", "id", r.CommandID, "err", redactErr(err))
		return
	}
}

func (a *Agent) recordCommand(rec remote.CommandRecord) {
	list := remote.ReadStatus(a.remoteDir())
	out := []remote.CommandRecord{rec}
	for _, r := range list {
		if r.ID != rec.ID {
			out = append(out, r)
		}
	}
	if len(out) > 20 {
		out = out[:20]
	}
	_ = remote.WriteStatus(a.remoteDir(), out)
}

func (a *Agent) markReported(id string) {
	list := remote.ReadStatus(a.remoteDir())
	for i := range list {
		if list[i].ID == id {
			list[i].Reported = true
		}
	}
	_ = remote.WriteStatus(a.remoteDir(), list)
}

// commandsSummary is what the agent's status file exposes (no secrets).
func (a *Agent) commandsSummary() map[string]any {
	s := a.LoadState()
	pending, _ := filepath.Glob(filepath.Join(a.resultsQueueDir(), "*.json"))
	out := map[string]any{"signingKeyPinned": s.CommandKeyID != "", "signingKeyId": s.CommandKeyID, "resultsWaiting": len(pending), "allowed": allowedList()}
	if o, err := remote.ReadOrder(a.remoteDir()); err == nil && o != nil {
		out["stagedUpgrade"] = o
	}
	return out
}

func allowedList() []string {
	out := make([]string, 0, len(AllowedCommands))
	for k := range AllowedCommands {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// String form used in logs and tests.
func (c SignedCommand) String() string { return strings.Join([]string{c.Type, c.ID}, " ") }
