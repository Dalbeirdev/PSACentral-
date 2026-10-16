package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"psacc.local/edge/internal/psa"
	edgesync "psacc.local/edge/internal/sync"
	"psacc.local/edge/internal/worker"
)

// Ticket management on the appliance (Module 12): the local database is the system of record. Changes
// made here become ticket_events of source "portal" that the worker pushes to the PSA on its next run.

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type ticketRow struct {
	ID             string
	ExternalID     *string
	Title          string
	Description    *string
	Status         string
	PSAStatus      *string
	Priority       string
	RequesterEmail *string
	Origin         string
	SyncState      string
	ResolvedAt     *time.Time
	ExternalAt     *time.Time
	LastSyncedAt   *time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type ticketEvent struct {
	ID        string
	Type      string
	Source    string
	Payload   map[string]any
	At        time.Time
	PushedAt  *time.Time
	PushError *string
}

type syncRunRow struct {
	ID            string
	Trigger       string
	Status        string
	StartedAt     time.Time
	FinishedAt    *time.Time
	ItemsReceived int
	ItemsSent     int
	ItemsFailed   int
	ErrorCode     *string
	ErrorMessage  *string
	Pages         int
}

func (s *Server) ticketsList(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	status, q, state := r.URL.Query().Get("status"), strings.TrimSpace(r.URL.Query().Get("q")), r.URL.Query().Get("sync")
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	const pageSize = 50
	where, args := []string{"true"}, []any{}
	if status != "" {
		args = append(args, status)
		where = append(where, "status = $"+strconv.Itoa(len(args)))
	}
	if state != "" {
		args = append(args, state)
		where = append(where, "sync_state = $"+strconv.Itoa(len(args)))
	}
	if q != "" {
		args = append(args, "%"+q+"%")
		where = append(where, "(title ILIKE $"+strconv.Itoa(len(args))+" OR coalesce(external_ticket_id, '') ILIKE $"+strconv.Itoa(len(args))+" OR coalesce(requester_email, '') ILIKE $"+strconv.Itoa(len(args))+")")
	}
	var total int
	_ = s.Pool.QueryRow(ctx, `SELECT count(*) FROM helpdesk_tickets WHERE `+strings.Join(where, " AND "), args...).Scan(&total)
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.Pool.Query(ctx, `SELECT id, external_ticket_id, title, status, psa_status, priority, requester_email, origin, sync_state, resolved_at, external_updated_at, last_synced_at, created_at, updated_at
		FROM helpdesk_tickets WHERE `+strings.Join(where, " AND ")+` ORDER BY updated_at DESC LIMIT $`+strconv.Itoa(len(args)-1)+` OFFSET $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		http.Error(w, "Tickets could not be read.", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	var list []ticketRow
	for rows.Next() {
		var t ticketRow
		if err := rows.Scan(&t.ID, &t.ExternalID, &t.Title, &t.Status, &t.PSAStatus, &t.Priority, &t.RequesterEmail, &t.Origin, &t.SyncState, &t.ResolvedAt, &t.ExternalAt, &t.LastSyncedAt, &t.CreatedAt, &t.UpdatedAt); err == nil {
			list = append(list, t)
		}
	}
	counts := map[string]int{}
	if crow, err := s.Pool.Query(ctx, `SELECT status, count(*) FROM helpdesk_tickets GROUP BY status`); err == nil {
		for crow.Next() {
			var st string
			var n int
			if crow.Scan(&st, &n) == nil {
				counts[st] = n
			}
		}
		crow.Close()
	}
	s.render(w, http.StatusOK, "tickets.html", viewData{Title: "Tickets", Session: se, Data: map[string]any{
		"Tickets": list, "Total": total, "Page": page, "PageSize": pageSize, "HasMore": page*pageSize < total, "Status": status, "Query": q, "Sync": state, "Counts": counts, "Statuses": psa.Statuses, "Saved": r.URL.Query().Get("saved"),
	}})
}

func (s *Server) ticketNewForm(w http.ResponseWriter, r *http.Request, se *session) {
	s.render(w, http.StatusOK, "ticket-new.html", viewData{Title: "New ticket", Session: se, Data: map[string]any{"Priorities": psa.Priorities, "CanCreateInPSA": s.Cfg.PSA.Provider == "custom_rest", "Provider": s.Cfg.PSA.Provider}})
}

func (s *Server) ticketCreate(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	title, desc, prio, email := strings.TrimSpace(r.FormValue("title")), strings.TrimSpace(r.FormValue("description")), r.FormValue("priority"), strings.TrimSpace(r.FormValue("requester_email"))
	fail := func(msg string) {
		s.render(w, http.StatusUnprocessableEntity, "ticket-new.html", viewData{Title: "New ticket", Session: se, Error: msg, Fields: map[string]string{"title": title, "description": desc, "priority": prio, "requester_email": email},
			Data: map[string]any{"Priorities": psa.Priorities, "CanCreateInPSA": s.Cfg.PSA.Provider == "custom_rest", "Provider": s.Cfg.PSA.Provider}})
	}
	if len(title) < 3 || len(title) > 500 {
		fail("Enter a title (3–500 characters).")
		return
	}
	if len(desc) > 100000 {
		fail("The description is too long.")
		return
	}
	if !contains(psa.Priorities, prio) {
		fail("Choose a priority.")
		return
	}
	if email != "" && (len(email) > 254 || !strings.Contains(email, "@")) {
		fail("Enter a valid requester e-mail or leave it empty.")
		return
	}
	var id string
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		state := "pending_push"
		if !psa.SyncSupported(s.Cfg.PSA.Provider) || s.Cfg.PSA.Provider != "custom_rest" {
			state = "local_only"
		}
		if err := tx.QueryRow(ctx, `INSERT INTO helpdesk_tickets (title, description, status, priority, requester_email, origin, sync_state, local_changed_at) VALUES ($1, $2, 'new', $3, $4, 'portal', $5, now()) RETURNING id`,
			title, nilIfEmpty(desc), prio, nilIfEmpty(email), state).Scan(&id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO ticket_events (ticket_id, event_type, source, payload) VALUES ($1, 'created', 'portal', $2)`, id, mustJSON(map[string]any{"by": se.Username, "status": "new", "priority": prio}))
		return err
	})
	if err != nil {
		fail("The ticket could not be saved.")
		return
	}
	s.audit(ctx, "local_admin", se.Username, "ticket.created", id, "success", map[string]any{"priority": prio})
	http.Redirect(w, r, "/tickets/"+id+"?saved=created", http.StatusSeeOther)
}

