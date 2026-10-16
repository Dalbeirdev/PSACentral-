package psa

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/secretbox"
)

// CAFieldKey is the pseudo-credential under which an optional private CA certificate (PEM) is kept
// in credential_store, encrypted like everything else there. It is not counted as a credential.
const CAFieldKey = "tlsCaCertificate"

// Tester loads the connection and its credentials from the appliance database, runs the adapter and
// records the outcome (psa_connections, psa_connection_tests, integration_logs). Credentials exist in
// memory only for the duration of the request.
type Tester struct {
	Cfg     *config.Edge
	Pool    *pgxpool.Pool
	Box     *secretbox.Box
	Log     *slog.Logger
	Timeout time.Duration
}

// Outcome is a stored test as read back for the UI and the agent.
type Outcome struct {
	TestedAt   time.Time         `json:"testedAt"`
	TestedBy   string            `json:"testedBy"`
	OK         bool              `json:"ok"`
	Code       string            `json:"code"`
	HTTPStatus *int              `json:"httpStatus"`
	LatencyMs  int               `json:"latencyMs"`
	Detail     string            `json:"detail"`
	Identity   map[string]string `json:"identity"`
}

var ErrNoConnection = errors.New("the PSA connection is not initialized; run edge-migrate")

// LoadConn builds the connection (endpoint, configuration, decrypted credentials, private CA) for one
// unit of work — a test or a synchronization run. Credentials live only in the returned Conn.
func (t *Tester) LoadConn(ctx context.Context) (*Conn, string, error) {
	var connID string
	if err := t.Pool.QueryRow(ctx, `SELECT id FROM psa_connections WHERE instance_code = $1`, t.Cfg.PSA.InstanceCode).Scan(&connID); err != nil {
		return nil, "", ErrNoConnection
	}
	creds, caPEM, err := t.loadCredentials(ctx, connID)
	if err != nil {
		return nil, "", err
	}
	endpoint, auth := "", ""
	if t.Cfg.PSA.APIEndpoint != nil {
		endpoint = *t.Cfg.PSA.APIEndpoint
	}
	if t.Cfg.PSA.AuthMethod != nil {
		auth = *t.Cfg.PSA.AuthMethod
	}
	return &Conn{Provider: t.Cfg.PSA.Provider, AuthMethod: auth, Endpoint: endpoint, Config: t.Cfg.PSA.Config, Credentials: creds, CACertPEM: caPEM, Timeout: t.Timeout}, connID, nil
}

// ValidTester lists who may request a connection test: the local admin page, the worker's periodic
// test, or a signed remote command relayed by the agent (Module 13).
func ValidTester(by string) bool { return by == "local_admin" || by == "worker" || by == "remote" }

// Test runs one connection test now and persists it. testedBy is "local_admin", "worker" or "remote".
func (t *Tester) Test(ctx context.Context, testedBy string) (Result, error) {
	if !ValidTester(testedBy) {
		return Result{}, errors.New("invalid tester")
	}
	var connID string
	if err := t.Pool.QueryRow(ctx, `SELECT id FROM psa_connections WHERE instance_code = $1`, t.Cfg.PSA.InstanceCode).Scan(&connID); err != nil {
		return Result{}, ErrNoConnection
	}
	creds, caPEM, err := t.loadCredentials(ctx, connID)
	if err != nil {
		return Result{}, err
	}
	endpoint := ""
	if t.Cfg.PSA.APIEndpoint != nil {
		endpoint = *t.Cfg.PSA.APIEndpoint
	}
	auth := ""
	if t.Cfg.PSA.AuthMethod != nil {
		auth = *t.Cfg.PSA.AuthMethod
	}
	conn := &Conn{Provider: t.Cfg.PSA.Provider, AuthMethod: auth, Endpoint: endpoint, Config: t.Cfg.PSA.Config, Credentials: creds, CACertPEM: caPEM, Timeout: t.Timeout}
	res := Run(ctx, conn)
	for k := range creds { // defensive: results must never carry a credential value
		if v := creds[k]; len(v) >= 4 && strings.Contains(res.Detail, v) {
			res.Detail = strings.ReplaceAll(res.Detail, v, "[redacted]")
		}
	}
	if err := t.record(ctx, connID, testedBy, res); err != nil {
		return res, err
	}
	return res, nil
}

