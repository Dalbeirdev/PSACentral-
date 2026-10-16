package migrate

import (
	"regexp"
	"strings"
	"testing"
)

func TestMigrationsAreOrderedChecksummedAndCreateEveryRequiredTable(t *testing.T) {
	migs, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(migs) == 0 || migs[0].Version != "0001" {
		t.Fatalf("unexpected migrations: %+v", migs)
	}
	for i, m := range migs {
		if len(m.Checksum) != 64 {
			t.Errorf("%s: checksum %q", m.Version, m.Checksum)
		}
		if i > 0 && migs[i-1].Version >= m.Version {
			t.Errorf("migrations out of order at %s", m.Version)
		}
	}
	all := ""
	for _, m := range migs {
		all += m.SQL
	}
	for _, table := range RequiredTables {
		if table == "schema_migrations" {
			continue // created by the migrator itself before any migration runs
		}
		if !regexp.MustCompile(`(?m)^CREATE TABLE ` + table + ` \(`).MatchString(all) {
			t.Errorf("no migration creates %s", table)
		}
	}
}

func TestInspectorRoleIsNeverGrantedTables(t *testing.T) {
	migs, _ := Load()
	for _, m := range migs {
		for _, line := range strings.Split(m.SQL, "\n") {
			l := strings.ToUpper(line)
			if strings.HasPrefix(strings.TrimSpace(l), "GRANT") && strings.Contains(l, "PSA_EDGE_INSPECTOR") && !strings.Contains(l, "EXECUTE ON FUNCTION") {
				t.Errorf("%s grants the inspector something other than a metadata function: %s", m.Version, line)
			}
		}
	}
}

func TestAuditAndLogsAreAppendOnlyForTheApplication(t *testing.T) {
	migs, _ := Load()
	sql := migs[0].SQL
	if !strings.Contains(sql, "GRANT SELECT, INSERT ON audit_events, integration_logs TO psa_edge_app;") {
		t.Fatal("audit_events and integration_logs must be INSERT/SELECT only for the application role")
	}
	if !strings.Contains(sql, "psa_connections_verified_requires_test") {
		t.Fatal("a PSA connection must not be marked verified without a test")
	}
}
