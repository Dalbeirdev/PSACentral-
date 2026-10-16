package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sample = `{
  "schemaVersion": 1,
  "deployment": {"id": "11111111-1111-4111-8111-111111111111", "code": "DEP-00042", "installationId": "44444444-4444-4444-8444-444444444444", "packageNumber": 2, "generatedAt": "2026-10-14T12:00:00.000Z"},
  "client": {"id": "22222222-2222-4222-8222-222222222222", "code": "CL-00027", "displayName": "Test Client A"},
  "psa": {"instanceId": "33333333-3333-4333-8333-333333333333", "instanceCode": "PSA-00030", "provider": "autotask", "displayName": "A — Autotask",
          "authMethod": "api_user", "apiEndpoint": "https://webservices5.autotask.net/ATServicesRest", "config": {"zone": "webservices5"},
          "credentialFields": [{"key": "username", "label": "API user", "secret": false}, {"key": "secret", "label": "API secret", "secret": true}]},
  "services": [{"key": "help_desk", "name": "Help Desk", "usesPsa": true}],
  "controlPlane": {"agentGatewayUrl": "https://gateway.example.test", "heartbeatIntervalSeconds": 60, "reports": ["database"]},
  "image": {"repository": "psacc/psa-edge", "version": "0.1.0", "digest": null},
  "target": {"environment": "linux_docker", "os": "linux", "arch": "amd64", "hostLabel": null}
}`

func write(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadEdgeAcceptsThePackageFormat(t *testing.T) {
	cfg, err := LoadEdge(write(t, "edge.json", sample))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Deployment.Code != "DEP-00042" || cfg.PSA.Provider != "autotask" || len(cfg.PSA.CredentialFields) != 2 || cfg.ControlPlane.HeartbeatIntervalSeconds != 60 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadEdgeRejectsUnsafeOrBrokenConfiguration(t *testing.T) {
	cases := map[string]string{
		"schemaVersion":    `"schemaVersion": 2`,
		"deployment.code":  `"code": "DEP-1"`,
		"psa.provider":     `"provider": "jira"`,
		"psa.apiEndpoint":  `"apiEndpoint": "http://plain.example"`,
		"agentGatewayUrl":  `"agentGatewayUrl": "http://gateway.example.test"`,
		"credential field": `"key": "user name"`,
		"heartbeat":        `"heartbeatIntervalSeconds": 5`,
	}
	repl := map[string]string{
		"schemaVersion": `"schemaVersion": 1`, "deployment.code": `"code": "DEP-00042"`, "psa.provider": `"provider": "autotask"`,
		"psa.apiEndpoint": `"apiEndpoint": "https://webservices5.autotask.net/ATServicesRest"`, "agentGatewayUrl": `"agentGatewayUrl": "https://gateway.example.test"`,
		"credential field": `"key": "username"`, "heartbeat": `"heartbeatIntervalSeconds": 60`,
	}
	for name, bad := range cases {
		body := strings.Replace(sample, repl[name], bad, 1)
		if body == sample {
			t.Fatalf("%s: replacement did not apply", name)
		}
		if _, err := LoadEdge(write(t, "edge.json", body)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestSecretsAndDataKey(t *testing.T) {
	dir := t.TempDir()
	s := Secrets{Dir: dir}
	if _, err := s.Read("app_db_password"); err == nil || !strings.Contains(err.Error(), "install.sh") {
		t.Fatalf("missing secret should point to the install script, got %v", err)
	}
	_ = os.WriteFile(filepath.Join(dir, "data_key"), []byte(base64.StdEncoding.EncodeToString(make([]byte, 16))+"\n"), 0o600)
	if _, err := s.DataKey(); err == nil {
		t.Fatal("a 16-byte key must be rejected")
	}
	_ = os.WriteFile(filepath.Join(dir, "data_key"), []byte(base64.StdEncoding.EncodeToString(make([]byte, 32))+"\n"), 0o600)
	if k, err := s.DataKey(); err != nil || len(k) != 32 {
		t.Fatalf("32-byte key: %v", err)
	}
}

func TestLoadEnrollment(t *testing.T) {
	ok := `{"schemaVersion":1,"deploymentId":"x","deploymentCode":"DEP-00042","installationId":"y","agentGatewayUrl":"https://g","token":"psacc_enr_abc","expiresAt":"2026-10-15T12:00:00.000Z"}`
	en, err := LoadEnrollment(write(t, "enrollment.json", ok))
	if err != nil || en.ExpiresAt.IsZero() {
		t.Fatalf("enrollment: %v", err)
	}
	if _, err := LoadEnrollment(write(t, "enrollment.json", strings.Replace(ok, "psacc_enr_abc", "nope", 1))); err == nil {
		t.Fatal("a token without the psacc_enr_ prefix must be rejected")
	}
}
