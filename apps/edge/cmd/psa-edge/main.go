// psa-edge is the single binary of the standard PSA Edge image. It is invoked through the
// entrypoints edge-migrate, edge-api, edge-worker and edge-agent (symlinks), or as
// `psa-edge <command>`.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"psacc.local/edge/internal/agent"
	"psacc.local/edge/internal/api"
	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/db"
	"psacc.local/edge/internal/migrate"
	"psacc.local/edge/internal/psa"
	"psacc.local/edge/internal/remote"
	"psacc.local/edge/internal/secretbox"
	"psacc.local/edge/internal/worker"
)

// Version is set at build time (-ldflags "-X main.Version=...").
var Version = "0.0.0-dev"

func main() {
	cmd, args := filepath.Base(os.Args[0]), os.Args[1:]
	if cmd == "psa-edge" || cmd == "psa-edge.exe" {
		if len(args) == 0 {
			usage()
			os.Exit(2)
		}
		cmd, args = args[0], args[1:]
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})).With("component", cmd, "version", Version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cmd, args, log); err != nil {
		log.Error("failed", "err", err.Error())
		fmt.Fprintln(os.Stderr, "ERROR:", err)
		os.Exit(1)
	}
}

// syncInterval reads PSA_EDGE_SYNC_INTERVAL (default 5m, at least 20s).
// remoteDir is the shared directory for remote command hand-over (Module 13).
func remoteDir() string { return config.Env("PSA_EDGE_REMOTE_DIR", remote.DefaultDir) }

