// Package migrate initializes and upgrades this appliance's database. It is idempotent: running it
// again (every container start) applies nothing new, keeps all data, and re-verifies the schema.
package migrate

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/db"
)

//go:embed migrations/*.sql
var files embed.FS

// RequiredTables must exist (with a primary key) after migration.
var RequiredTables = []string{
	"app_metadata", "psa_connections", "service_configurations", "helpdesk_tickets", "ticket_events", "sync_runs",
	"audit_events", "schema_migrations", "credential_store", "integration_logs", "backup_runs", "local_admin_users", "psa_connection_tests",
}

type Migration struct {
	Version  string
	Name     string
	SQL      string
	Checksum string
}

var fileRe = regexp.MustCompile(`^(\d{4})_([a-z0-9_]+)\.sql$`)

// Load returns the embedded migrations in order.
func Load() ([]Migration, error) {
	entries, err := fs.ReadDir(files, "migrations")
	if err != nil {
		return nil, err
	}
	var out []Migration
	for _, e := range entries {
		m := fileRe.FindStringSubmatch(e.Name())
		if m == nil {
			return nil, fmt.Errorf("unexpected migration file name %q", e.Name())
		}
		b, err := files.ReadFile("migrations/" + e.Name())
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(b)
		out = append(out, Migration{Version: m[1], Name: m[2], SQL: string(b), Checksum: hex.EncodeToString(sum[:])})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

type Result struct {
	Applied        []string  `json:"applied"`
	SchemaVersion  string    `json:"schemaVersion"`
	Tables         []string  `json:"tables"`
	Verified       bool      `json:"verified"`
	DeploymentCode string    `json:"deploymentCode"`
	FinishedAt     time.Time `json:"finishedAt"`
}

const lockKey = 7_316_440_001 // advisory lock: one migrator at a time

// Up creates roles, applies pending migrations, records this installation's identity and
// configuration, and verifies the schema and role privileges.
func Up(ctx context.Context, cfg *config.Edge, secrets config.Secrets) (*Result, error) {
	owner, err := db.Open(ctx, db.Owner, secrets, 2, 90*time.Second)
	if err != nil {
		return nil, err
	}
	defer owner.Close()
	conn, err := owner.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, lockKey); err != nil {
		return nil, err
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, lockKey) //nolint:errcheck

	if err := ensureRoles(ctx, conn.Conn(), secrets); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
		name text NOT NULL, checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
		applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return nil, err
	}
	if err := guardIdentity(ctx, conn.Conn(), cfg); err != nil {
		return nil, err
	}

	migs, err := Load()
	if err != nil {
		return nil, err
	}
	applied := map[string]string{}
	rows, err := conn.Query(ctx, `SELECT version, checksum FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var v, c string
		if err := rows.Scan(&v, &c); err != nil {
			return nil, err
		}
		applied[v] = c
	}
	rows.Close()

	res := &Result{DeploymentCode: cfg.Deployment.Code}
	for _, m := range migs {
		if sum, ok := applied[m.Version]; ok {
			if sum != m.Checksum {
				return nil, fmt.Errorf("migration %s_%s was changed after it was applied (checksum mismatch); refusing to continue", m.Version, m.Name)
			}
			continue
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, m.SQL); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return nil, fmt.Errorf("migration %s_%s failed: %w", m.Version, m.Name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, m.Version, m.Name, m.Checksum); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		res.Applied = append(res.Applied, m.Version+"_"+m.Name)
	}
	res.SchemaVersion = migs[len(migs)-1].Version

	if err := recordConfiguration(ctx, conn.Conn(), cfg, res); err != nil {
		return nil, err
	}
	tables, err := Verify(ctx, conn.Conn(), secrets)
	if err != nil {
		return nil, err
	}
	res.Tables = tables
	res.Verified = true
	res.FinishedAt = time.Now().UTC()
	if _, err := conn.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('schema.verified_at', $1)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, res.FinishedAt.Format(time.RFC3339)); err != nil {
		return nil, err
	}
	meta, _ := json.Marshal(map[string]any{"applied": res.Applied, "schemaVersion": res.SchemaVersion})
	_, err = conn.Exec(ctx, `INSERT INTO audit_events (actor_type, actor, action, target, outcome, metadata)
		VALUES ('system', 'edge-migrate', 'appliance.migrated', $1, 'success', $2)`, cfg.Deployment.Code, meta)
	return res, err
}

func ensureRoles(ctx context.Context, c *pgx.Conn, secrets config.Secrets) error {
	for _, r := range []db.Role{db.App, db.Inspector} {
		pw, err := secrets.Read(r.SecretName)
		if err != nil {
			return err
		}
		var exists bool
		if err := c.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, r.User).Scan(&exists); err != nil {
			return err
		}
		verb := "ALTER"
		if !exists {
			verb = "CREATE"
		}
		// DDL cannot take parameters: format() quotes the identifier and the literal safely.
		var stmt string
		if err := c.QueryRow(ctx, `SELECT format('%s ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text, $3::text)`,
			verb, r.User, pw).Scan(&stmt); err != nil {
			return err
		}
		if _, err := c.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("%s role %s: %w", strings.ToLower(verb), r.User, err)
		}
	}
	for _, s := range []string{
		`REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
		`REVOKE ALL ON DATABASE ` + pgx.Identifier{config.Env("PSA_EDGE_DB_NAME", "psa_edge")}.Sanitize() + ` FROM PUBLIC`,
		`GRANT CONNECT ON DATABASE ` + pgx.Identifier{config.Env("PSA_EDGE_DB_NAME", "psa_edge")}.Sanitize() + ` TO psa_edge_app, psa_edge_inspector`,
		`GRANT USAGE ON SCHEMA public TO psa_edge_app`,
	} {
		if _, err := c.Exec(ctx, s); err != nil {
			return err
		}
	}
	return nil
}

// guardIdentity refuses to run a package against a database that belongs to another deployment
// (for example a volume copied from a different client).
func guardIdentity(ctx context.Context, c *pgx.Conn, cfg *config.Edge) error {
	var has bool
	if err := c.QueryRow(ctx, `SELECT to_regclass('public.app_metadata') IS NOT NULL`).Scan(&has); err != nil || !has {
		return err
	}
	var id string
	err := c.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'deployment.id'`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if id != cfg.Deployment.ID {
		return fmt.Errorf("this database belongs to deployment %s, not %s (%s); refusing to start", id, cfg.Deployment.ID, cfg.Deployment.Code)
	}
	return nil
}

