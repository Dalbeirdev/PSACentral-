package sync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/psa"
)

// PgStore is the Store on the appliance database.
type PgStore struct {
	Pool         *pgxpool.Pool
	InstanceCode string
}

func (s *PgStore) connID(ctx context.Context) (string, string, error) {
	var id, status string
	err := s.Pool.QueryRow(ctx, `SELECT id, status FROM psa_connections WHERE instance_code = $1`, s.InstanceCode).Scan(&id, &status)
	return id, status, err
}

func (s *PgStore) ConnectionStatus(ctx context.Context) (string, error) {
	_, status, err := s.connID(ctx)
	return status, err
}

func (s *PgStore) Watermark(ctx context.Context) (*time.Time, error) {
	var v *string
	if err := s.Pool.QueryRow(ctx, `SELECT value FROM app_metadata WHERE key = 'sync.inbound.watermark'`).Scan(&v); err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339Nano, *v)
	if err != nil {
		return nil, nil
	}
	return &t, nil
}

func (s *PgStore) SaveWatermark(ctx context.Context, t time.Time) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('sync.inbound.watermark', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, t.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *PgStore) BeginRun(ctx context.Context, trigger string, from time.Time) (string, error) {
	connID, _, err := s.connID(ctx)
	if err != nil {
		return "", err
	}
	var id string
	err = s.Pool.QueryRow(ctx, `INSERT INTO sync_runs (psa_connection_id, direction, status, trigger, watermark_from) VALUES ($1, 'both', 'running', $2, $3) RETURNING id`, connID, trigger, from).Scan(&id)
	return id, err
}

func (s *PgStore) FinishRun(ctx context.Context, runID string, r RunRecord) error {
	var code, msg any
	if r.ErrorCode != "" {
		code = r.ErrorCode
	}
	if r.ErrorMessage != "" {
		msg = left(r.ErrorMessage, 500)
	}
	_, err := s.Pool.Exec(ctx, `UPDATE sync_runs SET status = $2, finished_at = $3, items_received = $4, items_sent = $5, items_failed = $6, error_code = $7, error_message = $8, pages = $9, watermark_to = $3 WHERE id = $1`,
		runID, r.Status, r.FinishedAt, r.ItemsReceived, r.ItemsSent, r.ItemsFailed, code, msg, r.Pages)
	return err
}