func syncInterval() time.Duration {
	if d, err := time.ParseDuration(config.Env("PSA_EDGE_SYNC_INTERVAL", "5m")); err == nil && d >= 20*time.Second {
		return d
	}
	return 5 * time.Minute
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: psa-edge <command>
  edge-migrate up|status      initialize / upgrade the database (idempotent)
  edge-api [healthcheck]      local application API and admin UI
  edge-worker                 PSA integration worker
  edge-agent [status [--require-enrolled] | renew]
  version`)
}

func load() (*config.Edge, config.Secrets, error) {
	cfg, err := config.LoadEdge(config.Env("PSA_EDGE_CONFIG", "/etc/psa-edge/edge.json"))
	return cfg, config.Secrets{Dir: config.Env("PSA_EDGE_SECRETS_DIR", "/run/secrets")}, err
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func run(ctx context.Context, cmd string, args []string, log *slog.Logger) error {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	switch cmd {
	case "version":
		fmt.Println(Version)
		return nil

	case "edge-migrate":
		cfg, secrets, err := load()
		if err != nil {
			return err
		}
		switch sub {
		case "", "up":
			res, err := migrate.Up(ctx, cfg, secrets)
			if err != nil {
				return err
			}
			log.Info("database ready", "deployment", res.DeploymentCode, "applied", len(res.Applied), "schemaVersion", res.SchemaVersion, "tables", len(res.Tables), "verified", res.Verified)
			printJSON(res)
			return nil
		case "status":
			pool, err := db.Open(ctx, db.Owner, secrets, 1, 10*time.Second)
			if err != nil {
				return err
			}
			defer pool.Close()
			st, err := migrate.Status(ctx, pool)
			if err != nil {
				return err
			}
			printJSON(st)
			return nil
		}

	case "edge-api":
		if sub == "healthcheck" {
			c := http.Client{Timeout: 4 * time.Second}
			r, err := c.Get("http://127.0.0.1:" + config.Env("PSA_EDGE_API_PORT", "8480") + "/healthz")
			if err != nil {
				return err
			}
			defer r.Body.Close()
			if r.StatusCode != http.StatusOK {
				return fmt.Errorf("unhealthy: HTTP %d", r.StatusCode)
			}
			return nil
		}
		cfg, secrets, err := load()
		if err != nil {
			return err
		}
		key, err := secrets.DataKey()
		if err != nil {
			return err
		}
		box, err := secretbox.New(key)
		if err != nil {
			return err
		}
		pool, err := db.Open(ctx, db.App, secrets, 8, 90*time.Second)
		if err != nil {
			return err
		}
		defer pool.Close()
		srv := &api.Server{Cfg: cfg, Pool: pool, Box: box, Version: Version, Log: log, Tester: &psa.Tester{Cfg: cfg, Pool: pool, Box: box, Log: log, Timeout: 20 * time.Second}, SyncInterval: syncInterval().String(), RemoteDir: remoteDir()}
		h, err := srv.Handler()
		if err != nil {
			return err
		}
		// Remote restart (Module 13): a signed command relayed by the agent asks this process to exit
		// cleanly; Docker Compose starts it again.
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() {
			if err := remote.Serve(ctx, remoteDir(), "edge-api", 2*time.Second, func(ctx context.Context, r remote.Request) (remote.Result, bool) {
				if r.Type != "restart_service" {
					return remote.Result{Status: "failed", Code: "type_not_allowed", Message: "The local API does not handle this request."}, false
				}
				log.Info("restart requested by a signed remote command; exiting so Docker Compose starts the API again")
				return remote.Result{Status: "succeeded", Code: "restarting", Message: "The local API exits after this answer; Docker Compose starts it again."}, true
			}); err == nil {
				cancel()
			}
		}()
		return api.Serve(ctx, "0.0.0.0:"+config.Env("PSA_EDGE_API_PORT", "8480"), h, log)

	case "edge-worker":
		cfg, secrets, err := load()
		if err != nil {
			return err
		}
		key, err := secrets.DataKey()
		if err != nil {
			return err
		}
		box, err := secretbox.New(key)
		if err != nil {
			return err
		}
		pool, err := db.Open(ctx, db.App, secrets, 4, 90*time.Second)
		if err != nil {
			return err
		}
		defer pool.Close()
		testEvery := 15 * time.Minute
		if d, err := time.ParseDuration(config.Env("PSA_EDGE_PSA_TEST_INTERVAL", "15m")); err == nil && d >= time.Minute {
			testEvery = d
		}
		w := &worker.Worker{Cfg: cfg, Pool: pool, Log: log, Interval: 30 * time.Second,
			Tester: &psa.Tester{Cfg: cfg, Pool: pool, Box: box, Log: log, Timeout: 20 * time.Second}, TestInterval: testEvery, SyncInterval: syncInterval(), RemoteDir: remoteDir()}
		if err := w.Run(ctx); err != nil && !errors.Is(err, worker.ErrRestartRequested) {
			return err
		}
		return nil

	case "edge-agent":
		cfg, secrets, err := load()
		if err != nil {
			return err
		}
		a := &agent.Agent{Cfg: cfg, Version: Version, Log: log,
			EnrollmentPath: config.Env("PSA_EDGE_ENROLLMENT", "/etc/psa-edge/enrollment.json"),
			OutboxDir:      config.Env("PSA_EDGE_OUTBOX", "/var/log/psa-edge/outbox"),
			StateDir:       config.Env("PSA_EDGE_AGENT_STATE", "/var/lib/psa-edge-agent"),
			StatusFile:     config.Env("PSA_EDGE_AGENT_STATUS", "/var/log/psa-edge/agent-status.json"),
			RemoteDir:      remoteDir()}
		if sub == "renew" {
			if err := a.Renew(ctx); err != nil {
				return err
			}
			printJSON(a.Status())
			return nil
		}
		if sub == "status" {
			st := a.Status()
			printJSON(st)
			for _, f := range args[1:] {
				if f == "--require-enrolled" && !st.Enrolled {
					return agent.ErrNotEnrolled
				}
			}
			return nil
		}
		pool, err := db.Open(ctx, db.Inspector, secrets, 2, 90*time.Second)
		if err != nil {
			log.Warn("database not reachable; reporting it as unavailable", "err", err.Error())
		} else {
			defer pool.Close()
			a.Pool = pool
		}
		interval := time.Duration(cfg.ControlPlane.HeartbeatIntervalSeconds) * time.Second
		if err := a.Run(ctx, interval); err != nil && !errors.Is(err, agent.ErrRestartRequested) {
			return err
		}
		return nil
	}
	usage()
	return fmt.Errorf("unknown command %q", strings.TrimSpace(cmd+" "+sub))
}
