// Package api is the appliance's local application API and its administration / setup UI.
// It is published on 127.0.0.1 only (Compose) and works without the Control Plane.
package api

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/agent"
	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/inventory"
	"psacc.local/edge/internal/license"
	"psacc.local/edge/internal/psa"
	"psacc.local/edge/internal/remote"
	"psacc.local/edge/internal/secretbox"
	"psacc.local/edge/internal/worker"
)

//go:embed templates/*.html
var templateFS embed.FS

const (
	sessionCookie = "psa_edge_session"
	sessionTTL    = 8 * time.Hour
	maxFailures   = 5
	lockDuration  = 15 * time.Minute
)

type Server struct {
	Cfg     *config.Edge
	Pool    *pgxpool.Pool
	Box     *secretbox.Box
	Version string
	Log     *slog.Logger
	// Tester runs the real PSA connection test (Module 11); nil only in template tests.
	Tester *psa.Tester
	// SyncInterval is shown on the Synchronization page (the worker owns the schedule).
	SyncInterval string
	tpl          *template.Template
	// RemoteDir is the shared directory of remote command hand-over (Module 13).
	// License files (Module 16): the package copy and the current token the agent keeps fresh.
	LicensePackagePath string
	LicenseCurrentPath string
	RemoteDir          string
	// DeletionDir (Module 17): the local administrator's deletion request and the agent's progress, on the shared volume.
	DeletionDir string
}

func (s *Server) deletionDir() string {
	if s.DeletionDir != "" {
		return s.DeletionDir
	}
	return "/var/log/psa-edge/deletion"
}

func (s *Server) Handler() (http.Handler, error) {
	tpl, err := template.New("").Funcs(template.FuncMap{
		"fmtTime": func(t *time.Time) string {
			if t == nil {
				return "—"
			}
			return t.UTC().Format("2006-01-02 15:04 UTC")
		},
		"ts": func(v any) string {
			switch t := v.(type) {
			case time.Time:
				return t.UTC().Format("2006-01-02 15:04:05 UTC")
			case *time.Time:
				if t != nil {
					return t.UTC().Format("2006-01-02 15:04:05 UTC")
				}
			}
			return "—"
		},
		"deref":   func(p *int64) int64 { return *p },
		"deref32": func(p *int) int { return *p },
		"inc":     func(n int) int { return n + 1 },
		"list":    func(v ...string) []string { return v },
		"bytes": func(n int64) string {
			switch {
			case n < 1024:
				return fmt.Sprintf("%d B", n)
			case n < 1024*1024:
				return fmt.Sprintf("%.1f KB", float64(n)/1024)
			default:
				return fmt.Sprintf("%.1f MB", float64(n)/1024/1024)
			}
		},
	}).ParseFS(templateFS, "templates/*.html")
	if err != nil {
		return nil, err
	}
	s.tpl = tpl
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /{$}", s.page(s.dashboard))
	mux.HandleFunc("GET /setup", s.setupForm)
	mux.HandleFunc("POST /setup", s.setupSubmit)
	mux.HandleFunc("GET /login", s.loginForm)
	mux.HandleFunc("POST /login", s.loginSubmit)
	mux.HandleFunc("POST /logout", s.page(s.logout))
	mux.HandleFunc("GET /credentials", s.page(s.credentialsForm))
	mux.HandleFunc("POST /credentials", s.page(s.credentialsSubmit))
	mux.HandleFunc("POST /credentials/test", s.page(s.credentialsTest))
	mux.HandleFunc("GET /tickets", s.page(s.ticketsList))
	mux.HandleFunc("GET /tickets/new", s.page(s.ticketNewForm))
	mux.HandleFunc("POST /tickets", s.page(s.ticketCreate))
	mux.HandleFunc("GET /tickets/{id}", s.page(s.ticketDetail))
	mux.HandleFunc("POST /tickets/{id}", s.page(s.ticketUpdate))
	mux.HandleFunc("GET /sync", s.page(s.syncPage))
	mux.HandleFunc("GET /removal", s.page(s.removalPage))
	mux.HandleFunc("GET /deletion", s.deletionPage)
	mux.HandleFunc("POST /deletion", s.page(s.deletionSubmit))
	mux.HandleFunc("POST /deletion/local", s.page(s.deletionLocal))
	mux.HandleFunc("POST /sync/run", s.page(s.syncRequest))
	mux.HandleFunc("GET /api/status", s.page(s.statusJSON))
	return s.guard(mux), nil
}

var localHost = regexp.MustCompile(`^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$`)

