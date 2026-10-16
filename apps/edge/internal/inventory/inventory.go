// Package inventory describes the database from the PostgreSQL catalog only. It runs as the
// inspector role, which has no privileges on any table, so it can never read ticket content.
package inventory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Table struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	// Nil until PostgreSQL has analysed the table (reltuples = -1).
	EstimatedRows *int64 `json:"estimatedRows"`
	SizeBytes     int64  `json:"sizeBytes"`
	Columns       int    `json:"columns"`
	HasPrimaryKey bool   `json:"hasPrimaryKey"`
	Indexes       int    `json:"indexes"`
	ForeignKeys   int    `json:"foreignKeys"`
}

type Database struct {
	Available         bool       `json:"available"`
	DatabaseName      string     `json:"databaseName,omitempty"`
	ServerVersion     string     `json:"serverVersion,omitempty"`
	SchemaVersion     string     `json:"schemaVersion,omitempty"`
	MigrationsApplied int        `json:"migrationsApplied"`
	LastMigratedAt    *time.Time `json:"lastMigratedAt,omitempty"`
	SizeBytes         int64      `json:"sizeBytes"`
	Tables            []Table    `json:"tables"`
	Error             string     `json:"error,omitempty"`
}

// Collect returns availability, versions and the table inventory. Row counts are PostgreSQL's
// estimates (nil when never analysed); exact counts would need table access, which the inspector lacks.
func Collect(ctx context.Context, pool *pgxpool.Pool) Database {
	d := Database{Tables: []Table{}}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.QueryRow(ctx, `SELECT current_database(), current_setting('server_version'), pg_database_size(current_database())`).Scan(&d.DatabaseName, &d.ServerVersion, &d.SizeBytes); err != nil {
		d.Error = "database_unavailable"
		return d
	}
	d.Available = true
	var ver *string
	var at *time.Time
	if err := pool.QueryRow(ctx, `SELECT schema_version, migrations_applied, last_applied_at FROM edge_schema_status()`).Scan(&ver, &d.MigrationsApplied, &at); err == nil {
		if ver != nil {
			d.SchemaVersion = *ver
		}
		d.LastMigratedAt = at
	} else {
		d.Error = "schema_status_unavailable"
	}
	rows, err := pool.Query(ctx, `
		SELECT n.nspname, c.relname, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, pg_total_relation_size(c.oid),
		       (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::int,
		       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p'),
		       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)::int,
		       (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f')::int
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
		ORDER BY c.relname`)
	if err != nil {
		d.Error = "inventory_unavailable"
		return d
	}
	defer rows.Close()
	for rows.Next() {
		var t Table
		if err := rows.Scan(&t.Schema, &t.Name, &t.EstimatedRows, &t.SizeBytes, &t.Columns, &t.HasPrimaryKey, &t.Indexes, &t.ForeignKeys); err != nil {
			d.Error = "inventory_unavailable"
			return d
		}
		d.Tables = append(d.Tables, t)
	}
	return d
}

// Fingerprint identifies a schema snapshot: the schema version and, per table, the column, index
// and key counts. It changes whenever a migration runs or a table's shape changes, so the agent
// knows when to send the schema details again.
func Fingerprint(d Database) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s|%d|", d.SchemaVersion, d.MigrationsApplied)
	for _, t := range d.Tables {
		fmt.Fprintf(&b, "%s.%s:%d:%t:%d:%d;", t.Schema, t.Name, t.Columns, t.HasPrimaryKey, t.Indexes, t.ForeignKeys)
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:16])
}

// ---- per-table schema (Database Explorer) ----

type Column struct {
	Position int     `json:"position"`
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default"`
	Identity bool    `json:"identity"`
}

type PrimaryKey struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
}

type Index struct {
	Name       string `json:"name"`
	Unique     bool   `json:"unique"`
	Primary    bool   `json:"primary"`
	Definition string `json:"definition"`
	SizeBytes  int64  `json:"sizeBytes"`
}

type ForeignKey struct {
	Name              string   `json:"name"`
	Columns           []string `json:"columns"`
	ReferencedSchema  string   `json:"referencedSchema"`
	ReferencedTable   string   `json:"referencedTable"`
	ReferencedColumns []string `json:"referencedColumns"`
	OnDelete          string   `json:"onDelete"`
}

// Stats is row-count metadata: planner estimates and statistics. Never an exact count — the
// inspector cannot run one.
type Stats struct {
	EstimatedRows     *int64     `json:"estimatedRows"`
	LiveRows          *int64     `json:"liveRows"`
	DeadRows          *int64     `json:"deadRows"`
	LastAnalyzeAt     *time.Time `json:"lastAnalyzeAt"`
	LastAutoanalyzeAt *time.Time `json:"lastAutoanalyzeAt"`
	LastVacuumAt      *time.Time `json:"lastVacuumAt"`
	LastAutovacuumAt  *time.Time `json:"lastAutovacuumAt"`
	TotalBytes        int64      `json:"totalBytes"`
	TableBytes        int64      `json:"tableBytes"`
	IndexBytes        int64      `json:"indexBytes"`
	ToastBytes        int64      `json:"toastBytes"`
}

