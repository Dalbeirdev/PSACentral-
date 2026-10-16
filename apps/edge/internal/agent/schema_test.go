package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"psacc.local/edge/internal/inventory"
)

func TestSchemaSnapshotsAreDueOnChangeAndRetriedUntilAcknowledged(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { x := now.Add(-d); return &x }
	cases := []struct {
		name string
		s    State
		fp   string
		want bool
	}{
		{"never collected", State{}, "fp1", true},
		{"no fingerprint (database unavailable)", State{}, "", false},
		{"attempted a minute ago, not yet acknowledged", State{SchemaAttemptFingerprint: "fp1", SchemaAttemptAt: ago(time.Minute)}, "fp1", false},
		{"attempted 6 minutes ago, still not acknowledged", State{SchemaAttemptFingerprint: "fp1", SchemaAttemptAt: ago(6 * time.Minute)}, "fp1", true},
		{"acknowledged an hour ago", State{SchemaAttemptFingerprint: "fp1", SchemaAttemptAt: ago(time.Hour), SchemaDeliveredFingerprint: "fp1"}, "fp1", false},
		{"acknowledged 7 hours ago: periodic resend", State{SchemaAttemptFingerprint: "fp1", SchemaAttemptAt: ago(7 * time.Hour), SchemaDeliveredFingerprint: "fp1"}, "fp1", true},
		{"schema changed since the acknowledged snapshot", State{SchemaAttemptFingerprint: "fp1", SchemaAttemptAt: ago(time.Minute), SchemaDeliveredFingerprint: "fp1"}, "fp2", true},
	}
	for _, c := range cases {
		if got := schemaDue(c.s, c.fp, now); got != c.want {
			t.Errorf("%s: due=%v, want %v", c.name, got, c.want)
		}
	}
}

func TestFingerprintFollowsTheShapeOfTheSchema(t *testing.T) {
	rows := int64(3)
	d := inventory.Database{SchemaVersion: "0002", MigrationsApplied: 2, Tables: []inventory.Table{{Schema: "public", Name: "helpdesk_tickets", EstimatedRows: &rows, Columns: 17, HasPrimaryKey: true, Indexes: 4, ForeignKeys: 1}}}
	a := inventory.Fingerprint(d)
	if len(a) != 32 || a != inventory.Fingerprint(d) {
		t.Fatalf("fingerprint %q is not a stable 32-hex value", a)
	}
	more := int64(4000)
	d.Tables[0].EstimatedRows, d.Tables[0].SizeBytes = &more, 99 // data growth is not a schema change
	if inventory.Fingerprint(d) != a {
		t.Fatal("row estimates and size must not change the fingerprint")
	}
	d.Tables[0].Columns = 18
	if inventory.Fingerprint(d) == a {
		t.Fatal("a new column must change the fingerprint")
	}
}

func TestSchemaBatchesCarryOnlyCatalogMetadataInBoundedParts(t *testing.T) {
	def := "now()"
	var tables []inventory.TableSchema
	for i := 0; i < schemaPartTables+3; i++ {
		tables = append(tables, inventory.TableSchema{
			Schema: "public", Name: "t" + string(rune('a'+i%26)), Kind: "table",
			Columns:     []inventory.Column{{Position: 1, Name: "id", Type: "uuid", Nullable: false, Default: &def, Identity: false}, {Position: 2, Name: "body", Type: "text", Nullable: true}},
			PrimaryKey:  &inventory.PrimaryKey{Name: "t_pkey", Columns: []string{"id"}},
			Indexes:     []inventory.Index{{Name: "t_pkey", Unique: true, Primary: true, Definition: "CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)\n\ttrailing", SizeBytes: 8192}},
			ForeignKeys: []inventory.ForeignKey{{Name: "t_fk", Columns: []string{"ref"}, ReferencedSchema: "public", ReferencedTable: "u", ReferencedColumns: []string{"id"}, OnDelete: "cascade"}},
			Stats:       inventory.Stats{TotalBytes: 40960, TableBytes: 8192, IndexBytes: 32768},
		})
	}
	now := time.Now().UTC()
	batches := schemaBatches("ab"+strings.Repeat("0", 30), tables, now)
	if len(batches) != 2 {
		t.Fatalf("want 2 parts for %d tables, got %d", len(tables), len(batches))
	}
	for i, b := range batches {
		if len(b) != 1 || b[0].Type != "database_schema" {
			t.Fatalf("batch %d: %+v", i, b)
		}
		p := b[0].Payload
		if p["part"] != i+1 || p["parts"] != 2 {
			t.Fatalf("batch %d has part %v of %v", i, p["part"], p["parts"])
		}
		raw, _ := json.Marshal(p)
		s := string(raw)
		for _, forbidden := range []string{`"rows"`, `"sample"`, `"records"`, `"value"`} {
			if strings.Contains(s, forbidden) {
				t.Fatalf("schema payload must not carry %s", forbidden)
			}
		}
		if strings.Contains(s, "\\n") || strings.Contains(s, "\\t") {
			t.Fatal("index definitions must be bounded printable ASCII")
		}
		for _, key := range []string{`"columns"`, `"primaryKey"`, `"indexes"`, `"foreignKeys"`, `"stats"`, `"estimatedRows":null`, `"default":"now()"`, `"onDelete":"cascade"`} {
			if !strings.Contains(s, key) {
				t.Fatalf("schema payload lacks %s", key)
			}
		}
	}
	if n := len(batches[0][0].Payload["tables"].([]map[string]any)); n != schemaPartTables {
		t.Fatalf("first part holds %d tables, want %d", n, schemaPartTables)
	}
	if got := printable("abc\x00é"+strings.Repeat("x", 10), 6); got != "abc??x" {
		t.Fatalf("printable: %q", got)
	}
}

func TestDeliveryAcknowledgesTheSchemaFingerprint(t *testing.T) {
	a := newAgent(t, time.Now().Add(time.Hour))
	now := time.Now().UTC()
	s := a.LoadState()
	s.SchemaAttemptFingerprint, s.SchemaAttemptAt = "fp1", &now // collected and stored in the outbox
	if err := a.SaveState(s); err != nil {
		t.Fatal(err)
	}
	if !schemaDue(a.LoadState(), "fp1", now.Add(schemaRetry)) {
		t.Fatal("an unacknowledged snapshot is retried")
	}
	a.markSchemaDelivered("fp1")
	if s := a.LoadState(); s.SchemaDeliveredFingerprint != "fp1" || s.State != "pending" {
		t.Fatalf("state after acknowledgement: %+v", s)
	}
	if schemaDue(a.LoadState(), "fp1", now.Add(schemaRetry)) {
		t.Fatal("an acknowledged fingerprint is not due again until the periodic resend")
	}
}