// guard sets security headers and rejects requests whose Host is not loopback (DNS rebinding).
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cache-Control", "no-store")
		// The liveness probe is reached by the agent and compose healthchecks over the service name; it
		// carries no secrets. Everything else is loopback-only.
		probe := r.Method == http.MethodGet && r.URL.Path == "/healthz"
		if !probe && !localHost.MatchString(r.Host) {
			http.Error(w, "This appliance UI is available on this host only (http://127.0.0.1).", http.StatusMisdirectedRequest)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		// Module 17: once the local administrator asked for the deletion, the appliance shows only its progress.
		if r.URL.Path != "/deletion" && r.URL.Path != "/deletion/local" && !probe && agent.ReadDeletionRequest(s.deletionDir()) != nil {
			http.Redirect(w, r, "/deletion", http.StatusSeeOther)
			return
		}
		if r.Method == http.MethodPost {
			if o := r.Header.Get("Origin"); o != "" && o != "null" && !strings.HasSuffix(o, "://"+r.Host) {
				http.Error(w, "Cross-origin request refused.", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	status, code, dbState := "ok", http.StatusOK, "up"
	if err := s.Pool.Ping(ctx); err != nil {
		status, code, dbState = "degraded", http.StatusServiceUnavailable, "down"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": status, "database": dbState, "version": s.Version})
}

type session struct {
	UserID   string
	Username string
	CSRF     string
}

type viewData struct {
	Title   string
	Cfg     *config.Edge
	Version string
	Session *session
	Error   string
	Notice  string
	Fields  map[string]string
	Data    any
}

func (s *Server) render(w http.ResponseWriter, status int, name string, d viewData) {
	d.Cfg, d.Version = s.Cfg, s.Version
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := s.tpl.ExecuteTemplate(w, name, d); err != nil {
		s.Log.Error("render failed", "template", name, "err", err)
	}
}

func (s *Server) adminCount(ctx context.Context) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM local_admin_users`).Scan(&n)
	return n, err
}

func (s *Server) currentSession(r *http.Request) *session {
	c, err := r.Cookie(sessionCookie)
	if err != nil || len(c.Value) < 20 {
		return nil
	}
	var se session
	err = s.Pool.QueryRow(r.Context(), `SELECT u.id, u.username, s.csrf_token FROM local_admin_sessions s
		JOIN local_admin_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, hashToken(c.Value)).
		Scan(&se.UserID, &se.Username, &se.CSRF)
	if err != nil {
		return nil
	}
	return &se
}

type handler func(w http.ResponseWriter, r *http.Request, se *session)

// page requires a signed-in local admin (and a valid CSRF token on POST).
func (s *Server) page(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if n, err := s.adminCount(r.Context()); err != nil {
			http.Error(w, "The appliance database is not available.", http.StatusServiceUnavailable)
			return
		} else if n == 0 {
			http.Redirect(w, r, "/setup", http.StatusSeeOther)
			return
		}
		se := s.currentSession(r)
		if se == nil {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.Error(w, `{"error":"sign-in required"}`, http.StatusUnauthorized)
				return
			}
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		if r.Method == http.MethodPost && r.FormValue("csrf") != se.CSRF {
			http.Error(w, "The form expired. Reload the page and try again.", http.StatusForbidden)
			return
		}
		h(w, r, se)
	}
}

func (s *Server) audit(ctx context.Context, actorType, actor, action, target, outcome string, meta map[string]any) {
	b, _ := json.Marshal(meta)
	if meta == nil {
		b = []byte("{}")
	}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO audit_events (actor_type, actor, action, target, outcome, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
		actorType, actor, action, target, outcome, b); err != nil {
		s.Log.Error("audit write failed", "action", action, "err", err)
	}
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID string) error {
	token := randomToken(32)
	if _, err := s.Pool.Exec(r.Context(), `INSERT INTO local_admin_sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`,
		hashToken(token), userID, randomToken(32), sessionTTL.String()); err != nil {
		return err
	}
	_, _ = s.Pool.Exec(r.Context(), `DELETE FROM local_admin_sessions WHERE expires_at <= now()`)
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: int(sessionTTL.Seconds())})
	return nil
}

var usernameRe = regexp.MustCompile(`^[a-z][a-z0-9._-]{2,63}$`)

