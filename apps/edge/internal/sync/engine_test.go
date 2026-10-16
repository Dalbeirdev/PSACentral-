package sync

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"psacc.local/edge/internal/psa"
)

// ---- in-memory store ----

type memTicket struct {
	LocalTicket
	PSAStatus string
}

type memStore struct {
	mu        sync.Mutex
	status    string
	watermark *time.Time
	runs      []RunRecord
	tickets   map[string]*memTicket // by external id
	pending   []PendingPush
	pushed    []string
	pushErrs  map[string]string
	logs      []string
	conflicts int
	manual    bool
}

func newMem() *memStore {
	return &memStore{status: "verified", tickets: map[string]*memTicket{}, pushErrs: map[string]string{}}
}

func (m *memStore) ConnectionStatus(context.Context) (string, error) { return m.status, nil }
func (m *memStore) Watermark(context.Context) (*time.Time, error)    { return m.watermark, nil }
func (m *memStore) SaveWatermark(_ context.Context, t time.Time) error {
	m.watermark = &t
	return nil
}
func (m *memStore) BeginRun(_ context.Context, trigger string, from time.Time) (string, error) {
	m.runs = append(m.runs, RunRecord{ID: fmt.Sprint(len(m.runs) + 1), Trigger: trigger, Status: "running", StartedAt: time.Now()})
	return m.runs[len(m.runs)-1].ID, nil
}
func (m *memStore) FinishRun(_ context.Context, id string, r RunRecord) error {
	for i := range m.runs {
		if m.runs[i].ID == id {
			m.runs[i] = r
		}
	}
	return nil
}
func (m *memStore) ApplyRemote(_ context.Context, t psa.RemoteTicket, now time.Time) (Upsert, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.tickets[t.ExternalID]
	if !ok {
		u := t.UpdatedAt
		m.tickets[t.ExternalID] = &memTicket{LocalTicket: LocalTicket{ID: "local-" + t.ExternalID, ExternalID: t.ExternalID, Status: t.Status, Priority: t.Priority, Title: t.Title, SyncState: "synced", ExternalUpdated: &u}, PSAStatus: t.PSAStatus}
		return Upsert{Created: true}, nil
	}
	if cur.ExternalUpdated != nil && !t.UpdatedAt.After(*cur.ExternalUpdated) {
		return Upsert{}, nil
	}
	out := Upsert{Changed: cur.Status != t.Status || cur.Title != t.Title}
	if cur.SyncState == "pending_push" && cur.Status != t.Status {
		out.Conflict = true
		m.conflicts++
		cur.SyncState = "conflict"
		// drop the pending status push
		var keep []PendingPush
		for _, p := range m.pending {
			if !(p.TicketID == cur.ID && p.EventType == "status_changed") {
				keep = append(keep, p)
			}
		}
		m.pending = keep
	}
	u := t.UpdatedAt
	cur.Status, cur.Title, cur.Priority, cur.ExternalUpdated, cur.PSAStatus = t.Status, t.Title, t.Priority, &u, t.PSAStatus
	return out, nil
}
func (m *memStore) PendingPushes(context.Context, int) ([]PendingPush, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]PendingPush(nil), m.pending...), nil
}
func (m *memStore) MarkPushed(_ context.Context, p PendingPush, externalID, pushErr string, _ time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if pushErr != "" {
		m.pushErrs[p.EventID] = pushErr
		return nil
	}
	m.pushed = append(m.pushed, p.EventID)
	var keep []PendingPush
	for _, q := range m.pending {
		if q.EventID != p.EventID {
			keep = append(keep, q)
		}
	}
	m.pending = keep
	if p.EventType == "created" && externalID != "" {
		for _, t := range m.tickets {
			if t.ID == p.TicketID {
				t.ExternalID = externalID
			}
		}
	}
	return nil
}
func (m *memStore) LogError(_ context.Context, code string, _ int, msg string) error {
	m.logs = append(m.logs, code+": "+msg)
	return nil
}
func (m *memStore) RequestedManualRun(context.Context) (bool, error) {
	r := m.manual
	m.manual = false
	return r, nil
}

// ---- fake custom-REST PSA ----

type fakePSA struct {
	srv     *httptest.Server
	mu      sync.Mutex
	tickets []map[string]any
	patches []string
	notes   []string
	created int
	fail    int // HTTP status to return for everything, 0 = normal
	pages   int
}

