// Package sync is the appliance's ticket synchronization engine (Module 12).
//
// helpdesk_tickets is the system of record for the client: PSA tickets are mirrored into it (inbound,
// incremental on the PSA's "last updated" clock with an overlap window) and changes made on the appliance
// are pushed back (outbound: status changes, notes, and — where the adapter supports it — new tickets).
// Every run is recorded in sync_runs with counts and sanitized error codes; the Control Plane receives
// those counts through the agent, never a ticket.
package sync

import (
	"context"
	"time"

	"psacc.local/edge/internal/psa"
)

// LocalTicket is the stored row the engine reasons about.
type LocalTicket struct {
	ID              string
	ExternalID      string
	Status          string
	Priority        string
	Title           string
	SyncState       string // synced, pending_push, conflict, push_failed, local_only
	LastSyncedAt    *time.Time
	LocalChangedAt  *time.Time
	ExternalUpdated *time.Time
}

// PendingPush is a local change waiting to go to the PSA.
type PendingPush struct {
	EventID    string
	TicketID   string
	ExternalID string // empty for a ticket raised on the appliance that the PSA does not know yet
	EventType  string // created, status_changed, note_added
	Status     string // for status_changed
	NoteTitle  string
	NoteText   string
	Ticket     psa.RemoteTicket // for created
	OccurredAt time.Time
}

// RunRecord is the stored sync run.
type RunRecord struct {
	ID            string
	Trigger       string
	Status        string
	StartedAt     time.Time
	FinishedAt    *time.Time
	ItemsReceived int
	ItemsSent     int
	ItemsFailed   int
	ErrorCode     string
	ErrorMessage  string
	Pages         int
}

// Upsert is what the engine learned while applying one remote ticket.
type Upsert struct {
	Created  bool
	Changed  bool
	Conflict bool
}

// Store abstracts the appliance database so the engine can be unit-tested without PostgreSQL.
type Store interface {
	ConnectionStatus(ctx context.Context) (status string, err error)
	Watermark(ctx context.Context) (*time.Time, error)
	SaveWatermark(ctx context.Context, t time.Time) error
	BeginRun(ctx context.Context, trigger string, from time.Time) (runID string, err error)
	FinishRun(ctx context.Context, runID string, r RunRecord) error
	// ApplyRemote mirrors a PSA ticket: insert or update by external id, record ticket_events, detect a
	// conflict with a pending local change (the PSA wins for fields; local notes still travel).
	ApplyRemote(ctx context.Context, t psa.RemoteTicket, now time.Time) (Upsert, error)
	PendingPushes(ctx context.Context, limit int) ([]PendingPush, error)
	MarkPushed(ctx context.Context, p PendingPush, externalID string, pushErr string, now time.Time) error
	LogError(ctx context.Context, code string, httpStatus int, message string) error
	// RequestedManualRun reports (and clears) a "sync now" request made in the local admin UI.
	RequestedManualRun(ctx context.Context) (bool, error)
}