func (s *Server) setupForm(w http.ResponseWriter, r *http.Request) {
	if n, err := s.adminCount(r.Context()); err == nil && n > 0 {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.render(w, http.StatusOK, "setup.html", viewData{Title: "First-run setup"})
}

func (s *Server) setupSubmit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if n, err := s.adminCount(ctx); err != nil || n > 0 {
		http.Error(w, "Setup has already been completed.", http.StatusConflict)
		return
	}
	user := strings.ToLower(strings.TrimSpace(r.FormValue("username")))
	pw, confirm := r.FormValue("password"), r.FormValue("confirm")
	fail := func(msg string) {
		s.render(w, http.StatusUnprocessableEntity, "setup.html", viewData{Title: "First-run setup", Error: msg, Fields: map[string]string{"username": user}})
	}
	if !usernameRe.MatchString(user) {
		fail("Use 3–64 lowercase letters, digits, dots, dashes or underscores for the user name, starting with a letter.")
		return
	}
	if err := ValidatePassword(user, pw); err != nil {
		fail(err.Error())
		return
	}
	if pw != confirm {
		fail("The passwords do not match.")
		return
	}
	hash, err := HashPassword(pw)
	if err != nil {
		fail("Could not create the account.")
		return
	}
	// The count check and insert run in one serializable step so two people cannot both "first-run".
	var id string
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `LOCK TABLE local_admin_users IN EXCLUSIVE MODE`); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM local_admin_users`).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return errors.New("setup already completed")
		}
		return tx.QueryRow(ctx, `INSERT INTO local_admin_users (username, password_hash) VALUES ($1, $2) RETURNING id`, user, hash).Scan(&id)
	})
	if err != nil {
		http.Error(w, "Setup has already been completed.", http.StatusConflict)
		return
	}
	s.audit(ctx, "local_admin", user, "local_admin.created", user, "success", map[string]any{"firstRun": true})
	if err := s.startSession(w, r, id); err != nil {
		fail("Account created; sign in to continue.")
		return
	}
	http.Redirect(w, r, "/credentials?welcome=1", http.StatusSeeOther)
}

func (s *Server) loginForm(w http.ResponseWriter, r *http.Request) {
	if n, err := s.adminCount(r.Context()); err == nil && n == 0 {
		http.Redirect(w, r, "/setup", http.StatusSeeOther)
		return
	}
	s.render(w, http.StatusOK, "login.html", viewData{Title: "Sign in"})
}

func (s *Server) loginSubmit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := strings.ToLower(strings.TrimSpace(r.FormValue("username")))
	pw := r.FormValue("password")
	generic := "The user name or password is not correct."
	var id, hash string
	var failures int
	var locked *time.Time
	err := s.Pool.QueryRow(ctx, `SELECT id, password_hash, failed_attempts, locked_until FROM local_admin_users WHERE lower(username) = $1`, user).Scan(&id, &hash, &failures, &locked)
	if err != nil {
		VerifyPassword("pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", pw) // same cost for unknown users
		s.audit(ctx, "local_admin", user, "local_admin.login", user, "failure", map[string]any{"reason": "unknown_user"})
		s.render(w, http.StatusUnauthorized, "login.html", viewData{Title: "Sign in", Error: generic, Fields: map[string]string{"username": user}})
		return
	}
	if locked != nil && locked.After(time.Now()) {
		s.audit(ctx, "local_admin", user, "local_admin.login", user, "denied", map[string]any{"reason": "locked"})
		s.render(w, http.StatusTooManyRequests, "login.html", viewData{Title: "Sign in", Error: "Too many failed attempts. Try again in 15 minutes.", Fields: map[string]string{"username": user}})
		return
	}
	if !VerifyPassword(hash, pw) {
		failures++
		var lockUntil any
		if failures >= maxFailures {
			lockUntil = time.Now().Add(lockDuration)
			failures = 0
		}
		_, _ = s.Pool.Exec(ctx, `UPDATE local_admin_users SET failed_attempts = $2, locked_until = $3 WHERE id = $1`, id, failures, lockUntil)
		s.audit(ctx, "local_admin", user, "local_admin.login", user, "failure", map[string]any{"locked": lockUntil != nil})
		s.render(w, http.StatusUnauthorized, "login.html", viewData{Title: "Sign in", Error: generic, Fields: map[string]string{"username": user}})
		return
	}
	_, _ = s.Pool.Exec(ctx, `UPDATE local_admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, id)
	if err := s.startSession(w, r, id); err != nil {
		http.Error(w, "Could not start a session.", http.StatusInternalServerError)
		return
	}
	s.audit(ctx, "local_admin", user, "local_admin.login", user, "success", nil)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, se *session) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_, _ = s.Pool.Exec(r.Context(), `DELETE FROM local_admin_sessions WHERE token_hash = $1`, hashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	s.audit(r.Context(), "local_admin", se.Username, "local_admin.logout", se.Username, "success", nil)
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

// ---- credentials ----

type credentialRow struct {
	Key       string
	Label     string
	Secret    bool
	Set       bool
	UpdatedAt *time.Time
}

func (s *Server) connectionID(ctx context.Context) (string, string, error) {
	var id, status string
	err := s.Pool.QueryRow(ctx, `SELECT id, status FROM psa_connections WHERE instance_code = $1`, s.Cfg.PSA.InstanceCode).Scan(&id, &status)
	return id, status, err
}

func (s *Server) credentialRows(ctx context.Context, connID string) ([]credentialRow, error) {
	set := map[string]time.Time{}
	rows, err := s.Pool.Query(ctx, `SELECT field_key, updated_at FROM credential_store WHERE psa_connection_id = $1`, connID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k string
		var t time.Time
		if err := rows.Scan(&k, &t); err != nil {
			return nil, err
		}
		set[k] = t
	}
	rows.Close()
	var out []credentialRow
	for _, f := range s.Cfg.PSA.CredentialFields {
		row := credentialRow{Key: f.Key, Label: f.Label, Secret: f.Secret}
		if t, ok := set[f.Key]; ok {
			row.Set, row.UpdatedAt = true, &t
		}
		out = append(out, row)
	}
	return out, nil
}

func (s *Server) credentialsForm(w http.ResponseWriter, r *http.Request, se *session) {
	connID, status, err := s.connectionID(r.Context())
	if err != nil {
		http.Error(w, "The PSA connection is not initialized. Run edge-migrate.", http.StatusServiceUnavailable)
		return
	}
	rows, err := s.credentialRows(r.Context(), connID)
	if err != nil {
		http.Error(w, "Could not read the credential status.", http.StatusInternalServerError)
		return
	}
	notice := ""
	switch r.URL.Query().Get("saved") {
	case "1":
		notice = "Credentials saved, encrypted with this host's data key. They are never sent to the Control Plane."
	}
	if r.URL.Query().Get("welcome") == "1" {
		notice = "Local administrator created. Enter the PSA credentials for this appliance."
	}
	s.render(w, http.StatusOK, "credentials.html", viewData{Title: "PSA credentials", Session: se, Notice: notice, Data: s.credentialsData(r.Context(), connID, rows, status, nil)})
}

// credentialsData assembles the credentials page: rows, CA presence, the connection status and the test history.
func (s *Server) credentialsData(ctx context.Context, connID string, rows []credentialRow, status string, result *psa.Result) map[string]any {
	var caSet bool
	_ = s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM credential_store WHERE psa_connection_id = $1 AND field_key = $2)`, connID, psa.CAFieldKey).Scan(&caSet)
	d := map[string]any{"Rows": rows, "Status": status, "CASet": caSet, "History": []psa.Outcome(nil), "Last": (*psa.Outcome)(nil), "Result": result}
	if s.Tester != nil {
		if h, err := s.Tester.History(ctx, 10); err == nil && len(h) > 0 {
			d["History"] = h
			d["Last"] = &h[0]
		}
	}
	return d
}

// credentialsTest runs the real PSA connection test now (synchronously, bounded by the tester's timeout)
// and shows the outcome inline. The outcome is stored and will reach the Control Plane with the next report.
func (s *Server) credentialsTest(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	connID, _, err := s.connectionID(ctx)
	if err != nil || s.Tester == nil {
		http.Error(w, "The PSA connection is not initialized.", http.StatusServiceUnavailable)
		return
	}
	res, err := s.Tester.Test(ctx, "local_admin")
	if err != nil {
		rows, _ := s.credentialRows(ctx, connID)
		_, status, _ := s.connectionID(ctx)
		s.render(w, http.StatusInternalServerError, "credentials.html", viewData{Title: "PSA credentials", Session: se, Error: "The connection test could not run: " + err.Error(), Data: s.credentialsData(ctx, connID, rows, status, nil)})
		return
	}
	outcome := "failure"
	if res.OK {
		outcome = "success"
	}
	s.audit(ctx, "local_admin", se.Username, "psa_connection.tested", s.Cfg.PSA.InstanceCode, outcome, map[string]any{"code": res.Code, "httpStatus": res.HTTPStatus, "latencyMs": res.LatencyMs})
	rows, _ := s.credentialRows(ctx, connID)
	_, status, _ := s.connectionID(ctx)
	s.render(w, http.StatusOK, "credentials.html", viewData{Title: "PSA credentials", Session: se, Data: s.credentialsData(ctx, connID, rows, status, &res)})
}

func (s *Server) credentialsSubmit(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	connID, _, err := s.connectionID(ctx)
	if err != nil {
		http.Error(w, "The PSA connection is not initialized.", http.StatusServiceUnavailable)
		return
	}
	var changed []string
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if ca := strings.TrimSpace(r.FormValue("field_" + psa.CAFieldKey)); ca != "" {
			if len(ca) > 65536 {
				return errors.New("The CA certificate is too long.")
			}
			if _, err := psa.NewHTTPClient(ca, time.Second); err != nil {
				return errors.New("The CA certificate must be a PEM-encoded certificate.")
			}
			ct, nonce, err := s.Box.Seal([]byte(ca), secretbox.AD(connID, psa.CAFieldKey))
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO credential_store (psa_connection_id, field_key, ciphertext, nonce) VALUES ($1, $2, $3, $4)
				ON CONFLICT (psa_connection_id, field_key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce`, connID, psa.CAFieldKey, ct, nonce); err != nil {
				return err
			}
			changed = append(changed, psa.CAFieldKey)
		} else if r.FormValue("clear_"+psa.CAFieldKey) == "1" {
			if _, err := tx.Exec(ctx, `DELETE FROM credential_store WHERE psa_connection_id = $1 AND field_key = $2`, connID, psa.CAFieldKey); err != nil {
				return err
			}
			changed = append(changed, psa.CAFieldKey+":removed")
		}
		for _, f := range s.Cfg.PSA.CredentialFields {
			v := r.FormValue("field_" + f.Key)
			if v == "" {
				continue // empty keeps the stored value
			}
			if len(v) > 4096 {
				return errors.New(f.Label + " is too long.")
			}
			ct, nonce, err := s.Box.Seal([]byte(v), secretbox.AD(connID, f.Key))
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO credential_store (psa_connection_id, field_key, ciphertext, nonce) VALUES ($1, $2, $3, $4)
				ON CONFLICT (psa_connection_id, field_key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce`, connID, f.Key, ct, nonce); err != nil {
				return err
			}
			changed = append(changed, f.Key)
		}
		var have int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM credential_store WHERE psa_connection_id = $1 AND field_key <> $2`, connID, psa.CAFieldKey).Scan(&have); err != nil {
			return err
		}
		status := "not_configured"
		if have >= len(s.Cfg.PSA.CredentialFields) && have > 0 {
			status = "credentials_present" // "verified" needs a real API test: run it below or wait for the worker
		}
		// Changed credentials invalidate an earlier verification until the next test.
		_, err := tx.Exec(ctx, `UPDATE psa_connections SET status = $2 WHERE id = $1`, connID, status)
		return err
	})
	if err != nil {
		rows, _ := s.credentialRows(ctx, connID)
		_, status, _ := s.connectionID(ctx)
		s.render(w, http.StatusUnprocessableEntity, "credentials.html", viewData{Title: "PSA credentials", Session: se, Error: err.Error(), Data: s.credentialsData(ctx, connID, rows, status, nil)})
		return
	}
	if len(changed) > 0 {
		s.audit(ctx, "local_admin", se.Username, "psa_credentials.updated", s.Cfg.PSA.InstanceCode, "success", map[string]any{"fields": changed})
		_, _ = s.Pool.Exec(ctx, `INSERT INTO integration_logs (level, component, message, psa_connection_id) VALUES ('info', 'api', $1, $2)`,
			"PSA credentials updated in the local admin UI (fields: "+strings.Join(changed, ", ")+").", connID)
	}
	http.Redirect(w, r, "/credentials?saved=1", http.StatusSeeOther)
}