func newFakePSA(t *testing.T) *fakePSA {
	f := &fakePSA{}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("X-API-Key") != "k" {
			w.WriteHeader(401)
			return
		}
		if f.fail != 0 {
			w.WriteHeader(f.fail)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/tickets":
			since, _ := time.Parse(time.RFC3339, r.URL.Query().Get("updated_since"))
			page := r.URL.Query().Get("page")
			var items []map[string]any
			for _, t := range f.tickets {
				u, _ := time.Parse(time.RFC3339, t["updatedAt"].(string))
				if !u.Before(since) {
					items = append(items, t)
				}
			}
			// two pages of at most 2 when more than 2 match
			var next any
			if page == "" && len(items) > 2 {
				items, next = items[:2], 2
			} else if page == "2" && len(items) > 2 {
				items = items[2:]
			}
			f.pages++
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "nextPage": next})
		case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/api/tickets/"):
			b, _ := io.ReadAll(r.Body)
			f.patches = append(f.patches, strings.TrimPrefix(r.URL.Path, "/api/tickets/")+" "+string(b))
			_, _ = w.Write([]byte(`{}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/notes"):
			b, _ := io.ReadAll(r.Body)
			f.notes = append(f.notes, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/tickets/"), "/notes")+" "+string(b))
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{}`))
		case r.Method == "POST" && r.URL.Path == "/api/tickets":
			f.created++
			w.WriteHeader(201)
			_, _ = w.Write([]byte(fmt.Sprintf(`{"id":"new-%d"}`, f.created)))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakePSA) conn() *psa.Conn {
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.srv.Certificate().Raw}))
	return &psa.Conn{Provider: "custom_rest", AuthMethod: "api_key", Endpoint: f.srv.URL + "/api", Config: map[string]any{"ticketsPath": "/tickets"}, Credentials: map[string]string{"apiKey": "k"}, CACertPEM: ca, Timeout: 5 * time.Second}
}

func ticket(id, title, status, updated string) map[string]any {
	return map[string]any{"id": id, "title": title, "description": "body of " + id, "status": status, "priority": "High", "requesterEmail": "u@example.test", "createdAt": "2026-10-01T00:00:00Z", "updatedAt": updated}
}

// The fixtures carry fixed PSA timestamps on 2026-10-15; the engine's clock is pinned before them so the
// watermark assertions stay valid whenever the tests run (the watermark is the later of the run start
// and the newest PSA change).
var testClock = time.Date(2026, 10, 15, 7, 30, 0, 0, time.UTC)

func engine(m *memStore, f *fakePSA) *Engine {
	return &Engine{Store: m, Conn: func(context.Context) (*psa.Conn, error) { return f.conn(), nil }, Overlap: time.Minute, InitialWindow: 24 * time.Hour, MaxPages: 10,
		Now: func() time.Time { return testClock }}
}

// ---- tests ----

func TestInboundMirrorsPagesIsIdempotentAndAdvancesTheWatermark(t *testing.T) {
	f := newFakePSA(t)
	f.tickets = []map[string]any{ticket("1", "Printer down", "Open", "2026-10-15T08:00:00Z"), ticket("2", "VPN", "Waiting Customer", "2026-10-15T08:05:00Z"), ticket("3", "Laptop", "Complete", "2026-10-15T08:10:00Z")}
	m := newMem()
	e := engine(m, f)
	s, err := e.Run(context.Background(), "manual")
	if err != nil || s.Status != "succeeded" {
		t.Fatalf("run: %+v %v", s, err)
	}
	if s.Received != 3 || s.Created != 3 || s.Pages != 2 {
		t.Fatalf("expected 3 tickets over 2 pages, got %+v", s)
	}
	if m.tickets["2"].Status != "pending" || m.tickets["3"].Status != "closed" || m.tickets["1"].Priority != "high" {
		t.Fatalf("normalization: %+v %+v %+v", m.tickets["1"].LocalTicket, m.tickets["2"].LocalTicket, m.tickets["3"].LocalTicket)
	}
	if m.watermark == nil || !m.watermark.Equal(time.Date(2026, 10, 15, 8, 10, 0, 0, time.UTC)) {
		t.Fatalf("watermark should be the newest PSA update: %v", m.watermark)
	}
	// Nothing changed: the second run receives nothing new and keeps the watermark (no spurious events).
	s2, _ := e.Run(context.Background(), "scheduled")
	if s2.Status != "succeeded" || s2.Created != 0 || s2.Updated != 0 {
		t.Fatalf("second run should be a no-op: %+v", s2)
	}
	// The PSA changes one ticket: one update, watermark moves.
	f.tickets[0]["status"] = "Resolved"
	f.tickets[0]["updatedAt"] = "2026-10-15T09:00:00Z"
	s3, _ := e.Run(context.Background(), "scheduled")
	if s3.Updated != 1 || m.tickets["1"].Status != "resolved" || !m.watermark.Equal(time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("update not mirrored: %+v %+v %v", s3, m.tickets["1"].LocalTicket, m.watermark)
	}
	if m.runs[len(m.runs)-1].Trigger != "scheduled" || m.runs[len(m.runs)-1].Status != "succeeded" {
		t.Fatalf("run record: %+v", m.runs[len(m.runs)-1])
	}
}