func (s *Server) loadTicket(ctx context.Context, id string) (*ticketRow, []ticketEvent, error) {
	var t ticketRow
	err := s.Pool.QueryRow(ctx, `SELECT id, external_ticket_id, title, description, status, psa_status, priority, requester_email, origin, sync_state, resolved_at, external_updated_at, last_synced_at, created_at, updated_at
		FROM helpdesk_tickets WHERE id = $1`, id).Scan(&t.ID, &t.ExternalID, &t.Title, &t.Description, &t.Status, &t.PSAStatus, &t.Priority, &t.RequesterEmail, &t.Origin, &t.SyncState, &t.ResolvedAt, &t.ExternalAt, &t.LastSyncedAt, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT id, event_type, source, payload, occurred_at, pushed_at, push_error FROM ticket_events WHERE ticket_id = $1 ORDER BY occurred_at DESC, created_at DESC LIMIT 200`, id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var events []ticketEvent
	for rows.Next() {
		var e ticketEvent
		var payload []byte
		if err := rows.Scan(&e.ID, &e.Type, &e.Source, &payload, &e.At, &e.PushedAt, &e.PushError); err == nil {
			_ = json.Unmarshal(payload, &e.Payload)
			events = append(events, e)
		}
	}
	return &t, events, nil
}

func (s *Server) ticketDetail(w http.ResponseWriter, r *http.Request, se *session) {
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	t, events, err := s.loadTicket(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "The ticket could not be read.", http.StatusInternalServerError)
		return
	}
	s.render(w, http.StatusOK, "ticket.html", viewData{Title: "Ticket", Session: se, Data: map[string]any{"T": t, "Events": events, "Statuses": psa.Statuses, "Saved": r.URL.Query().Get("saved"), "Provider": s.Cfg.PSA.Provider}})
}

// ticketUpdate records a local status change or note; the worker pushes it to the PSA.
func (s *Server) ticketUpdate(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	t, _, err := s.loadTicket(ctx, id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	action := r.FormValue("action")
	var saved string
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		switch action {
		case "status":
			st := r.FormValue("status")
			if !contains(psa.Statuses, st) {
				return errors.New("Choose a status.")
			}
			if st == t.Status {
				return errors.New("The ticket already has that status.")
			}
			resolved := "NULL"
			if st == "resolved" || st == "closed" {
				resolved = "coalesce(resolved_at, now())"
			}
			if _, err := tx.Exec(ctx, `UPDATE helpdesk_tickets SET status = $2, resolved_at = `+resolved+`, local_changed_at = now(),
				sync_state = CASE WHEN external_ticket_id IS NULL THEN sync_state ELSE 'pending_push' END WHERE id = $1`, id, st); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO ticket_events (ticket_id, event_type, source, payload) VALUES ($1, 'status_changed', 'portal', $2)`, id, mustJSON(map[string]any{"by": se.Username, "from": t.Status, "status": st}))
			saved = "status"
			return err
		case "note":
			text := strings.TrimSpace(r.FormValue("text"))
			if len(text) < 1 || len(text) > 32000 {
				return errors.New("Enter the note text (up to 32,000 characters).")
			}
			if _, err := tx.Exec(ctx, `UPDATE helpdesk_tickets SET local_changed_at = now(), sync_state = CASE WHEN external_ticket_id IS NULL THEN sync_state ELSE 'pending_push' END WHERE id = $1`, id); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO ticket_events (ticket_id, event_type, source, payload) VALUES ($1, 'note_added', 'portal', $2)`, id, mustJSON(map[string]any{"by": se.Username, "title": "Note from " + se.Username, "text": text}))
			saved = "note"
			return err
		default:
			return errors.New("Unknown action.")
		}
	})
	if err != nil {
		t2, events, _ := s.loadTicket(ctx, id)
		s.render(w, http.StatusUnprocessableEntity, "ticket.html", viewData{Title: "Ticket", Session: se, Error: err.Error(), Data: map[string]any{"T": t2, "Events": events, "Statuses": psa.Statuses, "Provider": s.Cfg.PSA.Provider}})
		return
	}
	s.audit(ctx, "local_admin", se.Username, "ticket."+saved, id, "success", nil)
	http.Redirect(w, r, "/tickets/"+id+"?saved="+saved, http.StatusSeeOther)
}

func (s *Server) syncPage(w http.ResponseWriter, r *http.Request, se *session) {
	ctx := r.Context()
	rows, err := s.Pool.Query(ctx, `SELECT id, trigger, status, started_at, finished_at, items_received, items_sent, items_failed, error_code, error_message, pages FROM sync_runs ORDER BY started_at DESC LIMIT 20`)
	var runs []syncRunRow
	if err == nil {
		for rows.Next() {
			var x syncRunRow
			if rows.Scan(&x.ID, &x.Trigger, &x.Status, &x.StartedAt, &x.FinishedAt, &x.ItemsReceived, &x.ItemsSent, &x.ItemsFailed, &x.ErrorCode, &x.ErrorMessage, &x.Pages) == nil {
				runs = append(runs, x)
			}
		}
		rows.Close()
	}
	var pending, conflicts, localOnly, pushFailed int
	var lastOK, watermark *time.Time
	var runs24, failed24 int
	_ = s.Pool.QueryRow(ctx, `SELECT pending_outbound, conflicts_24h, last_succeeded_at, runs_24h, failed_runs_24h, tickets_local_only, tickets_push_failed, watermark FROM edge_sync_status()`).Scan(&pending, &conflicts, &lastOK, &runs24, &failed24, &localOnly, &pushFailed, &watermark)
	var requested *string
	_ = s.Pool.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'sync.requested'`).Scan(&requested)
	_, status, _ := s.connectionID(ctx)
	suspended, _ := worker.SuspendedIn(ctx, s.Pool)
	decommissioned := s.lifecycleStatus(ctx)["decommissioned"] == true
	lic := s.licenseVerification()
	s.render(w, http.StatusOK, "sync.html", viewData{Title: "Synchronization", Session: se, Notice: noticeFor(r.URL.Query().Get("requested")), Data: map[string]any{
		"Suspended": suspended, "Decommissioned": decommissioned, "LicenseBlocked": !lic.PSAWorkAllowed, "LicenseState": lic.State, "LicenseDetail": lic.Detail,
		"Runs": runs, "Pending": pending, "Conflicts24h": conflicts, "LocalOnly": localOnly, "PushFailed": pushFailed, "LastSucceededAt": lastOK, "Watermark": watermark, "Runs24h": runs24, "Failed24h": failed24,
		"Requested": requested, "ConnectionStatus": status, "Supported": psa.SyncSupported(s.Cfg.PSA.Provider), "Provider": s.Cfg.PSA.Provider, "Interval": s.SyncInterval,
	}})
}

func noticeFor(v string) string {
	if v == "1" {
		return "Synchronization requested. The worker runs it within its next tick (30 s) and the result appears below."
	}
	return ""
}

// syncRequest asks the worker to run a synchronization now ("Sync now"); the worker, not the UI, talks to the PSA.
func (s *Server) syncRequest(w http.ResponseWriter, r *http.Request, se *session) {
	store := &edgesync.PgStore{Pool: s.Pool, InstanceCode: s.Cfg.PSA.InstanceCode}
	if err := store.RequestManualRun(r.Context(), se.Username); err != nil {
		http.Error(w, "The request could not be recorded.", http.StatusInternalServerError)
		return
	}
	s.audit(r.Context(), "local_admin", se.Username, "sync.requested", s.Cfg.PSA.InstanceCode, "success", nil)
	http.Redirect(w, r, "/sync?requested=1", http.StatusSeeOther)
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func nilIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
