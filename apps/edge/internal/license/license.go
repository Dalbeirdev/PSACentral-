// Package license verifies the Control Plane's signed license tokens on the appliance (Module 16).
//
// A token binds one license to this deployment and installation for a limited time; the Control Plane
// renews it with every heartbeat. The appliance checks the Ed25519 signature against the key pinned in
// its image at build time (EmbeddedPublicKeyB64) — or, for images built without one, the key shipped in
// the package — then the binding and the dates. PSA work (connection tests, ticket synchronization) runs
// only while the state is `valid` or `grace`; a Control Plane outage therefore never stops a client
// within the token's validity plus grace, while a copied image or package, a revoked license or a
// lapsed one does not run.
package license

import (
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
	"strings"
	"time"
)

// EmbeddedPublicKeyB64 is the base64 SPKI DER of the Control Plane's license verification key, set at
// build time (-ldflags "-X psacc.local/edge/internal/license.EmbeddedPublicKeyB64=..."). Empty for
// development builds without a key.
var EmbeddedPublicKeyB64 = ""

const Prefix = "psacc-lic.v1."

// Claims are the signed statements of a token (mirrors @psacc/contracts licenseTokenClaimsSchema).
type Claims struct {
	V              int     `json:"v"`
	KeyID          string  `json:"keyId"`
	LicenseID      string  `json:"licenseId"`
	LicenseCode    string  `json:"licenseCode"`
	Plan           string  `json:"plan"`
	OrganizationID string  `json:"organizationId"`
	ClientID       string  `json:"clientId"`
	DeploymentID   string  `json:"deploymentId"`
	DeploymentCode string  `json:"deploymentCode"`
	InstallationID string  `json:"installationId"`
	IssuedAt       string  `json:"issuedAt"`
	ExpiresAt      string  `json:"expiresAt"`
	LicenseEndsAt  *string `json:"licenseEndsAt"`
	GraceDays      int     `json:"graceDays"`
}

// File is the package's config/license.json and the appliance's shared current-token file.
type File struct {
	SchemaVersion int     `json:"schemaVersion"`
	Token         *string `json:"token"`
	KeyID         string  `json:"keyId,omitempty"`
	PublicKeyPEM  string  `json:"publicKeyPem,omitempty"`
	// Revoked is set by the agent when the Control Plane answered that the license is inactive.
	Revoked       bool    `json:"revoked,omitempty"`
	RevokedReason string  `json:"revokedReason,omitempty"`
	Source        string  `json:"source,omitempty"` // package | heartbeat | enrollment
	UpdatedAt     *string `json:"updatedAt,omitempty"`
}

// Status is the verification outcome (mirrors @psacc/contracts applianceLicenseStatusSchema).
type Status struct {
	State          string  `json:"state"` // valid | grace | expired | missing | invalid | mismatch | revoked
	LicenseCode    *string `json:"licenseCode"`
	KeyID          *string `json:"keyId"`
	KeySource      string  `json:"keySource"` // image | package | none
	TokenExpiresAt *string `json:"tokenExpiresAt"`
	LicenseEndsAt  *string `json:"licenseEndsAt"`
	VerifiedAt     string  `json:"verifiedAt"`
	PSAWorkAllowed bool    `json:"psaWorkAllowed"`
	Detail         string  `json:"detail"`
}

// Key is a verification key with its id (first 16 hex of the SHA-256 of the SPKI DER).
type Key struct {
	Public ed25519.PublicKey
	ID     string
	Source string
}

// EmbeddedKey returns the key pinned into this binary, or nil when the image was built without one.
func EmbeddedKey() *Key {
	if EmbeddedPublicKeyB64 == "" {
		return nil
	}
	der, err := base64.StdEncoding.DecodeString(EmbeddedPublicKeyB64)
	if err != nil {
		return nil
	}
	k, err := keyFromSPKI(der)
	if err != nil {
		return nil
	}
	k.Source = "image"
	return k
}

// KeyFromPEM parses a PEM public key (the package copy).
func KeyFromPEM(pemText string) (*Key, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, errors.New("not a PEM public key")
	}
	k, err := keyFromSPKI(block.Bytes)
	if err != nil {
		return nil, err
	}
	k.Source = "package"
	return k, nil
}

func keyFromSPKI(der []byte) (*Key, error) {
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("not an Ed25519 key")
	}
	sum := sha256.Sum256(der)
	return &Key{Public: pub, ID: hex.EncodeToString(sum[:])[:16]}, nil
}

// Parse splits a token and checks its signature with the key. It does not evaluate the binding or dates.
func Parse(token string, key *Key) (*Claims, error) {
	if key == nil {
		return nil, errors.New("no verification key")
	}
	if !strings.HasPrefix(token, Prefix) {
		return nil, errors.New("not a license token")
	}
	rest := token[len(Prefix):]
	dot := strings.IndexByte(rest, '.')
	if dot <= 0 || dot == len(rest)-1 {
		return nil, errors.New("malformed license token")
	}
	segment, sigB64 := rest[:dot], rest[dot+1:]
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, errors.New("malformed license token signature")
	}
	if !ed25519.Verify(key.Public, []byte(segment), sig) {
		return nil, errors.New("signature does not verify")
	}
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return nil, errors.New("malformed license token claims")
	}
	var c Claims
	if err := json.Unmarshal(raw, &c); err != nil || c.V != 1 {
		return nil, errors.New("unreadable license token claims")
	}
	return &c, nil
}