func TestOutboundPushesStatusNotesAndNewTickets(t *testing.T) {
	f := newFakePSA(t)
	f.tickets = []map[string]any{ticket("7", "Mailbox full", "Open", "2026-10-15T08:00:00Z")}
	m := newMem()
	e := engine(m, f)
	if _, err := e.Run(context.Background(), "initial"); err != nil {
		t.Fatal(err)
	}
	m.tickets["7"].SyncState = "pending_push"
	m.pending = []PendingPush{
		{EventID: "e1", TicketID: "local-7", ExternalID: "7", EventType: "status_changed", Status: "pending"},
		{EventID: "e2", TicketID: "local-7", ExternalID: "7", EventType: "note_added", NoteTitle: "Update", NoteText: "Called the user"},
		{EventID: "e3", TicketID: "local-new", EventType: "created", Ticket: psa.RemoteTicket{Title: "Raised on the appliance", Description: "d", Status: "new", Priority: "normal"}},
	}
	m.tickets["new"] = &memTicket{LocalTicket: LocalTicket{ID: "local-new", SyncState: "local_only", Title: "Raised on the appliance"}}
	s, err := e.Run(context.Background(), "scheduled")
	if err != nil || s.Status != "succeeded" || s.Sent != 3 || s.Failed != 0 {
		t.Fatalf("outbound: %+v %v", s, err)
	}
	if len(f.patches) != 1 || !strings.Contains(f.patches[0], `7 {"status":"pending"}`) {
		t.Fatalf("patch: %v", f.patches)
	}
	if len(f.notes) != 1 || !strings.Contains(f.notes[0], "Called the user") {
		t.Fatalf("note: %v", f.notes)
	}
	if f.created != 1 || m.tickets["new"].ExternalID != "new-1" {
		t.Fatalf("create: %d %q", f.created, m.tickets["new"].ExternalID)
	}
	if len(m.pending) != 0 {
		t.Fatalf("pending left: %v", m.pending)
	}
}

func TestConflictPSAWinsAndNotesStillTravel(t *testing.T) {
	f := newFakePSA(t)
	f.tickets = []map[string]any{ticket("9", "Slow PC", "Open", "2026-10-15T08:00:00Z")}
	m := newMem()
	e := engine(m, f)
	_, _ = e.Run(context.Background(), "initial")
	// A local status change waits; meanwhile the PSA closes the ticket.
	m.tickets["9"].SyncState = "pending_push"
	m.pending = []PendingPush{
		{EventID: "s1", TicketID: "local-9", ExternalID: "9", EventType: "status_changed", Status: "pending"},
		{EventID: "n1", TicketID: "local-9", ExternalID: "9", EventType: "note_added", NoteText: "note survives"},
	}
	f.tickets[0]["status"] = "Closed"
	f.tickets[0]["updatedAt"] = "2026-10-15T09:00:00Z"
	s, _ := e.Run(context.Background(), "scheduled")
	if s.Conflicts != 1 || m.tickets["9"].Status != "closed" || m.tickets["9"].SyncState != "conflict" {
		t.Fatalf("conflict handling: %+v %+v", s, m.tickets["9"].LocalTicket)
	}
	if len(f.patches) != 0 {
		t.Fatalf("the superseded status must not be pushed: %v", f.patches)
	}
	if len(f.notes) != 1 || s.Sent != 1 {
		t.Fatalf("the note should still be pushed: %v %+v", f.notes, s)
	}
}