// ---- status ----

type Status struct {
	Deployment map[string]string  `json:"deployment"`
	Version    string             `json:"version"`
	Database   inventory.Database `json:"database"`
	PSA        map[string]any     `json:"psa"`
	Services   []map[string]any   `json:"services"`
	Backup     map[string]any     `json:"backup"`
	Enrollment map[string]any     `json:"enrollment"`
	RecentLogs []map[string]any   `json:"recentLogs"`
	Tickets    map[string]any     `json:"tickets"`
	Sync       map[string]any     `json:"sync"`
	// Remote: commands the agent handled and a staged upgrade, from the shared volume (Module 13).
	Remote map[string]any `json:"remote"`
	// Lifecycle: provider suspension (Module 14) as recorded by the worker; License: the identifier from the package.
	Lifecycle map[string]any `json:"lifecycle"`
	// Deletion (Module 17): the local administrator's deletion in progress or finished, nil otherwise.
	Deletion *agent.DeletionStatus `json:"deletion,omitempty"`
	License  map[string]any        `json:"license"`
	// LicenseCheck: the appliance's verification of its license token (Module 16); PSA work stops when not allowed.
	LicenseCheck license.Status `json:"licenseCheck"`
}

func (s *Server) collectStatus(ctx context.Context) Status {
	st := Status{
		Deployment:   map[string]string{"code": s.Cfg.Deployment.Code, "id": s.Cfg.Deployment.ID, "installationId": s.Cfg.Deployment.InstallationID, "client": s.Cfg.Client.DisplayName + " (" + s.Cfg.Client.Code + ")"},
		Version:      s.Version,
		Database:     inventory.Collect(ctx, s.Pool),
		Enrollment:   agentStatus(),
		Remote:       s.remoteStatus(),
		Lifecycle:    s.lifecycleStatus(ctx),
		Deletion:     agent.ReadDeletionStatus(s.deletionDir()),
		License:      s.licenseInfo(),
		LicenseCheck: s.licenseVerification(),
	}
	connID, status, err := s.connectionID(ctx)
	if err == nil {
		rows, _ := s.credentialRows(ctx, connID)
		present := 0
		for _, r := range rows {
			if r.Set {
				present++
			}
		}
		st.PSA = map[string]any{"instance": s.Cfg.PSA.InstanceCode, "provider": s.Cfg.PSA.Provider, "endpoint": s.Cfg.PSA.APIEndpoint, "status": status,
			"credentialFields": len(rows), "credentialsPresent": present, "connectionTested": false}
		if s.Tester != nil {
			if h, err := s.Tester.History(ctx, 1); err == nil && len(h) > 0 {
				st.PSA["connectionTested"] = true
				st.PSA["lastTest"] = h[0]
			}
		}
	}
	if rows, err := s.Pool.Query(ctx, `SELECT service_key, name, uses_psa, enabled FROM service_configurations ORDER BY name`); err == nil {
		for rows.Next() {
			var k, n string
			var u, e bool
			if rows.Scan(&k, &n, &u, &e) == nil {
				st.Services = append(st.Services, map[string]any{"key": k, "name": n, "usesPsa": u, "enabled": e})
			}
		}
		rows.Close()
	}
	var bStatus string
	var bAt *time.Time
	var bSize *int64
	if err := s.Pool.QueryRow(ctx, `SELECT status, coalesce(finished_at, started_at), size_bytes FROM backup_runs ORDER BY started_at DESC LIMIT 1`).Scan(&bStatus, &bAt, &bSize); err == nil {
		st.Backup = map[string]any{"lastStatus": bStatus, "lastAt": bAt, "sizeBytes": bSize}
	} else {
		st.Backup = map[string]any{"lastStatus": "none"}
	}
	st.Tickets, st.Sync = map[string]any{"total": 0, "open": 0}, map[string]any{"lastStatus": nil}
	var total, open int
	if s.Pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE status IN ('new', 'open', 'pending', 'on_hold')) FROM helpdesk_tickets`).Scan(&total, &open) == nil {
		st.Tickets = map[string]any{"total": total, "open": open}
	}
	var runStatus *string
	var runAt *time.Time
	var recv, sent, failed int
	if s.Pool.QueryRow(ctx, `SELECT status, started_at, items_received, items_sent, items_failed FROM sync_runs ORDER BY started_at DESC LIMIT 1`).Scan(&runStatus, &runAt, &recv, &sent, &failed) == nil {
		// Plain values for the template: `eq` cannot compare a *string with a string.
		var status any
		if runStatus != nil {
			status = *runStatus
		}
		var at any
		if runAt != nil {
			at = *runAt
		}
		st.Sync = map[string]any{"lastStatus": status, "lastRunAt": at, "itemsReceived": recv, "itemsSent": sent, "itemsFailed": failed}
	}
	var pending int
	if s.Pool.QueryRow(ctx, `SELECT pending_outbound FROM edge_sync_status()`).Scan(&pending) == nil {
		st.Sync["pendingOutbound"] = pending
	}
	if rows, err := s.Pool.Query(ctx, `SELECT occurred_at, level, component, message FROM integration_logs ORDER BY id DESC LIMIT 10`); err == nil {
		for rows.Next() {
			var at time.Time
			var l, c, m string
			if rows.Scan(&at, &l, &c, &m) == nil {
				st.RecentLogs = append(st.RecentLogs, map[string]any{"at": at, "level": l, "component": c, "message": m})
			}
		}
		rows.Close()
	}
	return st
}

// agentStatus reads the status the agent publishes on the shared log volume (no secrets).
// lifecycleStatus reports a provider suspension (worker-recorded flag) for banners and the status JSON.
func (s *Server) lifecycleStatus(ctx context.Context) map[string]any {
	out := map[string]any{"suspended": false}
	if s.Pool == nil {
		return out
	}
	if on, v := worker.SuspendedIn(ctx, s.Pool); on {
		out["suspended"] = true
		if i := strings.Index(v, "|"); i > 0 {
			out["since"], out["reason"] = v[:i], v[i+1:]
		} else {
			out["since"] = v
		}
	}
	// Module 15: decommissioned (final) as recorded by the worker, or as the agent's own state when the worker has not written the flag yet.
	out["decommissioned"] = false
	if on, v := worker.DecommissionedIn(ctx, s.Pool); on {
		out["decommissioned"] = true
		if i := strings.Index(v, "|"); i > 0 {
			out["decommissionedSince"] = v[:i]
		} else {
			out["decommissionedSince"] = v
		}
	} else if st := agentStatus(); st["state"] == "decommissioned" {
		out["decommissioned"] = true
		out["decommissionedSince"], _ = st["decommissionedAt"].(string)
	}
	return out
}

// removalPage: the host-side uninstall instructions (the Control Plane never removes anything remotely).
func (s *Server) removalPage(w http.ResponseWriter, r *http.Request, se *session) {
	lc := s.lifecycleStatus(r.Context())
	since, _ := lc["decommissionedSince"].(string)
	state, _ := agentStatus()["state"].(string)
	s.render(w, http.StatusOK, "removal.html", viewData{Title: "Removal", Session: se, Data: map[string]any{
		"Code": s.Cfg.Deployment.Code, "Project": "psacc-" + strings.ToLower(s.Cfg.Deployment.Code),
		"Decommissioned": lc["decommissioned"] == true, "Since": since, "AgentState": state,
	}})
}

// licenseInfo is the license identifier the package carries (Module 14); no entitlement logic runs here.
func (s *Server) licenseInfo() map[string]any {
	if s.Cfg == nil || s.Cfg.License == nil {
		return nil
	}
	out := map[string]any{"code": s.Cfg.License.Code, "displayName": s.Cfg.License.DisplayName}
	if s.Cfg.License.EndsAt != nil {
		out["endsAt"] = *s.Cfg.License.EndsAt
	}
	out["verification"] = s.licenseVerification()
	return out
}

// licenseVerification is this appliance's own check of its license token (Module 16).
func (s *Server) licenseVerification() license.Status {
	pkg, cur := s.LicensePackagePath, s.LicenseCurrentPath
	if pkg == "" {
		pkg = "/etc/psa-edge/license.json"
	}
	if cur == "" {
		cur = "/var/log/psa-edge/license/current.json"
	}
	if s.Cfg == nil {
		return license.Status{State: "missing", KeySource: "none", VerifiedAt: time.Now().UTC().Format(time.RFC3339), Detail: "No configuration."}
	}
	return license.Current(pkg, cur, s.Cfg.Deployment.ID, s.Cfg.Deployment.InstallationID, time.Now())
}

// remoteStatus summarizes remote command handling for the local admin (no secrets).
func (s *Server) remoteStatus() map[string]any {
	dir := s.RemoteDir
	if dir == "" {
		dir = remote.DefaultDir
	}
	out := map[string]any{"commands": remote.ReadStatus(dir), "stagedUpgrade": nil, "version": s.Version}
	if o, err := remote.ReadOrder(dir); err == nil && o != nil {
		out["stagedUpgrade"] = o
	}
	return out
}

func agentStatus() map[string]any {
	st := map[string]any{"enrolled": false, "state": "unknown", "detail": "The agent has not reported its status yet."}
	b, err := os.ReadFile(config.Env("PSA_EDGE_AGENT_STATUS", "/var/log/psa-edge/agent-status.json"))
	if err != nil {
		return st
	}
	var v map[string]any
	if json.Unmarshal(b, &v) != nil {
		return st
	}
	return v
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request, se *session) {
	s.render(w, http.StatusOK, "dashboard.html", viewData{Title: "Appliance status", Session: se, Data: s.collectStatus(r.Context())})
}

func (s *Server) statusJSON(w http.ResponseWriter, r *http.Request, _ *session) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.collectStatus(r.Context()))
}

// Serve runs the HTTP server until ctx is cancelled.
func Serve(ctx context.Context, addr string, h http.Handler, log *slog.Logger) error {
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 16}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shut)
	}()
	log.Info("edge-api listening", "addr", addr)
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// ---------------------------------------------------------------------------
// Module 17: "Delete all data and deregister" — the client ends the service from the appliance.
// ---------------------------------------------------------------------------

type deletionView struct {
	Code        string
	Project     string
	Requested   bool
	Status      *agent.DeletionStatus
	LocalOnly   bool
	PhaseLabel  string
	Done        bool
	Refused     bool
	InProgress  bool
	Notified    bool
	AgentState  string
	ControlRows []string
	// AuditEventID: the one record the Control Plane keeps (templates print values, not pointers).
	AuditEventID string
}

var deletionPhaseLabels = map[string]string{
	"requested":     "Deletion requested",
	"deregistering": "Deregistering from the Control Plane",
	"deregistered":  "Deregistered; deleting local data",
	"wiping":        "Deleting local data",
	"wiped":         "All data deleted",
	"refused":       "The Control Plane refused the deregistration",
}

func (s *Server) deletionView() deletionView {
	v := deletionView{Code: s.Cfg.Deployment.Code, Project: "psacc-" + strings.ToLower(s.Cfg.Deployment.Code)}
	st, _ := agentStatus()["state"].(string)
	v.AgentState = st
	if req := agent.ReadDeletionRequest(s.deletionDir()); req != nil {
		v.Requested, v.LocalOnly = true, req.LocalOnly
		v.Status = agent.ReadDeletionStatus(s.deletionDir())
		if v.Status == nil {
			v.PhaseLabel = "Deletion requested; waiting for the agent"
			v.InProgress = true
			return v
		}
		v.PhaseLabel = deletionPhaseLabels[v.Status.Phase]
		v.Done = v.Status.Phase == "wiped"
		v.Refused = v.Status.Phase == "refused" && !req.LocalOnly
		v.InProgress = !v.Done && !v.Refused
		v.Notified = v.Status.ControlPlaneNotified
		if v.Status.AuditEventID != nil {
			v.AuditEventID = *v.Status.AuditEventID
		}
		for k, n := range v.Status.ControlPlaneDeleted {
			v.ControlRows = append(v.ControlRows, fmt.Sprintf("%s: %d", k, n))
		}
		sort.Strings(v.ControlRows)
	}
	return v
}

// deletionPage: the confirmation form while nothing was requested (signed in); the progress afterwards,
// readable without a session, because the local admin accounts are deleted with everything else.
func (s *Server) deletionPage(w http.ResponseWriter, r *http.Request) {
	if agent.ReadDeletionRequest(s.deletionDir()) == nil {
		s.page(func(w http.ResponseWriter, r *http.Request, se *session) {
			s.render(w, http.StatusOK, "deletion.html", viewData{Title: "Delete all data", Session: se, Fields: map[string]string{}, Data: s.deletionView()})
		})(w, r)
		return
	}
	s.render(w, http.StatusOK, "deletion.html", viewData{Title: "Deletion", Session: s.currentSession(r), Fields: map[string]string{}, Data: s.deletionView()})
}

// confirmDeletion checks the typed deployment code, the administrator's password and the acknowledgement.
func (s *Server) confirmDeletion(r *http.Request, se *session) string {
	if !strings.EqualFold(strings.TrimSpace(r.FormValue("confirm")), s.Cfg.Deployment.Code) {
		return "Type the deployment ID " + s.Cfg.Deployment.Code + " exactly to confirm."
	}
	if r.FormValue("acknowledge") != "on" {
		return "Confirm that you understand what is deleted."
	}
	var hash string
	if err := s.Pool.QueryRow(r.Context(), `SELECT password_hash FROM local_admin_users WHERE id = $1`, se.UserID).Scan(&hash); err != nil || !VerifyPassword(hash, r.FormValue("password")) {
		return "The password is not correct."
	}
	return ""
}

func (s *Server) deletionSubmit(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	if agent.ReadDeletionRequest(s.deletionDir()) != nil {
		http.Redirect(w, r, "/deletion", http.StatusSeeOther)
		return
	}
	reason := strings.TrimSpace(r.FormValue("reason"))
	if len(reason) > 500 {
		reason = reason[:500]
	}
	if msg := s.confirmDeletion(r, se); msg != "" {
		s.audit(ctx, "local_admin", se.Username, "local_admin.deletion_requested", s.Cfg.Deployment.Code, "failure", map[string]any{"reason": "confirmation"})
		s.render(w, http.StatusBadRequest, "deletion.html", viewData{Title: "Delete all data", Session: se, Error: msg, Fields: map[string]string{"reason": reason}, Data: s.deletionView()})
		return
	}
	now := time.Now().UTC()
	if _, err := s.Pool.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('service.deletion_requested', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, now.Format(time.RFC3339)+"|"+se.Username); err != nil {
		http.Error(w, "The request could not be recorded.", http.StatusInternalServerError)
		return
	}
	s.audit(ctx, "local_admin", se.Username, "local_admin.deletion_requested", s.Cfg.Deployment.Code, "success", map[string]any{"reason": reason})
	if err := agent.WriteDeletionRequest(s.deletionDir(), agent.DeletionRequest{RequestedAt: now, RequestedBy: se.Username, Reason: reason}); err != nil {
		http.Error(w, "The request could not be handed to the agent: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.Log.Warn("deletion of all data requested by the local administrator", "user", se.Username)
	http.Redirect(w, r, "/deletion", http.StatusSeeOther)
}

// deletionLocal: after a refusal (or without an identity) the administrator may delete the local data anyway.
func (s *Server) deletionLocal(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	req := agent.ReadDeletionRequest(s.deletionDir())
	st := agent.ReadDeletionStatus(s.deletionDir())
	if req == nil || st == nil || st.Phase != "refused" {
		http.Redirect(w, r, "/deletion", http.StatusSeeOther)
		return
	}
	if msg := s.confirmDeletion(r, se); msg != "" {
		s.render(w, http.StatusBadRequest, "deletion.html", viewData{Title: "Deletion", Session: se, Error: msg, Fields: map[string]string{}, Data: s.deletionView()})
		return
	}
	req.LocalOnly = true
	if err := agent.WriteDeletionRequest(s.deletionDir(), *req); err != nil {
		http.Error(w, "The request could not be updated: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.audit(ctx, "local_admin", se.Username, "local_admin.deletion_local_only", s.Cfg.Deployment.Code, "success", map[string]any{"refusal": st.LastError})
	http.Redirect(w, r, "/deletion", http.StatusSeeOther)
}
