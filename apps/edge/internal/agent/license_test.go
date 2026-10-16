package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"psacc.local/edge/internal/license"
)

// licenseGateway extends the fake gateway: heartbeats carry a licensing answer (active token / inactive / none).
type licenseGateway struct {
	*fakeGateway
	priv  ed25519.PrivateKey
	keyID string
	spki  string
	mode  string // active | inactive | none | absent
}

func newLicenseGateway(t *testing.T) *licenseGateway {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	sum := sha256.Sum256(der)
	g := &licenseGateway{fakeGateway: newFakeGateway(t), priv: priv, keyID: hex.EncodeToString(sum[:])[:16], spki: base64.StdEncoding.EncodeToString(der), mode: "active"}
	g.srv.Config.Handler = http.HandlerFunc(g.handle)
	return g
}

func (g *licenseGateway) token(deploymentID, installationID string) string {
	now := time.Now().UTC()
	c := license.Claims{V: 1, KeyID: g.keyID, LicenseID: "22222222-2222-4222-8222-222222222222", LicenseCode: "LIC-00007", Plan: "Help Desk Plus",
		OrganizationID: "33333333-3333-4333-8333-333333333333", ClientID: "55555555-5555-4555-8555-555555555555", DeploymentID: deploymentID, DeploymentCode: "DEP-00042",
		InstallationID: installationID, IssuedAt: now.Format(time.RFC3339Nano), ExpiresAt: now.Add(30 * 24 * time.Hour).Format(time.RFC3339Nano), GraceDays: 14}
	raw, _ := json.Marshal(c)
	segment := base64.RawURLEncoding.EncodeToString(raw)
	return license.Prefix + segment + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(g.priv, []byte(segment)))
}

func (g *licenseGateway) renewal(r *http.Request) map[string]any {
	switch g.mode {
	case "active":
		var in struct {
			DeploymentID   string `json:"deploymentId"`
			InstallationID string `json:"installationId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		dep, inst := in.DeploymentID, in.InstallationID
		if dep == "" { // heartbeats carry no ids: use the test's fixed ones
			dep, inst = depID, instID
		}
		tok := g.token(dep, inst)
		return map[string]any{"state": "active", "token": tok, "licenseCode": "LIC-00007", "reason": nil}
	case "inactive":
		return map[string]any{"state": "inactive", "token": nil, "licenseCode": "LIC-00007", "reason": "License LIC-00007 is suspended."}
	case "none":
		return map[string]any{"state": "none", "token": nil, "licenseCode": nil, "reason": "No license is bound to this deployment."}
	}
	return nil
}

func (g *licenseGateway) handle(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/agent/v1/heartbeat":
		if len(r.TLS.PeerCertificates) == 0 {
			w.WriteHeader(401)
			return
		}
		g.heartbeats.Add(1)
		body := map[string]any{"status": "ok"}
		if ren := g.renewal(r); ren != nil {
			body["license"] = ren
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	default:
		g.fakeGateway.handle(w, r)
	}
}

// Module 16: the agent stores the Control Plane's licensing answer on the shared volume, where the
// worker and the local admin verify it; a revocation stops PSA work at once; the report carries the verdict.
func TestLicenseTokenIsStoredRenewedRevokedAndReported(t *testing.T) {
	g := newLicenseGateway(t)
	a := agentFor(t, g.fakeGateway, g.caPEM)
	a.Cfg.Deployment.ID, a.Cfg.Deployment.InstallationID = depID, instID
	dir := t.TempDir()
	a.LicensePackagePath = filepath.Join(dir, "package", "license.json")
	a.LicenseCurrentPath = filepath.Join(dir, "current", "license.json")
	license.EmbeddedPublicKeyB64 = g.spki
	t.Cleanup(func() { license.EmbeddedPublicKeyB64 = "" })
	ctx := context.Background()

	// Nothing yet: missing, no PSA work, and the status / report say so.
	if st := a.LicenseStatus(); st.State != "missing" || st.PSAWorkAllowed || st.KeySource != "image" {
		t.Fatalf("before any token: %+v", st)
	}
	a.step(ctx, time.Minute, 0) // enrolls (the base fake gateway answers enrollment without a license)
	a.step(ctx, time.Minute, 0) // heartbeat: active token
	st := a.LicenseStatus()
	if st.State != "valid" || !st.PSAWorkAllowed || st.LicenseCode == nil || *st.LicenseCode != "LIC-00007" {
		t.Fatalf("after an active heartbeat: %+v", st)
	}
	cur, err := license.ReadFile(a.LicenseCurrentPath)
	if err != nil || cur == nil || cur.Source != "heartbeat" || cur.Token == nil {
		t.Fatalf("current file: %+v %v", cur, err)
	}
	// The verdict rides in the certificates/security report.
	var reported map[string]any
	for _, it := range a.CollectAll(ctx) {
		if it.Type == "certificates_security" {
			reported, _ = it.Payload["license"].(map[string]any)
			if reported == nil {
				b, _ := json.Marshal(it.Payload["license"])
				_ = json.Unmarshal(b, &reported)
			}
		}
	}
	if reported == nil || reported["state"] != "valid" || reported["psaWorkAllowed"] != true {
		t.Fatalf("report must carry the verdict: %+v", reported)
	}
	// Revocation: the next heartbeat says inactive; PSA work stops although the stored token would still be valid.
	g.mode = "inactive"
	a.step(ctx, time.Minute, 0)
	if st := a.LicenseStatus(); st.State != "revoked" || st.PSAWorkAllowed || !strings.Contains(st.Detail, "suspended") {
		t.Fatalf("after an inactive heartbeat: %+v", st)
	}
	// Renewal: active again.
	g.mode = "active"
	a.step(ctx, time.Minute, 0)
	if st := a.LicenseStatus(); st.State != "valid" {
		t.Fatalf("after renewal: %+v", st)
	}
	// An older Control Plane without a licensing answer leaves the stored token alone.
	g.mode = "absent"
	a.step(ctx, time.Minute, 0)
	if st := a.LicenseStatus(); st.State != "valid" {
		t.Fatalf("absent answer must keep the token: %+v", st)
	}
	// No license bound: the stored token is cleared → missing.
	g.mode = "none"
	a.step(ctx, time.Minute, 0)
	if st := a.LicenseStatus(); st.State != "missing" || st.PSAWorkAllowed {
		t.Fatalf("none: %+v", st)
	}
	// The local admin's status file carries the verdict too (no token value anywhere in it).
	status := a.Status()
	if status.License == nil || status.License.State != "missing" {
		t.Fatalf("status license: %+v", status.License)
	}
	if b, _ := json.Marshal(status); strings.Contains(string(b), "psacc-lic.v1.") {
		t.Fatal("the status must not carry the token itself")
	}
}