func TestFailuresAreRecordedWithoutLosingState(t *testing.T) {
	f := newFakePSA(t)
	f.tickets = []map[string]any{ticket("1", "A", "Open", "2026-10-15T08:00:00Z")}
	m := newMem()
	e := engine(m, f)
	// Not verified yet: no request leaves the appliance.
	m.status = "credentials_present"
	s, _ := e.Run(context.Background(), "scheduled")
	if s.Status != "failed" || s.ErrorCode != "psa_not_verified" || f.pages != 0 {
		t.Fatalf("not verified: %+v pages=%d", s, f.pages)
	}
	m.status = "verified"
	// PSA down: failed run, watermark untouched, error logged with the code.
	f.fail = 503
	s, _ = e.Run(context.Background(), "scheduled")
	if s.Status != "failed" || s.ErrorCode != psa.CodeServerError || m.watermark != nil || len(m.logs) == 0 {
		t.Fatalf("server error: %+v wm=%v logs=%v", s, m.watermark, m.logs)
	}
	// Auth rejected: same, with auth_failed.
	f.fail = 401
	s, _ = e.Run(context.Background(), "scheduled")
	if s.ErrorCode != psa.CodeAuthFailed {
		t.Fatalf("auth: %+v", s)
	}
	// Recovered inbound, but a push is refused by the PSA: partial, the event keeps its error, the rest continues.
	f.fail = 0
	m.pending = []PendingPush{{EventID: "x", TicketID: "local-1", ExternalID: "1", EventType: "status_changed", Status: "open"}}
	f.fail = 0
	s, _ = e.Run(context.Background(), "scheduled")
	if s.Status != "succeeded" {
		t.Fatalf("expected success after recovery: %+v", s)
	}
	// Unsupported provider: honest failure code.
	e.Conn = func(context.Context) (*psa.Conn, error) { c := f.conn(); c.Provider = "freshservice"; return c, nil }
	s, _ = e.Run(context.Background(), "scheduled")
	if s.Status != "failed" || s.ErrorCode != "sync_unsupported" {
		t.Fatalf("unsupported: %+v", s)
	}
}

func TestCreateInAutotaskStaysLocalWithAnHonestReason(t *testing.T) {
	f := newFakePSA(t)
	m := newMem()
	e := engine(m, f)
	e.Conn = func(context.Context) (*psa.Conn, error) {
		c := f.conn()
		c.Provider = "autotask"
		c.Credentials = map[string]string{"username": "u", "secret": "s", "integrationCode": "i"}
		return c, nil
	}
	m.pending = []PendingPush{{EventID: "c1", TicketID: "local-x", EventType: "created", Ticket: psa.RemoteTicket{Title: "Local", Status: "new", Priority: "normal"}}}
	// The fake answers 404 for Autotask paths: the inbound listing fails, but the pending create is judged before any call.
	s, _ := e.Run(context.Background(), "scheduled")
	if _, ok := m.pushErrs["c1"]; !ok || !strings.Contains(m.pushErrs["c1"], psa.CodeUnsupported) {
		t.Fatalf("create should be refused as unsupported: %+v %v", s, m.pushErrs)
	}
}

func TestStatusAndPriorityNormalization(t *testing.T) {
	cases := map[string]string{"New": "new", "In Progress": "open", "Waiting Customer": "pending", "Waiting Vendor": "on_hold", "On Hold": "on_hold", "Resolved": "resolved", "Complete": "closed", "Closed": "closed", "Customer Note Added": "pending", "": "open", "Weird": "open"}
	for in, want := range cases {
		if got := psa.NormalizeStatus(in); got != want {
			t.Errorf("status %q → %q, want %q", in, got, want)
		}
	}
	pr := map[string]string{"Critical": "critical", "Urgent": "critical", "High": "high", "Medium": "normal", "Low": "low", "Priority 1 - Emergency": "critical", "": "normal"}
	for in, want := range pr {
		if got := psa.NormalizePriority(in); got != want {
			t.Errorf("priority %q → %q, want %q", in, got, want)
		}
	}
}