func hashPayload(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// ApplyRemote upserts the mirrored ticket. A pending local status change that the PSA has since
// overtaken is a conflict: the PSA's status wins, the local event is marked superseded, the conflict
// is recorded on the ticket's timeline.
func (s *PgStore) ApplyRemote(ctx context.Context, t psa.RemoteTicket, now time.Time) (Upsert, error) {
	var out Upsert
	connID, _, err := s.connID(ctx)
	if err != nil {
		return out, err
	}
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		var id, status, priority, title, syncState string
		var extUpdated *time.Time
		err := tx.QueryRow(ctx, `SELECT id, status, priority, title, sync_state, external_updated_at FROM helpdesk_tickets WHERE psa_connection_id = $1 AND external_ticket_id = $2 FOR UPDATE`, connID, t.ExternalID).Scan(&id, &status, &priority, &title, &syncState, &extUpdated)
		fields := map[string]any{"title": t.Title, "status": t.Status, "psaStatus": t.PSAStatus, "priority": t.Priority, "psaPriority": t.PSAPriority, "updatedAt": t.UpdatedAt.UTC().Format(time.RFC3339Nano)}
		idem := "psa:" + t.ExternalID + ":" + t.UpdatedAt.UTC().Format(time.RFC3339Nano) + ":" + hashPayload(fields)[:16]
		var resolved any
		if t.ResolvedAt != nil {
			resolved = *t.ResolvedAt
		} else if t.Status == "resolved" || t.Status == "closed" {
			resolved = t.UpdatedAt // the PSA says it is done but gave no time: use its last activity
		}
		if err == pgx.ErrNoRows {
			var newID string
			if err := tx.QueryRow(ctx, `INSERT INTO helpdesk_tickets (psa_connection_id, external_ticket_id, provider, title, description, status, psa_status, priority, psa_priority, requester_email,
				sla_resolution_due_at, resolved_at, external_updated_at, origin, sync_state, last_synced_at, created_at)
				VALUES ($1, $2, (SELECT provider FROM psa_connections WHERE id = $1), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'psa', 'synced', $13, coalesce($14, now())) RETURNING id`,
				connID, t.ExternalID, t.Title, nilIfEmpty(t.Description), t.Status, nilIfEmpty(t.PSAStatus), t.Priority, nilIfEmpty(t.PSAPriority), nilIfEmpty(t.RequesterEmail),
				t.DueAt, resolved, t.UpdatedAt, now, t.CreatedAt).Scan(&newID); err != nil {
				return err
			}
			out.Created = true
			_, err := tx.Exec(ctx, `INSERT INTO ticket_events (ticket_id, event_type, source, idempotency_key, payload_hash, payload, occurred_at) VALUES ($1, 'created', 'psa', $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
				newID, idem, hashPayload(fields), mustJSON(map[string]any{"externalId": t.ExternalID, "status": t.Status, "priority": t.Priority}), t.UpdatedAt)
			return err
		}
		if err != nil {
			return err
		}
		// Already mirrored at this PSA version? Then only refresh the sync time.
		if extUpdated != nil && !t.UpdatedAt.After(*extUpdated) {
			_, err := tx.Exec(ctx, `UPDATE helpdesk_tickets SET last_synced_at = $2 WHERE id = $1`, id, now)
			return err
		}
		changed := status != t.Status || priority != t.Priority || title != t.Title
		if syncState == "pending_push" && status != t.Status {
			// The PSA moved the ticket while a local status change waited: the PSA wins.
			out.Conflict = true
			if _, err := tx.Exec(ctx, `UPDATE ticket_events SET pushed_at = $2, push_error = 'superseded: the PSA changed the status first' WHERE ticket_id = $1 AND source = 'portal' AND event_type = 'status_changed' AND pushed_at IS NULL`, id, now); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO ticket_events (ticket_id, event_type, source, payload, occurred_at) VALUES ($1, 'sync_conflict', 'system', $2, $3)`,
				id, mustJSON(map[string]any{"localStatus": status, "psaStatus": t.Status, "resolution": "psa_wins"}), now); err != nil {
				return err
			}
		}
		// Notes still pending keep the ticket in pending_push; otherwise the mirror is in sync again.
		var pendingNotes int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM ticket_events WHERE ticket_id = $1 AND source = 'portal' AND pushed_at IS NULL`, id).Scan(&pendingNotes); err != nil {
			return err
		}
		newState := "synced"
		if pendingNotes > 0 && !out.Conflict {
			newState = syncState
		} else if pendingNotes > 0 {
			newState = "pending_push"
		} else if out.Conflict {
			newState = "conflict"
		}
		if _, err := tx.Exec(ctx, `UPDATE helpdesk_tickets SET title = $2, description = coalesce($3, description), status = $4, psa_status = $5, priority = $6, psa_priority = $7,
			requester_email = coalesce($8, requester_email), sla_resolution_due_at = coalesce($9, sla_resolution_due_at), resolved_at = CASE WHEN $4 IN ('resolved', 'closed') THEN coalesce($10, resolved_at, $11) ELSE NULL END,
			external_updated_at = $11, last_synced_at = $12, sync_state = $13 WHERE id = $1`,
			id, t.Title, nilIfEmpty(t.Description), t.Status, nilIfEmpty(t.PSAStatus), t.Priority, nilIfEmpty(t.PSAPriority), nilIfEmpty(t.RequesterEmail), t.DueAt, resolved, t.UpdatedAt, now, newState); err != nil {
			return err
		}
		if changed {
			out.Changed = true
			evType := "updated"
			if status != t.Status {
				evType = "status_changed"
			}
			if _, err := tx.Exec(ctx, `INSERT INTO ticket_events (ticket_id, event_type, source, idempotency_key, payload_hash, payload, occurred_at) VALUES ($1, $2, 'psa', $3, $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING`,
				id, evType, idem, hashPayload(fields), mustJSON(map[string]any{"from": map[string]any{"status": status, "priority": priority}, "to": map[string]any{"status": t.Status, "priority": t.Priority}}), t.UpdatedAt); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

func (s *PgStore) PendingPushes(ctx context.Context, limit int) ([]PendingPush, error) {
	rows, err := s.Pool.Query(ctx, `SELECT e.id, e.ticket_id, coalesce(t.external_ticket_id, ''), e.event_type, e.payload, e.occurred_at,
		t.title, coalesce(t.description, ''), t.status, t.priority, coalesce(t.requester_email, '')
		FROM ticket_events e JOIN helpdesk_tickets t ON t.id = e.ticket_id
		WHERE e.source = 'portal' AND e.pushed_at IS NULL ORDER BY e.occurred_at, e.created_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingPush
	for rows.Next() {
		var p PendingPush
		var payload []byte
		var title, desc, status, priority, email string
		if err := rows.Scan(&p.EventID, &p.TicketID, &p.ExternalID, &p.EventType, &payload, &p.OccurredAt, &title, &desc, &status, &priority, &email); err != nil {
			return nil, err
		}
		var body map[string]any
		_ = json.Unmarshal(payload, &body)
		p.Status, _ = body["status"].(string)
		p.NoteTitle, _ = body["title"].(string)
		p.NoteText, _ = body["text"].(string)
		p.Ticket = psa.RemoteTicket{Title: title, Description: desc, Status: status, Priority: priority, RequesterEmail: email}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *PgStore) MarkPushed(ctx context.Context, p PendingPush, externalID string, pushErr string, now time.Time) error {
	return pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if pushErr == "" {
			if _, err := tx.Exec(ctx, `UPDATE ticket_events SET pushed_at = $2, push_error = NULL WHERE id = $1`, p.EventID, now); err != nil {
				return err
			}
			if p.EventType == "created" && externalID != "" && p.ExternalID == "" {
				connID, _, err := s.connID(ctx)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `UPDATE helpdesk_tickets SET external_ticket_id = $2, psa_connection_id = $3, provider = (SELECT provider FROM psa_connections WHERE id = $3) WHERE id = $1`, p.TicketID, externalID, connID); err != nil {
					return err
				}
			}
			// Anything else still pending keeps the ticket in pending_push.
			var pending int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM ticket_events WHERE ticket_id = $1 AND source = 'portal' AND pushed_at IS NULL`, p.TicketID).Scan(&pending); err != nil {
				return err
			}
			state := "synced"
			if pending > 0 {
				state = "pending_push"
			}
			_, err := tx.Exec(ctx, `UPDATE helpdesk_tickets SET sync_state = $2, last_synced_at = $3 WHERE id = $1 AND sync_state <> 'conflict'`, p.TicketID, state, now)
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE ticket_events SET push_error = $2 WHERE id = $1`, p.EventID, left(pushErr, 300)); err != nil {
			return err
		}
		state := "push_failed"
		if strings.Contains(pushErr, "("+psa.CodeUnsupported+")") && p.ExternalID == "" {
			state = "local_only"
			// A ticket the PSA cannot receive stays local; the event is settled so it is not retried forever.
			if _, err := tx.Exec(ctx, `UPDATE ticket_events SET pushed_at = $2 WHERE id = $1`, p.EventID, now); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `UPDATE helpdesk_tickets SET sync_state = $2 WHERE id = $1`, p.TicketID, state)
		return err
	})
}

func (s *PgStore) LogError(ctx context.Context, code string, httpStatus int, message string) error {
	var hs any
	if httpStatus > 0 {
		hs = httpStatus
	}
	var c any
	if code != "" {
		c = code
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO integration_logs (level, component, message, error_code, http_status, psa_connection_id)
		SELECT 'error', 'worker', $1, $2, $3, id FROM psa_connections WHERE instance_code = $4`, left(message, 1000), c, hs, s.InstanceCode)
	return err
}

func (s *PgStore) RequestedManualRun(ctx context.Context) (bool, error) {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM app_metadata WHERE key = 'sync.requested'`)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RequestManualRun is what the local admin UI calls for "Sync now"; the worker picks it up on its next tick.
func (s *PgStore) RequestManualRun(ctx context.Context, by string) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO app_metadata (key, value) VALUES ('sync.requested', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, by+" at "+time.Now().UTC().Format(time.RFC3339))
	return err
}

func nilIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func left(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
