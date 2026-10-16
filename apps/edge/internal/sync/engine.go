package sync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"psacc.local/edge/internal/psa"
)

// Engine runs one synchronization at a time against the configured PSA.
type Engine struct {
	Store Store
	Log   *slog.Logger
	// Conn builds the PSA connection (credentials decrypted for the call). It is called once per run.
	Conn func(ctx context.Context) (*psa.Conn, error)
	// Overlap is subtracted from the watermark so clock skew and late writes are not missed (default 5 min).
	Overlap time.Duration
	// InitialWindow bounds the first run (default 30 days).
	InitialWindow time.Duration
	// MaxPages bounds one run (default 50 pages ≈ 5,000 tickets); the watermark advances page by page.
	MaxPages int
	// Now is injectable for tests.
	Now func() time.Time
}

// Summary is the outcome of one run.
type Summary struct {
	RunID         string
	Status        string // succeeded, partial, failed
	ErrorCode     string
	ErrorMessage  string
	Received      int
	Created       int
	Updated       int
	Conflicts     int
	Sent          int
	Failed        int
	Pages         int
	WatermarkFrom time.Time
	WatermarkTo   time.Time
}

var ErrNotVerified = errors.New("the PSA connection is not verified; run the connection test first")

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now().UTC()
}

// Run executes one inbound + outbound pass. It returns an error only for appliance-side problems
// (database, configuration); PSA failures are recorded in the run and reported in the summary.
func (e *Engine) Run(ctx context.Context, trigger string) (Summary, error) {
	overlap, window, maxPages := e.Overlap, e.InitialWindow, e.MaxPages
	if overlap <= 0 {
		overlap = 5 * time.Minute
	}
	if window <= 0 {
		window = 30 * 24 * time.Hour
	}
	if maxPages <= 0 {
		maxPages = 50
	}
	start := e.now()
	status, err := e.Store.ConnectionStatus(ctx)
	if err != nil {
		return Summary{}, err
	}
	wm, err := e.Store.Watermark(ctx)
	if err != nil {
		return Summary{}, err
	}
	from := start.Add(-window)
	if wm != nil {
		from = wm.Add(-overlap)
	}
	s := Summary{WatermarkFrom: from, WatermarkTo: start}
	runID, err := e.Store.BeginRun(ctx, trigger, from)
	if err != nil {
		return Summary{}, err
	}
	s.RunID = runID
	finish := func(st, code, msg string) (Summary, error) {
		s.Status, s.ErrorCode, s.ErrorMessage = st, code, msg
		fin := e.now()
		rec := RunRecord{ID: runID, Trigger: trigger, Status: st, StartedAt: start, FinishedAt: &fin, ItemsReceived: s.Received, ItemsSent: s.Sent, ItemsFailed: s.Failed, ErrorCode: code, ErrorMessage: msg, Pages: s.Pages}
		if ferr := e.Store.FinishRun(ctx, runID, rec); ferr != nil {
			return s, ferr
		}
		if st == "failed" {
			_ = e.Store.LogError(ctx, code, 0, "Synchronization failed: "+msg)
		}
		return s, nil
	}
	if status != "verified" {
		return finish("failed", "psa_not_verified", ErrNotVerified.Error())
	}
	conn, err := e.Conn(ctx)
	if err != nil {
		return finish("failed", "credentials_unavailable", err.Error())
	}
	if !psa.SyncSupported(conn.Provider) {
		return finish("failed", "sync_unsupported", "Ticket synchronization is not implemented for provider "+conn.Provider+" in this version.")
	}

	// ---- inbound: mirror what changed in the PSA since the watermark ----
	page := ""
	var newest time.Time
	inboundOK := true
	for {
		if s.Pages >= maxPages {
			break
		}
		tp := psa.ListTickets(ctx, conn, from, page)
		s.Pages++
		if !tp.Result.OK {
			inboundOK = false
			_ = e.Store.LogError(ctx, tp.Result.Code, tp.Result.HTTPStatus, "Ticket listing failed: "+tp.Result.Detail)
			s.ErrorCode, s.ErrorMessage = tp.Result.Code, tp.Result.Detail
			break
		}
		for _, t := range tp.Tickets {
			u, err := e.Store.ApplyRemote(ctx, t, e.now())
			if err != nil {
				return finish("failed", "store_error", err.Error())
			}
			s.Received++
			if u.Created {
				s.Created++
			} else if u.Changed {
				s.Updated++
			}
			if u.Conflict {
				s.Conflicts++
			}
			if t.UpdatedAt.After(newest) {
				newest = t.UpdatedAt
			}
		}
		if tp.NextPage == "" {
			break
		}
		page = tp.NextPage
	}
	if inboundOK {
		// The watermark is the later of the run start and the PSA clock of the newest ticket seen; the overlap
		// on the next run covers clock skew and writes that landed meanwhile.
		w := start
		if newest.After(w) {
			w = newest
		}
		if err := e.Store.SaveWatermark(ctx, w); err != nil {
			return finish("failed", "store_error", err.Error())
		}
		s.WatermarkTo = w
	}

	// ---- outbound: local changes waiting for the PSA ----
	pushes, err := e.Store.PendingPushes(ctx, 200)
	if err != nil {
		return finish("failed", "store_error", err.Error())
	}
	for _, p := range pushes {
		var r psa.Result
		externalID := p.ExternalID
		switch p.EventType {
		case "created":
			if p.ExternalID != "" {
				r = psa.Result{OK: true, Code: psa.CodeOK}
				break
			}
			externalID, r = psa.CreateTicket(ctx, conn, p.Ticket)
		case "status_changed":
			if p.ExternalID == "" {
				r = psa.Result{Code: psa.CodeUnsupported, Detail: "The ticket does not exist in the PSA yet."}
				break
			}
			st := p.Status
			r = psa.UpdateTicket(ctx, conn, p.ExternalID, psa.TicketPatch{Status: &st})
		case "note_added":
			if p.ExternalID == "" {
				r = psa.Result{Code: psa.CodeUnsupported, Detail: "The ticket does not exist in the PSA yet."}
				break
			}
			r = psa.AddNote(ctx, conn, p.ExternalID, p.NoteTitle, p.NoteText)
		default:
			r = psa.Result{OK: true, Code: psa.CodeOK}
		}
		if r.OK {
			s.Sent++
			if err := e.Store.MarkPushed(ctx, p, externalID, "", e.now()); err != nil {
				return finish("failed", "store_error", err.Error())
			}
			continue
		}
		s.Failed++
		msg := fmt.Sprintf("%s (%s)", r.Detail, r.Code)
		if err := e.Store.MarkPushed(ctx, p, "", msg, e.now()); err != nil {
			return finish("failed", "store_error", err.Error())
		}
		_ = e.Store.LogError(ctx, r.Code, r.HTTPStatus, "Push of a local "+p.EventType+" change failed: "+r.Detail)
		if r.Code == psa.CodeAuthFailed || r.Code == psa.CodeUnreachable || r.Code == psa.CodeTimeout || r.Code == psa.CodeTLSError {
			// The PSA is not reachable or rejects us: stop pushing, the remaining changes stay pending.
			s.ErrorCode, s.ErrorMessage = r.Code, r.Detail
			break
		}
	}

	switch {
	case !inboundOK && s.Received == 0 && s.Sent == 0:
		return finish("failed", s.ErrorCode, s.ErrorMessage)
	case !inboundOK || s.Failed > 0:
		code, msg := s.ErrorCode, s.ErrorMessage
		if code == "" {
			code, msg = "push_failed", fmt.Sprintf("%d local change(s) could not be pushed.", s.Failed)
		}
		return finish("partial", code, msg)
	default:
		return finish("succeeded", "", "")
	}
}
