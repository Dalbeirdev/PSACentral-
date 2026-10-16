package license

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const depID, instID = "11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444"

type signer struct {
	priv ed25519.PrivateKey
	key  *Key
	pem  string
	spki string
}

func newSigner(t *testing.T) *signer {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	sum := sha256.Sum256(der)
	return &signer{priv: priv, key: &Key{Public: pub, ID: hex.EncodeToString(sum[:])[:16], Source: "image"},
		pem: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), spki: base64.StdEncoding.EncodeToString(der)}
}

func (s *signer) token(t *testing.T, mutate func(c *Claims)) string {
	t.Helper()
	now := time.Now().UTC()
	c := Claims{V: 1, KeyID: s.key.ID, LicenseID: "22222222-2222-4222-8222-222222222222", LicenseCode: "LIC-00007", Plan: "Help Desk Plus",
		OrganizationID: "33333333-3333-4333-8333-333333333333", ClientID: "55555555-5555-4555-8555-555555555555", DeploymentID: depID, DeploymentCode: "DEP-00042",
		InstallationID: instID, IssuedAt: now.Format(time.RFC3339Nano), ExpiresAt: now.Add(30 * 24 * time.Hour).Format(time.RFC3339Nano), LicenseEndsAt: nil, GraceDays: 14}
	if mutate != nil {
		mutate(&c)
	}
	raw, _ := json.Marshal(c)
	segment := base64.RawURLEncoding.EncodeToString(raw)
	sig := ed25519.Sign(s.priv, []byte(segment))
	return Prefix + segment + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func str(s string) *string { return &s }

func TestValidTokenAllowsPSAWorkAndCarriesTheLicense(t *testing.T) {
	s := newSigner(t)
	tok := s.token(t, nil)
	st := Evaluate(&File{SchemaVersion: 1, Token: &tok}, s.key, depID, instID, time.Now())
	if st.State != "valid" || !st.PSAWorkAllowed || st.LicenseCode == nil || *st.LicenseCode != "LIC-00007" || st.KeySource != "image" || *st.KeyID != s.key.ID {
		t.Fatalf("valid token: %+v", st)
	}
	if st.TokenExpiresAt == nil || !strings.Contains(st.Detail, "valid until") {
		t.Fatalf("status detail: %+v", st)
	}
}

func TestTamperedForeignAndWrongKeyTokensAreRefused(t *testing.T) {
	s := newSigner(t)
	other := newSigner(t)
	good := s.token(t, nil)
	// A single changed character in the claims breaks the signature.
	tampered := Prefix + "A" + good[len(Prefix)+1:]
	cases := map[string]string{
		"tampered":  tampered,
		"wrong-key": other.token(t, nil),
		"garbage":   "psacc-lic.v1.abc",
		"not-a-tok": "hello",
		"short-sig": Prefix + "eyJ2IjoxfQ.AAAA",
	}
	for name, tok := range cases {
		st := Evaluate(&File{Token: &tok}, s.key, depID, instID, time.Now())
		if st.State != "invalid" || st.PSAWorkAllowed {
			t.Fatalf("%s: expected invalid, got %+v", name, st)
		}
	}
	// Signed by the trusted key, but for another appliance: mismatch, no PSA work.
	foreign := s.token(t, func(c *Claims) { c.InstallationID = "66666666-6666-4666-8666-666666666666" })
	if st := Evaluate(&File{Token: &foreign}, s.key, depID, instID, time.Now()); st.State != "mismatch" || st.PSAWorkAllowed {
		t.Fatalf("foreign installation: %+v", st)
	}
	foreignDep := s.token(t, func(c *Claims) { c.DeploymentID = "77777777-7777-4777-8777-777777777777" })
	if st := Evaluate(&File{Token: &foreignDep}, s.key, depID, instID, time.Now()); st.State != "mismatch" {
		t.Fatalf("foreign deployment: %+v", st)
	}
	// A token naming a different key id is refused even though the signature would verify after a key rotation.
	otherID := s.token(t, func(c *Claims) { c.KeyID = "0000000000000000" })
	if st := Evaluate(&File{Token: &otherID}, s.key, depID, instID, time.Now()); st.State != "invalid" {
		t.Fatalf("key id mismatch: %+v", st)
	}
}

func TestExpiryGraceLicenseEndRevocationAndMissing(t *testing.T) {
	s := newSigner(t)
	now := time.Now().UTC()
	expired := s.token(t, func(c *Claims) { c.ExpiresAt = now.Add(-2 * 24 * time.Hour).Format(time.RFC3339Nano) })
	// Two days past expiry with 14 days of grace: PSA work continues, the state says so.
	if st := Evaluate(&File{Token: &expired}, s.key, depID, instID, now); st.State != "grace" || !st.PSAWorkAllowed || !strings.Contains(st.Detail, "PSA work continues") {
		t.Fatalf("grace: %+v", st)
	}
	// Twenty days past expiry: grace over.
	if st := Evaluate(&File{Token: &expired}, s.key, depID, instID, now.Add(18*24*time.Hour)); st.State != "expired" || st.PSAWorkAllowed {
		t.Fatalf("after grace: %+v", st)
	}
	// The license term itself ended, although the token is still within its validity.
	ended := s.token(t, func(c *Claims) { c.LicenseEndsAt = str(now.Add(-3 * 24 * time.Hour).Format("2006-01-02")) })
	if st := Evaluate(&File{Token: &ended}, s.key, depID, instID, now); st.State != "expired" || st.PSAWorkAllowed || !strings.Contains(st.Detail, "ended on") {
		t.Fatalf("license ended: %+v", st)
	}
	// Ends today: still the last day.
	today := s.token(t, func(c *Claims) { c.LicenseEndsAt = str(now.Format("2006-01-02")) })
	if st := Evaluate(&File{Token: &today}, s.key, depID, instID, now); st.State != "valid" {
		t.Fatalf("ends today must still be valid: %+v", st)
	}
	// Revoked by the Control Plane (written by the agent after an `inactive` answer).
	if st := Evaluate(&File{Revoked: true, RevokedReason: "License LIC-00007 is suspended."}, s.key, depID, instID, now); st.State != "revoked" || st.PSAWorkAllowed || !strings.Contains(st.Detail, "suspended") {
		t.Fatalf("revoked: %+v", st)
	} else if st.Detail != "The Control Plane reported the license as inactive: License LIC-00007 is suspended." {
		t.Fatalf("revoked detail must end in exactly one full stop: %q", st.Detail) // the Control Plane's reasons are sentences already
	}
	// Nothing at all.
	if st := Evaluate(nil, s.key, depID, instID, now); st.State != "missing" || st.PSAWorkAllowed {
		t.Fatalf("missing: %+v", st)
	}
	if st := Evaluate(&File{Token: nil}, s.key, depID, instID, now); st.State != "missing" {
		t.Fatalf("empty token: %+v", st)
	}
}

func TestKeySelectionAndFiles(t *testing.T) {
	s := newSigner(t)
	// Without a pinned key the package copy is used and reported as such; without either, nothing verifies.
	EmbeddedPublicKeyB64 = ""
	pkg := &File{SchemaVersion: 1, PublicKeyPEM: s.pem}
	if k := KeyFor(pkg); k == nil || k.Source != "package" || k.ID != s.key.ID {
		t.Fatalf("package key: %+v", k)
	}
	if KeyFor(&File{}) != nil {
		t.Fatal("no key must yield nil")
	}
	tok := s.token(t, nil)
	if st := Evaluate(&File{Token: &tok}, nil, depID, instID, time.Now()); st.State != "invalid" || !strings.Contains(st.Detail, "no license verification key") {
		t.Fatalf("no key: %+v", st)
	}
	// With the pinned key, the package copy is ignored even if it names another key.
	EmbeddedPublicKeyB64 = s.spki
	t.Cleanup(func() { EmbeddedPublicKeyB64 = "" })
	other := newSigner(t)
	if k := KeyFor(&File{PublicKeyPEM: other.pem}); k == nil || k.Source != "image" || k.ID != s.key.ID {
		t.Fatalf("embedded key must win: %+v", k)
	}
	// Files: the current token file (kept by the agent) takes precedence over the package file.
	dir := t.TempDir()
	pkgPath, curPath := filepath.Join(dir, "license.json"), filepath.Join(dir, "current", "license.json")
	stale := s.token(t, func(c *Claims) { c.ExpiresAt = time.Now().Add(-40 * 24 * time.Hour).Format(time.RFC3339Nano) })
	if err := WriteFile(pkgPath, &File{SchemaVersion: 1, Token: &stale, PublicKeyPEM: s.pem}); err != nil {
		t.Fatal(err)
	}
	if st := Current(pkgPath, curPath, depID, instID, time.Now()); st.State != "expired" {
		t.Fatalf("package-only stale token: %+v", st)
	}
	fresh := s.token(t, nil)
	if err := WriteFile(curPath, &File{SchemaVersion: 1, Token: &fresh, Source: "heartbeat"}); err != nil {
		t.Fatal(err)
	}
	if st := Current(pkgPath, curPath, depID, instID, time.Now()); st.State != "valid" {
		t.Fatalf("renewed token must win: %+v", st)
	}
	if f, err := ReadFile(filepath.Join(dir, "nope.json")); err != nil || f != nil {
		t.Fatalf("missing file must be (nil, nil): %+v %v", f, err)
	}
}