func (t *Tester) loadCredentials(ctx context.Context, connID string) (map[string]string, string, error) {
	rows, err := t.Pool.Query(ctx, `SELECT field_key, ciphertext, nonce FROM credential_store WHERE psa_connection_id = $1`, connID)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	creds := map[string]string{}
	caPEM := ""
	for rows.Next() {
		var key string
		var ct, nonce []byte
		if err := rows.Scan(&key, &ct, &nonce); err != nil {
			return nil, "", err
		}
		plain, err := t.Box.Open(ct, nonce, secretbox.AD(connID, key))
		if err != nil {
			return nil, "", fmt.Errorf("credential %s cannot be decrypted with this host's data key", key)
		}
		if key == CAFieldKey {
			caPEM = string(plain)
		} else {
			creds[key] = string(plain)
		}
	}
	return creds, caPEM, rows.Err()
}

func (t *Tester) record(ctx context.Context, connID, testedBy string, r Result) error {
	ident, _ := json.Marshal(r.Identity)
	var httpStatus any
	if r.HTTPStatus > 0 {
		httpStatus = r.HTTPStatus
	}
	return pgx.BeginFunc(ctx, t.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO psa_connection_tests (psa_connection_id, tested_by, ok, code, http_status, latency_ms, detail, remote_identity)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, connID, testedBy, r.OK, r.Code, httpStatus, r.LatencyMs, r.Detail, ident); err != nil {
			return err
		}
		status := "failed"
		if r.OK {
			status = "verified"
		} else if r.Code == CodeNotConfigured {
			status = "not_configured"
		}
		if _, err := tx.Exec(ctx, `UPDATE psa_connections SET status = $2, last_test_at = now(), last_test_result = $3, last_test_code = $3, last_test_http_status = $4,
			last_test_latency_ms = $5, last_tested_by = $6, last_success_at = CASE WHEN $7 THEN now() ELSE last_success_at END,
			remote_identity = CASE WHEN $7 THEN $8::jsonb ELSE remote_identity END,
			consecutive_failures = CASE WHEN $7 THEN 0 ELSE consecutive_failures + 1 END
			WHERE id = $1`, connID, status, r.Code, httpStatus, r.LatencyMs, testedBy, r.OK, ident); err != nil {
			return err
		}
		level, msg := "info", "PSA connection test succeeded ("+r.Code+", "+fmt.Sprint(r.LatencyMs)+" ms)."
		if !r.OK {
			level, msg = "error", "PSA connection test failed: "+r.Detail
		}
		meta, _ := json.Marshal(map[string]any{"testedBy": testedBy, "latencyMs": r.LatencyMs})
		_, err := tx.Exec(ctx, `INSERT INTO integration_logs (level, component, message, error_code, http_status, psa_connection_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			level, componentFor(testedBy), left(msg, 1000), nullIfOK(r), httpStatus, connID, meta)
		return err
	})
}

func componentFor(testedBy string) string {
	if testedBy == "worker" {
		return "worker"
	}
	return "api"
}

func nullIfOK(r Result) any {
	if r.OK {
		return nil
	}
	return r.Code
}

func left(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// History returns the most recent stored tests, newest first.
func (t *Tester) History(ctx context.Context, limit int) ([]Outcome, error) {
	rows, err := t.Pool.Query(ctx, `SELECT t.tested_at, t.tested_by, t.ok, t.code, t.http_status, t.latency_ms, t.detail, t.remote_identity
		FROM psa_connection_tests t JOIN psa_connections c ON c.id = t.psa_connection_id
		WHERE c.instance_code = $1 ORDER BY t.tested_at DESC LIMIT $2`, t.Cfg.PSA.InstanceCode, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Outcome
	for rows.Next() {
		var o Outcome
		var ident []byte
		if err := rows.Scan(&o.TestedAt, &o.TestedBy, &o.OK, &o.Code, &o.HTTPStatus, &o.LatencyMs, &o.Detail, &ident); err != nil {
			return nil, err
		}
		o.TestedAt = o.TestedAt.UTC()
		o.Identity = map[string]string{}
		_ = json.Unmarshal(ident, &o.Identity)
		out = append(out, o)
	}
	return out, rows.Err()
}
