package agent

import (
	"context"
	"strings"
	"time"

	"psacc.local/edge/internal/inventory"
)

// Schema details (Database Explorer) are larger than the other reports, so they are sent as a
// snapshot split into parts: when the inventory fingerprint changes, again every schemaResend, and
// retried every schemaRetry until the Control Plane has acknowledged the current fingerprint.
const (
	schemaPartTables = 25
	schemaResend     = 6 * time.Hour
	schemaRetry      = 5 * time.Minute
)

// schemaDue decides whether a schema snapshot with fingerprint fp should be collected now.
func schemaDue(s State, fp string, now time.Time) bool {
	if fp == "" {
		return false
	}
	since := time.Duration(1 << 62)
	if s.SchemaAttemptAt != nil {
		since = now.Sub(*s.SchemaAttemptAt)
	}
	if s.SchemaDeliveredFingerprint != fp {
		return s.SchemaAttemptFingerprint != fp || since >= schemaRetry
	}
	return since >= schemaResend
}

// printable bounds catalog DDL text (index definitions, column defaults) to printable ASCII, as the
// Control Plane's strict schema requires. It is schema text, never a row value.
func printable(s string, max int) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r > 0x7e {
			r = '?'
		}
		if b.Len() >= max {
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

func int64OrNil(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func strs(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func tablePayload(t inventory.TableSchema) map[string]any {
	cols := make([]map[string]any, 0, len(t.Columns))
	for _, c := range t.Columns {
		var def any
		if c.Default != nil {
			def = printable(*c.Default, 200)
		}
		cols = append(cols, map[string]any{"position": c.Position, "name": c.Name, "type": printable(c.Type, 100), "nullable": c.Nullable, "default": def, "identity": c.Identity})
	}
	var pk any
	if t.PrimaryKey != nil {
		pk = map[string]any{"name": t.PrimaryKey.Name, "columns": strs(t.PrimaryKey.Columns)}
	}
	idx := make([]map[string]any, 0, len(t.Indexes))
	for _, i := range t.Indexes {
		idx = append(idx, map[string]any{"name": i.Name, "unique": i.Unique, "primary": i.Primary, "definition": printable(i.Definition, 500), "sizeBytes": i.SizeBytes})
	}
	fks := make([]map[string]any, 0, len(t.ForeignKeys))
	for _, f := range t.ForeignKeys {
		fks = append(fks, map[string]any{"name": f.Name, "columns": strs(f.Columns), "referencedSchema": f.ReferencedSchema, "referencedTable": f.ReferencedTable, "referencedColumns": strs(f.ReferencedColumns), "onDelete": f.OnDelete})
	}
	s := t.Stats
	return map[string]any{
		"schema": t.Schema, "name": t.Name, "kind": t.Kind, "columns": cols, "primaryKey": pk, "indexes": idx, "foreignKeys": fks,
		"stats": map[string]any{
			"estimatedRows": int64OrNil(s.EstimatedRows), "liveRows": int64OrNil(s.LiveRows), "deadRows": int64OrNil(s.DeadRows),
			"lastAnalyzeAt": tsOrNil(s.LastAnalyzeAt), "lastAutoanalyzeAt": tsOrNil(s.LastAutoanalyzeAt), "lastVacuumAt": tsOrNil(s.LastVacuumAt), "lastAutovacuumAt": tsOrNil(s.LastAutovacuumAt),
			"totalBytes": s.TotalBytes, "tableBytes": s.TableBytes, "indexBytes": s.IndexBytes, "toastBytes": s.ToastBytes,
		},
	}
}

// schemaBatches splits a snapshot into database_schema reports of at most schemaPartTables tables,
// one outbox batch each (the gateway accepts 256 KB per batch).
func schemaBatches(fp string, tables []inventory.TableSchema, now time.Time) [][]ReportItem {
	parts := (len(tables) + schemaPartTables - 1) / schemaPartTables
	if parts == 0 {
		parts = 1
	}
	var out [][]ReportItem
	for p := 1; p <= parts; p++ {
		chunk := tables[(p-1)*schemaPartTables : min(p*schemaPartTables, len(tables))]
		ts := make([]map[string]any, 0, len(chunk))
		for _, t := range chunk {
			ts = append(ts, tablePayload(t))
		}
		out = append(out, []ReportItem{{SchemaVersion: 1, Type: "database_schema", ObservedAt: now, Payload: map[string]any{"fingerprint": fp, "part": p, "parts": parts, "tables": ts}}})
	}
	return out
}

// collectSchema stores a schema snapshot in the outbox when one is due for the given inventory.
func (a *Agent) collectSchema(ctx context.Context, db inventory.Database, now time.Time) {
	if a.Pool == nil || !db.Available {
		return
	}
	fp := inventory.Fingerprint(db)
	s := a.LoadState()
	if !schemaDue(s, fp, now) {
		return
	}
	tables, err := inventory.CollectSchema(ctx, a.Pool)
	if err != nil {
		a.Log.Warn("schema inspection failed", "err", redactErr(err))
		return
	}
	s = a.LoadState()
	s.SchemaAttemptFingerprint, s.SchemaAttemptAt = fp, &now
	_ = a.SaveState(s)
	for i, batch := range schemaBatches(fp, tables, now) {
		if _, err := a.store(batch, i+1); err != nil {
			a.Log.Warn("schema report not stored", "err", err)
		}
	}
	a.Log.Info("schema snapshot collected", "tables", len(tables), "fingerprint", fp)
}

// markSchemaDelivered records that the Control Plane accepted a batch carrying this fingerprint.
func (a *Agent) markSchemaDelivered(fp string) {
	s := a.LoadState()
	if s.SchemaDeliveredFingerprint == fp {
		return
	}
	s.SchemaDeliveredFingerprint = fp
	_ = a.SaveState(s)
}