func recordConfiguration(ctx context.Context, c *pgx.Conn, cfg *config.Edge, res *Result) error {
	tx, err := c.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	now := time.Now().UTC().Format(time.RFC3339)
	set := map[string]string{
		"deployment.id": cfg.Deployment.ID, "deployment.code": cfg.Deployment.Code, "client.id": cfg.Client.ID,
		"client.code": cfg.Client.Code, "package.number": fmt.Sprint(cfg.Deployment.PackageNumber),
		"image.version": cfg.Image.Version, "schema.version": res.SchemaVersion, "migrations.last_run_at": now,
	}
	var prevInstallation string
	_ = tx.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'installation.id'`).Scan(&prevInstallation)
	set["installation.id"] = cfg.Deployment.InstallationID
	for k, v := range set {
		if _, err := tx.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, k, v); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('initialized_at', $1) ON CONFLICT (key) DO NOTHING`, now); err != nil {
		return err
	}
	if prevInstallation != "" && prevInstallation != cfg.Deployment.InstallationID {
		meta, _ := json.Marshal(map[string]string{"from": prevInstallation, "to": cfg.Deployment.InstallationID})
		if _, err := tx.Exec(ctx, `INSERT INTO audit_events (actor_type, actor, action, target, outcome, metadata)
			VALUES ('system', 'edge-migrate', 'appliance.installation_id.changed', $1, 'success', $2)`, cfg.Deployment.Code, meta); err != nil {
			return err
		}
	}

	pcfg, _ := json.Marshal(cfg.PSA.Config)
	var connID string
	if err := tx.QueryRow(ctx, `INSERT INTO psa_connections (instance_code, provider, display_name, auth_method, api_endpoint, config)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (instance_code) DO UPDATE SET provider = EXCLUDED.provider, display_name = EXCLUDED.display_name,
		  auth_method = EXCLUDED.auth_method, api_endpoint = EXCLUDED.api_endpoint, config = EXCLUDED.config
		RETURNING id`, cfg.PSA.InstanceCode, cfg.PSA.Provider, cfg.PSA.DisplayName, cfg.PSA.AuthMethod, cfg.PSA.APIEndpoint, pcfg).Scan(&connID); err != nil {
		return err
	}
	keys := []string{}
	for _, s := range cfg.Services {
		keys = append(keys, s.Key)
		var link any
		if s.UsesPSA {
			link = connID
		}
		settings := s.Settings
		if settings == nil {
			settings = map[string]any{}
		}
		sj, _ := json.Marshal(settings)
		if _, err := tx.Exec(ctx, `INSERT INTO service_configurations (service_key, name, uses_psa, enabled, psa_connection_id, settings)
			VALUES ($1, $2, $3, true, $4, $5)
			ON CONFLICT (service_key) DO UPDATE SET name = EXCLUDED.name, uses_psa = EXCLUDED.uses_psa, enabled = true,
			  psa_connection_id = EXCLUDED.psa_connection_id, settings = EXCLUDED.settings`, s.Key, s.Name, s.UsesPSA, link, sj); err != nil {
			return err
		}
	}
	// Services no longer in the package are disabled, not deleted (their history stays).
	if _, err := tx.Exec(ctx, `UPDATE service_configurations SET enabled = false WHERE NOT (service_key = ANY($1)) AND enabled`, keys); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Verify checks that every required table exists with a primary key, that the application role
// can connect, and that the inspector role cannot read any table.
func Verify(ctx context.Context, c *pgx.Conn, secrets config.Secrets) ([]string, error) {
	rows, err := c.Query(ctx, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r'
		  AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
		ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	var tables []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		tables = append(tables, t)
	}
	rows.Close()
	have := map[string]bool{}
	for _, t := range tables {
		have[t] = true
	}
	var missing []string
	for _, t := range RequiredTables {
		if !have[t] {
			missing = append(missing, t)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("schema verification failed: missing tables (or primary keys) %s", strings.Join(missing, ", "))
	}
	var leaked int
	if err := c.QueryRow(ctx, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege('psa_edge_inspector', c.oid, 'SELECT')`).Scan(&leaked); err != nil {
		return nil, err
	}
	if leaked > 0 {
		return nil, fmt.Errorf("schema verification failed: the inspector role can read %d table(s)", leaked)
	}
	for _, r := range []db.Role{db.App, db.Inspector} {
		p, err := db.Open(ctx, r, secrets, 1, 10*time.Second)
		if err != nil {
			return nil, fmt.Errorf("schema verification failed: %w", err)
		}
		p.Close()
	}
	return tables, nil
}

// Status lists applied migrations (for `edge-migrate status`).
func Status(ctx context.Context, pool *pgxpool.Pool) ([]map[string]any, error) {
	rows, err := pool.Query(ctx, `SELECT version, name, applied_at FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var v, n string
		var at time.Time
		if err := rows.Scan(&v, &n, &at); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"version": v, "name": n, "appliedAt": at})
	}
	return out, nil
}
