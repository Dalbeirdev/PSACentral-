// Package remote is the appliance-local channel between the agent and the other services for
// remote commands (Module 13). The agent runs with the read-only inspector database role and no
// Docker socket, so it cannot act on the worker or the local API directly; instead it writes a request
// file on the shared logs volume, the target service picks it up, does the work with its own
// privileges and writes a result file. Nothing in this channel carries secrets or ticket content.
package remote

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// Dir is the shared directory (on the edge-logs volume) that holds requests, results and the staged
// upgrade order.
const DefaultDir = "/var/log/psa-edge/remote"

var idPattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)

// Request is what the agent asks a service to do.
type Request struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`    // test_psa_connection | run_sync | restart_service
	Service   string            `json:"service"` // target service name (restart_service)
	Params    map[string]any    `json:"params,omitempty"`
	CreatedAt time.Time         `json:"createdAt"`
	Meta      map[string]string `json:"meta,omitempty"`
}

// Result is the service's answer.
type Result struct {
	ID         string    `json:"id"`
	Status     string    `json:"status"` // succeeded | failed
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	Service    string    `json:"service"`
}

// UpgradeOrder is the signed, verified upgrade the agent staged for the host operator.
type UpgradeOrder struct {
	CommandID   string    `json:"commandId"`
	Repository  string    `json:"repository"`
	Version     string    `json:"version"`
	Digest      *string   `json:"digest"`
	Image       string    `json:"image"` // repository:version[@digest]
	StagedAt    time.Time `json:"stagedAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
	FromVersion string    `json:"fromVersion"`
}

func requestsDir(dir string) string { return filepath.Join(dir, "requests") }
func resultsDir(dir string) string  { return filepath.Join(dir, "results") }

// OrderPath is where the staged upgrade order lives.
func OrderPath(dir string) string { return filepath.Join(dir, "upgrade-order.json") }

func writeAtomic(path string, v any, mode os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// WriteRequest publishes a request for the named service.
func WriteRequest(dir string, r Request) error {
	if !idPattern.MatchString(r.ID) {
		return errors.New("invalid request id")
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now().UTC()
	}
	return writeAtomic(filepath.Join(requestsDir(dir), r.ID+".json"), r, 0o644)
}

// WriteResult publishes a result and removes the request.
func WriteResult(dir string, r Result) error {
	if !idPattern.MatchString(r.ID) {
		return errors.New("invalid result id")
	}
	if err := writeAtomic(filepath.Join(resultsDir(dir), r.ID+".json"), r, 0o644); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(requestsDir(dir), r.ID+".json"))
	return nil
}

// ReadResult returns the result for a request if the service answered, and deletes it when `consume`.
func ReadResult(dir, id string, consume bool) (*Result, error) {
	if !idPattern.MatchString(id) {
		return nil, errors.New("invalid id")
	}
	p := filepath.Join(resultsDir(dir), id+".json")
	b, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if consume {
		_ = os.Remove(p)
	}
	return &r, nil
}

// Pending lists the requests addressed to a service (oldest first). Requests older than maxAge are
// discarded as stale (the agent reported them as unanswered long ago).
func Pending(dir, service string, maxAge time.Duration) ([]Request, error) {
	entries, err := filepath.Glob(filepath.Join(requestsDir(dir), "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(entries)
	var out []Request
	for _, p := range entries {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var r Request
		if err := json.Unmarshal(b, &r); err != nil || r.Service != service {
			continue
		}
		if maxAge > 0 && time.Since(r.CreatedAt) > maxAge {
			_ = os.Remove(p)
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

// Handler answers one request for a service. Returning exit = true asks the process to stop cleanly
// after the result is written (restart_service: Compose starts it again).
type Handler func(ctx context.Context, r Request) (res Result, exit bool)

// Serve polls for requests addressed to `service` until ctx ends or a handler asks to exit. The returned
// error is nil on a clean exit request so callers can stop their process with status 0.
func Serve(ctx context.Context, dir, service string, every time.Duration, h Handler) error {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		reqs, _ := Pending(dir, service, 10*time.Minute)
		for _, r := range reqs {
			started := time.Now().UTC()
			res, exit := h(ctx, r)
			res.ID, res.Service = r.ID, service
			if res.StartedAt.IsZero() {
				res.StartedAt = started
			}
			if res.FinishedAt.IsZero() {
				res.FinishedAt = time.Now().UTC()
			}
			_ = WriteResult(dir, res)
			if exit {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// StageUpgrade records the verified order; ReadOrder / ClearOrder manage it.
func StageUpgrade(dir string, o UpgradeOrder) error { return writeAtomic(OrderPath(dir), o, 0o644) }

func ReadOrder(dir string) (*UpgradeOrder, error) {
	b, err := os.ReadFile(OrderPath(dir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var o UpgradeOrder
	if err := json.Unmarshal(b, &o); err != nil {
		return nil, err
	}
	return &o, nil
}

func ClearOrder(dir string) error {
	err := os.Remove(OrderPath(dir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// CommandRecord is what the local admin UI shows about a remote command the agent handled.
type CommandRecord struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	ReceivedAt time.Time `json:"receivedAt"`
	Status     string    `json:"status"`
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	Reported   bool      `json:"reported"`
}

// StatusPath is the agent's command history for the local admin UI (no secrets).
func StatusPath(dir string) string { return filepath.Join(dir, "commands-status.json") }

func WriteStatus(dir string, records []CommandRecord) error {
	return writeAtomic(StatusPath(dir), records, 0o644)
}

func ReadStatus(dir string) []CommandRecord {
	b, err := os.ReadFile(StatusPath(dir))
	if err != nil {
		return nil
	}
	var out []CommandRecord
	_ = json.Unmarshal(b, &out)
	return out
}