// Evaluate turns a token file into a Status for this deployment and installation at `now`.
func Evaluate(f *File, key *Key, deploymentID, installationID string, now time.Time) Status {
	st := Status{State: "missing", KeySource: "none", VerifiedAt: now.UTC().Format(time.RFC3339), PSAWorkAllowed: false, Detail: "No license token on this appliance."}
	if key != nil {
		st.KeySource = key.Source
		id := key.ID
		st.KeyID = &id
	}
	if f == nil {
		return st
	}
	if f.Revoked {
		st.State = "revoked"
		st.Detail = "The Control Plane reported the license as inactive"
		if reason := strings.TrimSuffix(strings.TrimSpace(f.RevokedReason), "."); reason != "" {
			st.Detail += ": " + reason // the Control Plane's reasons are sentences of their own
		}
		st.Detail += "."
		return st
	}
	if f.Token == nil || *f.Token == "" {
		return st
	}
	if key == nil {
		st.State = "invalid"
		st.Detail = "This image carries no license verification key and the package shipped none."
		return st
	}
	c, err := Parse(*f.Token, key)
	if err != nil {
		st.State = "invalid"
		st.Detail = "The license token does not verify: " + err.Error() + "."
		return st
	}
	code := c.LicenseCode
	st.LicenseCode = &code
	st.LicenseEndsAt = c.LicenseEndsAt
	exp, err := time.Parse(time.RFC3339Nano, c.ExpiresAt)
	if err != nil {
		st.State = "invalid"
		st.Detail = "The license token has an unreadable expiry."
		return st
	}
	expS := exp.UTC().Format(time.RFC3339)
	st.TokenExpiresAt = &expS
	if c.KeyID != key.ID {
		st.State = "invalid"
		st.Detail = fmt.Sprintf("The token was signed with key %s but this appliance trusts %s.", c.KeyID, key.ID)
		return st
	}
	if c.DeploymentID != deploymentID || c.InstallationID != installationID {
		st.State = "mismatch"
		st.Detail = fmt.Sprintf("The token is bound to deployment %s / another installation, not to this appliance.", c.DeploymentCode)
		return st
	}
	if c.LicenseEndsAt != nil {
		if end, err := time.Parse("2006-01-02", *c.LicenseEndsAt); err == nil && !now.Before(end.Add(24*time.Hour)) {
			st.State = "expired"
			st.Detail = fmt.Sprintf("License %s ended on %s.", code, *c.LicenseEndsAt)
			return st
		}
	}
	if now.Before(exp) {
		st.State = "valid"
		st.PSAWorkAllowed = true
		st.Detail = fmt.Sprintf("License %s; token renewed by the Control Plane, valid until %s.", code, expS)
		return st
	}
	graceEnd := exp.Add(time.Duration(c.GraceDays) * 24 * time.Hour)
	if now.Before(graceEnd) {
		st.State = "grace"
		st.PSAWorkAllowed = true
		st.Detail = fmt.Sprintf("The token expired on %s; the Control Plane has not renewed it. PSA work continues until %s.", expS, graceEnd.UTC().Format(time.RFC3339))
		return st
	}
	st.State = "expired"
	st.Detail = fmt.Sprintf("The token expired on %s and its grace period ended on %s; the Control Plane has not renewed it.", expS, graceEnd.UTC().Format(time.RFC3339))
	return st
}

// ReadFile loads a license file; a missing file yields (nil, nil).
func ReadFile(path string) (*File, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var f File
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &f, nil
}

// WriteFile stores a license file atomically (mode 0644: the worker and the local admin read it).
func WriteFile(path string, f *File) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// KeyFor picks the verification key: the pinned image key, else the package copy (reported as such).
func KeyFor(packageFile *File) *Key {
	if k := EmbeddedKey(); k != nil {
		return k
	}
	if packageFile != nil && packageFile.PublicKeyPEM != "" {
		if k, err := KeyFromPEM(packageFile.PublicKeyPEM); err == nil {
			return k
		}
	}
	return nil
}

// Current evaluates the appliance's license: the shared current-token file (kept fresh by the agent)
// when present, otherwise the package file. Both paths are the compose mounts / shared volume.
func Current(packagePath, currentPath, deploymentID, installationID string, now time.Time) Status {
	pkg, _ := ReadFile(packagePath)
	cur, _ := ReadFile(currentPath)
	f := cur
	if f == nil {
		f = pkg
	}
	return Evaluate(f, KeyFor(pkg), deploymentID, installationID, now)
}
