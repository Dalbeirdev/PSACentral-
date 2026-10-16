// Package config loads the appliance configuration written by the Control Plane into the
// deployment package (config/edge.json, schema version 1) and the secrets generated on this host.
package config

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Edge is config/edge.json (see packages/contracts EdgeConfigV1).
type Edge struct {
	SchemaVersion int `json:"schemaVersion"`
	Deployment    struct {
		ID             string `json:"id"`
		Code           string `json:"code"`
		InstallationID string `json:"installationId"`
		PackageNumber  int    `json:"packageNumber"`
		GeneratedAt    string `json:"generatedAt"`
	} `json:"deployment"`
	Client struct {
		ID          string `json:"id"`
		Code        string `json:"code"`
		DisplayName string `json:"displayName"`
	} `json:"client"`
	PSA struct {
		InstanceID       string            `json:"instanceId"`
		InstanceCode     string            `json:"instanceCode"`
		Provider         string            `json:"provider"`
		DisplayName      string            `json:"displayName"`
		AuthMethod       *string           `json:"authMethod"`
		APIEndpoint      *string           `json:"apiEndpoint"`
		Config           map[string]any    `json:"config"`
		CredentialFields []CredentialField `json:"credentialFields"`
	} `json:"psa"`
	Services []struct {
		Key      string         `json:"key"`
		Name     string         `json:"name"`
		UsesPSA  bool           `json:"usesPsa"`
		Settings map[string]any `json:"settings"`
	} `json:"services"`
	ControlPlane struct {
		AgentGatewayURL          string   `json:"agentGatewayUrl"`
		HeartbeatIntervalSeconds int      `json:"heartbeatIntervalSeconds"`
		Reports                  []string `json:"reports"`
	} `json:"controlPlane"`
	Image struct {
		Repository string  `json:"repository"`
		Version    string  `json:"version"`
		Digest     *string `json:"digest"`
	} `json:"image"`
	Target struct {
		Environment string  `json:"environment"`
		OS          string  `json:"os"`
		Arch        string  `json:"arch"`
		HostLabel   *string `json:"hostLabel"`
	} `json:"target"`
	// License is the entitlement identifier the deployment runs under (Module 14). The appliance shows it;
	// entitlement decisions are made by the Control Plane (packages, enrollment, suspension).
	License *struct {
		ID          string  `json:"id"`
		Code        string  `json:"code"`
		DisplayName string  `json:"displayName"`
		EndsAt      *string `json:"endsAt"`
	} `json:"license"`
}

type CredentialField struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
}

// Enrollment is enrollment/enrollment.json. The token is single use and short-lived.
type Enrollment struct {
	SchemaVersion   int       `json:"schemaVersion"`
	DeploymentID    string    `json:"deploymentId"`
	DeploymentCode  string    `json:"deploymentCode"`
	InstallationID  string    `json:"installationId"`
	AgentGatewayURL string    `json:"agentGatewayUrl"`
	CACertificate   string    `json:"caCertificate"`
	CAFingerprint   string    `json:"caFingerprint"`
	Token           string    `json:"token"`
	ExpiresAt       time.Time `json:"expiresAt"`
}

var (
	uuidRe     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	depCodeRe  = regexp.MustCompile(`^DEP-[0-9]{5,}$`)
	psaCodeRe  = regexp.MustCompile(`^PSA-[0-9]{5,}$`)
	serviceKey = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)
	fieldKeyRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`)
)

var providers = map[string]bool{"autotask": true, "connectwise": true, "halopsa": true, "kaseya_bms": true, "freshservice": true, "servicenow": true, "custom_rest": true}

// LoadEdge reads and validates the appliance configuration. Invalid configuration stops the
// appliance with a clear message instead of running half-configured.
func LoadEdge(path string) (*Edge, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read appliance configuration: %w", err)
	}
	var e Edge
	dec := json.NewDecoder(strings.NewReader(string(b)))
	if err := dec.Decode(&e); err != nil {
		return nil, fmt.Errorf("parse appliance configuration %s: %w", path, err)
	}
	return &e, e.Validate()
}

func (e *Edge) Validate() error {
	var problems []string
	add := func(ok bool, msg string) {
		if !ok {
			problems = append(problems, msg)
		}
	}
	add(e.SchemaVersion == 1, fmt.Sprintf("unsupported schemaVersion %d (this appliance reads version 1)", e.SchemaVersion))
	add(uuidRe.MatchString(e.Deployment.ID), "deployment.id must be a UUID")
	add(depCodeRe.MatchString(e.Deployment.Code), "deployment.code must look like DEP-00001")
	add(uuidRe.MatchString(e.Deployment.InstallationID), "deployment.installationId must be a UUID")
	add(uuidRe.MatchString(e.Client.ID), "client.id must be a UUID")
	add(uuidRe.MatchString(e.PSA.InstanceID), "psa.instanceId must be a UUID")
	add(psaCodeRe.MatchString(e.PSA.InstanceCode), "psa.instanceCode must look like PSA-00001")
	add(providers[e.PSA.Provider], fmt.Sprintf("psa.provider %q is not supported", e.PSA.Provider))
	add(e.PSA.APIEndpoint == nil || strings.HasPrefix(*e.PSA.APIEndpoint, "https://"), "psa.apiEndpoint must use https://")
	for _, f := range e.PSA.CredentialFields {
		add(fieldKeyRe.MatchString(f.Key), fmt.Sprintf("credential field key %q is invalid", f.Key))
	}
	for _, s := range e.Services {
		add(serviceKey.MatchString(s.Key), fmt.Sprintf("service key %q is invalid", s.Key))
	}
	add(strings.HasPrefix(e.ControlPlane.AgentGatewayURL, "https://"), "controlPlane.agentGatewayUrl must use https://")
	add(e.ControlPlane.HeartbeatIntervalSeconds >= 15 && e.ControlPlane.HeartbeatIntervalSeconds <= 3600, "controlPlane.heartbeatIntervalSeconds must be 15–3600")
	if len(problems) > 0 {
		return errors.New("invalid appliance configuration: " + strings.Join(problems, "; "))
	}
	return nil
}

func LoadEnrollment(path string) (*Enrollment, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read enrollment file: %w", err)
	}
	var en Enrollment
	if err := json.Unmarshal(b, &en); err != nil {
		return nil, fmt.Errorf("parse enrollment file: %w", err)
	}
	if !strings.HasPrefix(en.Token, "psacc_enr_") || en.ExpiresAt.IsZero() {
		return nil, errors.New("enrollment file is incomplete")
	}
	return &en, nil
}

// Secrets are the files generated on this host by the install script (Compose file secrets).
type Secrets struct{ Dir string }

func (s Secrets) Read(name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(s.Dir, name))
	if err != nil {
		return "", fmt.Errorf("secret %s is missing: run scripts/install.sh on this host first", name)
	}
	v := strings.TrimSpace(string(b))
	if v == "" {
		return "", fmt.Errorf("secret %s is empty", name)
	}
	return v, nil
}

// DataKey is the 32-byte AES key that encrypts PSA credentials on this host.
func (s Secrets) DataKey() ([]byte, error) {
	v, err := s.Read("data_key")
	if err != nil {
		return nil, err
	}
	k, err := base64.StdEncoding.DecodeString(v)
	if err != nil || len(k) != 32 {
		return nil, errors.New("secret data_key must be base64 of exactly 32 bytes")
	}
	return k, nil
}

// Env returns an environment variable or a default.
func Env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