type TableSchema struct {
	Schema      string       `json:"schema"`
	Name        string       `json:"name"`
	Kind        string       `json:"kind"` // table | partitioned
	Columns     []Column     `json:"columns"`
	PrimaryKey  *PrimaryKey  `json:"primaryKey"`
	Indexes     []Index      `json:"indexes"`
	ForeignKeys []ForeignKey `json:"foreignKeys"`
	Stats       Stats        `json:"stats"`
}

var onDelete = map[string]string{"a": "no_action", "r": "restrict", "c": "cascade", "n": "set_null", "d": "set_default"}

// CollectSchema reads every public table's columns, primary key, indexes, foreign keys and
// statistics from pg_catalog (four catalog-wide queries). Definitions are DDL text from
// pg_get_indexdef / pg_get_expr, never data.
func CollectSchema(ctx context.Context, pool *pgxpool.Pool) ([]TableSchema, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	byName := map[string]*TableSchema{}
	var order []string
	get := func(schema, name string) *TableSchema {
		k := schema + "." + name
		t, ok := byName[k]
		if !ok {
			t = &TableSchema{Schema: schema, Name: name, Kind: "table", Columns: []Column{}, Indexes: []Index{}, ForeignKeys: []ForeignKey{}}
			byName[k] = t
			order = append(order, k)
		}
		return t
	}

	rows, err := pool.Query(ctx, `
		SELECT n.nspname, c.relname, c.relkind, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END,
		       s.n_live_tup, s.n_dead_tup, s.last_analyze, s.last_autoanalyze, s.last_vacuum, s.last_autovacuum,
		       pg_total_relation_size(c.oid), pg_relation_size(c.oid), pg_indexes_size(c.oid),
		       CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var schema, name, kind string
		var st Stats
		if err := rows.Scan(&schema, &name, &kind, &st.EstimatedRows, &st.LiveRows, &st.DeadRows, &st.LastAnalyzeAt, &st.LastAutoanalyzeAt, &st.LastVacuumAt, &st.LastAutovacuumAt,
			&st.TotalBytes, &st.TableBytes, &st.IndexBytes, &st.ToastBytes); err != nil {
			rows.Close()
			return nil, err
		}
		t := get(schema, name)
		if kind == "p" {
			t.Kind = "partitioned"
		}
		t.Stats = st
	}
	rows.Close()

	rows, err = pool.Query(ctx, `
		SELECT n.nspname, c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
		       pg_get_expr(d.adbin, d.adrelid), a.attidentity <> ''
		FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY c.relname, a.attnum`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var schema, name string
		var c Column
		if err := rows.Scan(&schema, &name, &c.Position, &c.Name, &c.Type, &c.Nullable, &c.Default, &c.Identity); err != nil {
			rows.Close()
			return nil, err
		}
		t := get(schema, name)
		t.Columns = append(t.Columns, c)
	}
	rows.Close()

	rows, err = pool.Query(ctx, `
		SELECT n.nspname, c.relname, k.conname, k.contype,
		       (SELECT array_agg(a.attname ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum),
		       coalesce(rn.nspname, ''), coalesce(rc.relname, ''),
		       (SELECT array_agg(a.attname ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum),
		       k.confdeltype::text
		FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_class rc ON rc.oid = k.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND k.contype IN ('p', 'f')
		ORDER BY c.relname, k.conname`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var schema, name, conname, contype, refSchema, refTable, del string
		var cols, refCols []string
		if err := rows.Scan(&schema, &name, &conname, &contype, &cols, &refSchema, &refTable, &refCols, &del); err != nil {
			rows.Close()
			return nil, err
		}
		t := get(schema, name)
		if contype == "p" {
			t.PrimaryKey = &PrimaryKey{Name: conname, Columns: cols}
		} else {
			action := onDelete[del]
			if action == "" {
				action = "no_action"
			}
			if refCols == nil {
				refCols = []string{}
			}
			t.ForeignKeys = append(t.ForeignKeys, ForeignKey{Name: conname, Columns: cols, ReferencedSchema: refSchema, ReferencedTable: refTable, ReferencedColumns: refCols, OnDelete: action})
		}
	}
	rows.Close()

	rows, err = pool.Query(ctx, `
		SELECT n.nspname, c.relname, ic.relname, i.indisunique, i.indisprimary, pg_get_indexdef(i.indexrelid), pg_relation_size(i.indexrelid)
		FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname, ic.relname`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var schema, name string
		var ix Index
		if err := rows.Scan(&schema, &name, &ix.Name, &ix.Unique, &ix.Primary, &ix.Definition, &ix.SizeBytes); err != nil {
			rows.Close()
			return nil, err
		}
		t := get(schema, name)
		t.Indexes = append(t.Indexes, ix)
	}
	rows.Close()

	out := make([]TableSchema, 0, len(order))
	for _, k := range order {
		out = append(out, *byName[k])
	}
	return out, nil
}
