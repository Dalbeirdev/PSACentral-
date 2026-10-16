// Package db opens connections to this appliance's own PostgreSQL database as one of its three
// roles. Each role's password is a secret generated on this host by the install script.
package db

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/config"
)

type Role struct {
	User       string
	SecretName string
}

var (
	// Owner runs migrations (the database owner created by the PostgreSQL image).
	Owner = Role{User: "psa_edge_owner", SecretName: "postgres_owner_password"}
	// App is used by edge-api and edge-worker: DML only, append-only logs.
	App = Role{User: "psa_edge_app", SecretName: "app_db_password"}
	// Inspector reads catalog metadata only: it has no privileges on any table.
	Inspector = Role{User: "psa_edge_inspector", SecretName: "inspector_db_password"}
)

// URL builds the connection string. The database is reachable only on the deployment's internal
// Docker network (never published), so TLS is not used on that hop.
func URL(role Role, secrets config.Secrets) (string, error) {
	pw, err := secrets.Read(role.SecretName)
	if err != nil {
		return "", err
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(role.User, pw),
		Host:     config.Env("PSA_EDGE_DB_HOST", "edge-postgres") + ":" + config.Env("PSA_EDGE_DB_PORT", "5432"),
		Path:     "/" + config.Env("PSA_EDGE_DB_NAME", "psa_edge"),
		RawQuery: "sslmode=disable&application_name=psa-edge&connect_timeout=5",
	}
	return u.String(), nil
}

// Open connects with retries, because the database may still be starting.
func Open(ctx context.Context, role Role, secrets config.Secrets, maxConns int32, wait time.Duration) (*pgxpool.Pool, error) {
	dsn, err := URL(role, secrets)
	if err != nil {
		return nil, err
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("database configuration: %w", err)
	}
	cfg.MaxConns = maxConns
	deadline := time.Now().Add(wait)
	for {
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("database not reachable as %s: %w", role.User, err)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
