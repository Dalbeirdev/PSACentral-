package agent

import (
	"time"

	"psacc.local/edge/internal/license"
)

// licenseRenewal is the Control Plane's licensing answer on enrollment and every heartbeat
// (@psacc/contracts LicenseRenewal): a fresh token while the license is active, or why not.
type licenseRenewal struct {
	State       string  `json:"state"` // active | inactive | none
	Token       *string `json:"token"`
	LicenseCode *string `json:"licenseCode"`
	Reason      *string `json:"reason"`
}

const (
	DefaultLicensePackagePath = "/etc/psa-edge/license.json"
	DefaultLicenseCurrentPath = "/var/log/psa-edge/license/current.json"
)

func (a *Agent) licensePackagePath() string {
	if a.LicensePackagePath != "" {
		return a.LicensePackagePath
	}
	return DefaultLicensePackagePath
}

func (a *Agent) licenseCurrentPath() string {
	if a.LicenseCurrentPath != "" {
		return a.LicenseCurrentPath
	}
	return DefaultLicenseCurrentPath
}

// storeLicense records the Control Plane's answer on the shared volume, where the worker and the local
// admin read it: a renewed token, an explicit revocation (`inactive`), or nothing (`none`). A missing
// answer (older Control Plane) leaves the current file untouched.
func (a *Agent) storeLicense(r *licenseRenewal, source string) {
	if r == nil {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	f := &license.File{SchemaVersion: 1, Source: source, UpdatedAt: &now}
	switch r.State {
	case "active":
		if r.Token == nil || *r.Token == "" {
			return
		}
		f.Token = r.Token
	case "inactive":
		f.Revoked = true
		if r.Reason != nil {
			f.RevokedReason = *r.Reason
		}
	default: // none: no license bound
		f.Token = nil
	}
	if err := license.WriteFile(a.licenseCurrentPath(), f); err != nil {
		a.Log.Warn("license token not stored", "err", err)
		return
	}
	if f.Revoked {
		a.Log.Warn("license inactive according to the Control Plane; PSA work stops on this appliance", "reason", f.RevokedReason)
	}
}

// LicenseStatus is the appliance's current verification of its license token (reported to the Control
// Plane and shown in the local admin).
func (a *Agent) LicenseStatus() license.Status {
	return license.Current(a.licensePackagePath(), a.licenseCurrentPath(), a.Cfg.Deployment.ID, a.Cfg.Deployment.InstallationID, time.Now())
}
