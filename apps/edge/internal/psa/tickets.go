package psa

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"psacc.local/edge/internal/redact"
)

// Ticket synchronization adapters (Module 12). The appliance mirrors PSA tickets into its own database
// (inbound) and pushes local status changes and notes back (outbound). Every call is one HTTP request
// made from the client's Docker environment with the same hardened client as the connection test.
//
// Autotask and ConnectWise follow the reference connectors (incremental query on lastActivityDate /
// lastUpdated, picklist labels for Autotask statuses, PATCH operations for ConnectWise). The custom REST
// adapter defines a small, documented JSON shape. Other providers report "unsupported" for synchronization
// rather than guessing at an API.

// RemoteTicket is a ticket as the PSA returns it, already reduced to what the appliance stores.
type RemoteTicket struct {
	ExternalID     string
	Title          string
	Description    string
	Status         string // normalized: new, open, pending, on_hold, resolved, closed
	PSAStatus      string // the PSA's own label
	Priority       string // normalized: low, normal, high, critical
	PSAPriority    string
	RequesterEmail string
	CreatedAt      *time.Time
	UpdatedAt      time.Time
	ResolvedAt     *time.Time
	DueAt          *time.Time
}

// TicketPage is one page of an incremental listing. NextPage is opaque to the engine ("" = done).
type TicketPage struct {
	Tickets  []RemoteTicket
	NextPage string
	Result   Result
}

// TicketPatch is what the appliance can push back for an existing PSA ticket.
type TicketPatch struct {
	Status *string // normalized status; the adapter maps it to the PSA's vocabulary
}

// Normalized vocabularies shared by every provider.
var (
	Statuses   = []string{"new", "open", "pending", "on_hold", "resolved", "closed"}
	Priorities = []string{"low", "normal", "high", "critical"}
)

// NormalizeStatus maps a PSA status label to the appliance vocabulary by keyword; unknown labels become "open".
func NormalizeStatus(label string) string {
	l := strings.ToLower(strings.TrimSpace(label))
	switch {
	case l == "":
		return "open"
	case strings.Contains(l, "closed") || strings.Contains(l, "complete") || strings.Contains(l, "cancel"):
		return "closed"
	case strings.Contains(l, "resolved") || strings.Contains(l, "fixed"):
		return "resolved"
	case strings.Contains(l, "hold") || strings.Contains(l, "schedul") || strings.Contains(l, "waiting vendor") || strings.Contains(l, "waiting material"):
		return "on_hold"
	case strings.Contains(l, "wait") || strings.Contains(l, "pending") || strings.Contains(l, "customer"):
		return "pending"
	case strings.Contains(l, "new") || strings.Contains(l, "unassigned") || strings.Contains(l, "open") && strings.Contains(l, "not"):
		return "new"
	default:
		return "open"
	}
}

// NormalizePriority maps a PSA priority label to low / normal / high / critical.
func NormalizePriority(label string) string {
	l := strings.ToLower(strings.TrimSpace(label))
	switch {
	case strings.Contains(l, "critical") || strings.Contains(l, "urgent") || strings.Contains(l, "emergency") || l == "1" || strings.HasPrefix(l, "priority 1") || strings.HasPrefix(l, "p1"):
		return "critical"
	case strings.Contains(l, "high") || l == "2" || strings.HasPrefix(l, "priority 2") || strings.HasPrefix(l, "p2"):
		return "high"
	case strings.Contains(l, "low") || l == "4" || strings.HasPrefix(l, "priority 4") || strings.HasPrefix(l, "p4"):
		return "low"
	default:
		return "normal"
	}
}

// SyncSupported says whether ticket synchronization is implemented for the provider.
func SyncSupported(provider string) bool {
	switch provider {
	case "autotask", "connectwise", "custom_rest":
		return true
	}
	return false
}

// ListTickets returns tickets changed since `since` (PSA clock), one page at a time.
func ListTickets(ctx context.Context, c *Conn, since time.Time, page string) TicketPage {
	if err := prepare(c); err != nil {
		return TicketPage{Result: *err}
	}
	switch c.Provider {
	case "autotask":
		return atList(ctx, c, since, page)
	case "connectwise":
		return cwList(ctx, c, since, page)
	case "custom_rest":
		return crList(ctx, c, since, page)
	}
	return TicketPage{Result: Result{Code: CodeUnsupported, Detail: "Ticket synchronization is not implemented for provider " + redact.Text(c.Provider, 40) + "."}}
}

// UpdateTicket pushes a local change to an existing PSA ticket.
func UpdateTicket(ctx context.Context, c *Conn, externalID string, patch TicketPatch) Result {
	if err := prepare(c); err != nil {
		return *err
	}
	switch c.Provider {
	case "autotask":
		return atUpdate(ctx, c, externalID, patch)
	case "connectwise":
		return cwUpdate(ctx, c, externalID, patch)
	case "custom_rest":
		return crUpdate(ctx, c, externalID, patch)
	}
	return Result{Code: CodeUnsupported, Detail: "Ticket synchronization is not implemented for this provider."}
}

// AddNote appends a note to an existing PSA ticket.
func AddNote(ctx context.Context, c *Conn, externalID, title, text string) Result {
	if err := prepare(c); err != nil {
		return *err
	}
	switch c.Provider {
	case "autotask":
		r, _ := do(ctx, c, probe{method: http.MethodPost, url: trimSlash(c.Endpoint) + "/V1.0/Tickets/" + url.PathEscape(externalID) + "/Notes", headers: atHeaders(c),
			body: mustJSON(map[string]any{"title": left(title, 250), "description": left(text, 32000), "noteType": 1, "publish": 1})}, false)
		return r
	case "connectwise":
		r, _ := do(ctx, c, probe{method: http.MethodPost, url: trimSlash(c.Endpoint) + "/service/tickets/" + url.PathEscape(externalID) + "/notes", headers: cwHeaders(c),
			body: mustJSON(map[string]any{"text": left(text, 32000), "detailDescriptionFlag": true})}, false)
		return r
	case "custom_rest":
		if r := crEnsureToken(ctx, c); r != nil {
			return *r
		}
		r, _ := do(ctx, c, probe{method: http.MethodPost, url: crBase(c) + "/" + url.PathEscape(externalID) + "/notes", headers: crHeaders(c), body: mustJSON(map[string]any{"text": left(text, 32000)})}, false)
		return r
	}
	return Result{Code: CodeUnsupported, Detail: "Ticket synchronization is not implemented for this provider."}
}

// CreateTicket creates a PSA ticket for a ticket raised on the appliance. Only the custom REST adapter
// supports it in this version: Autotask and ConnectWise require a company / board mapping that the
// platform does not hold yet, so such tickets stay local and say so.
func CreateTicket(ctx context.Context, c *Conn, t RemoteTicket) (string, Result) {
	if err := prepare(c); err != nil {
		return "", *err
	}
	if c.Provider != "custom_rest" {
		return "", Result{Code: CodeUnsupported, Detail: "Creating tickets in " + c.Provider + " needs a company mapping that is not configured; the ticket stays on this appliance."}
	}
	if r := crEnsureToken(ctx, c); r != nil {
		return "", *r
	}
	r, body := do(ctx, c, probe{method: http.MethodPost, url: crBase(c), headers: crHeaders(c),
		body: mustJSON(map[string]any{"title": t.Title, "description": t.Description, "status": t.Status, "priority": t.Priority, "requesterEmail": t.RequesterEmail})}, true)
	if !r.OK {
		return "", r
	}
	var created struct {
		ID any `json:"id"`
	}
	if json.Unmarshal(body, &created) != nil || created.ID == nil {
		return "", Result{Code: CodeBadResponse, HTTPStatus: r.HTTPStatus, Detail: "The PSA created the ticket but returned no id."}
	}
	return fmt.Sprint(created.ID), r
}

// ---- shared ----

func prepare(c *Conn) *Result {
	if c.Timeout == 0 {
		c.Timeout = 20 * time.Second
	}
	if c.Client == nil {
		cl, err := NewHTTPClient(c.CACertPEM, c.Timeout)
		if err != nil {
			return &Result{Code: CodeInvalidConfig, Detail: err.Error()}
		}
		c.Client = cl
	}
	if c.Endpoint == "" {
		return &Result{Code: CodeInvalidConfig, Detail: "The package carries no API endpoint for this PSA instance."}
	}
	if c.cache == nil {
		c.cache = map[string]any{}
	}
	return nil
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func parseTime(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02T15:04:05.000", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			t = t.UTC()
			return &t
		}
	}
	return nil
}

func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}

func refName(v any) string {
	if m, ok := v.(map[string]any); ok {
		return str(m["name"])
	}
	return str(v)
}

// ---- Autotask ----

func atHeaders(c *Conn) map[string]string {
	return map[string]string{"ApiIntegrationCode": c.cred("integrationCode"), "UserName": c.cred("username"), "Secret": c.cred("secret")}
}

// atPicklist loads the status and priority picklists once per connection; labels are what the
// reference connector shows, and what the normalizer understands.
func atPicklist(ctx context.Context, c *Conn) (map[string]string, map[string]string, *Result) {
	if v, ok := c.cache["atPicklist"]; ok {
		p := v.([2]map[string]string)
		return p[0], p[1], nil
	}
	r, body := do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/V1.0/Tickets/entityInformation/fields", headers: atHeaders(c)}, true)
	if !r.OK {
		return nil, nil, &r
	}
	var info struct {
		Fields []struct {
			Name           string `json:"name"`
			PicklistValues []struct {
				Value string `json:"value"`
				Label string `json:"label"`
			} `json:"picklistValues"`
		} `json:"fields"`
	}
	_ = json.Unmarshal(body, &info)
	status, priority := map[string]string{}, map[string]string{}
	for _, f := range info.Fields {
		target := map[string]string(nil)
		switch strings.ToLower(f.Name) {
		case "status":
			target = status
		case "priority":
			target = priority
		}
		if target == nil {
			continue
		}
		for _, p := range f.PicklistValues {
			target[p.Value] = p.Label
		}
	}
	c.cache["atPicklist"] = [2]map[string]string{status, priority}
	return status, priority, nil
}

func atList(ctx context.Context, c *Conn, since time.Time, page string) TicketPage {
	statusLabels, priorityLabels, perr := atPicklist(ctx, c)
	if perr != nil {
		return TicketPage{Result: *perr}
	}
	var r Result
	var body []byte
	if page != "" {
		r, body = do(ctx, c, probe{method: http.MethodGet, url: page, headers: atHeaders(c)}, true)
	} else {
		q := map[string]any{"MaxRecords": 100, "filter": []map[string]any{{"op": "gte", "field": "lastActivityDate", "value": since.UTC().Format(time.RFC3339)}}}
		r, body = do(ctx, c, probe{method: http.MethodPost, url: trimSlash(c.Endpoint) + "/V1.0/Tickets/query", headers: atHeaders(c), body: mustJSON(q)}, true)
	}
	if !r.OK {
		return TicketPage{Result: r}
	}
	var res struct {
		Items       []map[string]any `json:"items"`
		PageDetails struct {
			NextPageURL string `json:"nextPageUrl"`
		} `json:"pageDetails"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return TicketPage{Result: Result{Code: CodeBadResponse, HTTPStatus: r.HTTPStatus, Detail: "The ticket query did not return the expected JSON."}}
	}
	out := TicketPage{Result: r, NextPage: res.PageDetails.NextPageURL}
	for _, it := range res.Items {
		st, pr := str(it["status"]), str(it["priority"])
		updated := parseTime(str(it["lastActivityDate"]))
		if updated == nil {
			now := time.Now().UTC()
			updated = &now
		}
		resolved := parseTime(str(it["resolvedDateTime"]))
		if resolved == nil {
			resolved = parseTime(str(it["completedDate"]))
		}
		t := RemoteTicket{
			ExternalID: str(it["id"]), Title: left(str(it["title"]), 500), Description: left(str(it["description"]), 100000),
			PSAStatus: firstNonEmpty(statusLabels[st], st), PSAPriority: firstNonEmpty(priorityLabels[pr], pr),
			CreatedAt: parseTime(str(it["createDate"])), UpdatedAt: *updated, ResolvedAt: resolved, DueAt: parseTime(str(it["dueDateTime"])),
		}
		t.Status, t.Priority = NormalizeStatus(t.PSAStatus), NormalizePriority(t.PSAPriority)
		if t.ExternalID != "" && t.Title != "" {
			out.Tickets = append(out.Tickets, t)
		}
	}
	return out
}

func atUpdate(ctx context.Context, c *Conn, externalID string, patch TicketPatch) Result {
	if patch.Status == nil {
		return Result{OK: true, Code: CodeOK, Detail: "Nothing to push."}
	}
	statusLabels, _, perr := atPicklist(ctx, c)
	if perr != nil {
		return *perr
	}
	// Choose the picklist value whose label normalizes to the wanted status (first match in value order).
	value := ""
	for v, label := range statusLabels {
		if NormalizeStatus(label) == *patch.Status && (value == "" || v < value) {
			value = v
		}
	}
	if value == "" {
		return Result{Code: CodeUnsupported, Detail: "No Autotask status corresponds to \"" + *patch.Status + "\" in this tenant's picklist."}
	}
	id, _ := strconv.Atoi(externalID)
	r, _ := do(ctx, c, probe{method: http.MethodPatch, url: trimSlash(c.Endpoint) + "/V1.0/Tickets", headers: atHeaders(c), body: mustJSON(map[string]any{"id": id, "status": atoiOr(value)})}, false)
	return r
}

func atoiOr(v string) any {
	if n, err := strconv.Atoi(v); err == nil {
		return n
	}
	return v
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ---- ConnectWise ----

func cwHeaders(c *Conn) map[string]string {
	return map[string]string{"Authorization": basicAuth(c.str("companyId")+"+"+c.cred("publicKey"), c.cred("privateKey")), "clientId": c.cred("clientId")}
}

func cwList(ctx context.Context, c *Conn, since time.Time, page string) TicketPage {
	n := 1
	if page != "" {
		n, _ = strconv.Atoi(page)
		if n < 1 {
			n = 1
		}
	}
	q := url.Values{"conditions": {"lastUpdated>[" + since.UTC().Format("2006-01-02T15:04:05Z") + "]"}, "orderBy": {"lastUpdated asc"}, "pageSize": {"100"}, "page": {strconv.Itoa(n)}}
	r, body := do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/service/tickets?" + q.Encode(), headers: cwHeaders(c)}, true)
	if !r.OK {
		return TicketPage{Result: r}
	}
	var items []map[string]any
	if err := json.Unmarshal(body, &items); err != nil {
		return TicketPage{Result: Result{Code: CodeBadResponse, HTTPStatus: r.HTTPStatus, Detail: "The ticket listing did not return the expected JSON array."}}
	}
	out := TicketPage{Result: r}
	for _, it := range items {
		updated := parseTime(str(it["lastUpdated"]))
		if updated == nil {
			if info, ok := it["_info"].(map[string]any); ok {
				updated = parseTime(str(info["lastUpdated"]))
			}
		}
		if updated == nil {
			now := time.Now().UTC()
			updated = &now
		}
		resolved := parseTime(str(it["dateResolved"]))
		if resolved == nil {
			resolved = parseTime(str(it["closedDate"]))
		}
		t := RemoteTicket{
			ExternalID: str(it["id"]), Title: left(str(it["summary"]), 500), Description: left(str(it["initialDescription"]), 100000),
			PSAStatus: refName(it["status"]), PSAPriority: refName(it["priority"]), RequesterEmail: left(str(it["contactEmailAddress"]), 254),
			CreatedAt: parseTime(str(it["dateEntered"])), UpdatedAt: *updated, ResolvedAt: resolved, DueAt: parseTime(str(it["requiredDate"])),
		}
		t.Status, t.Priority = NormalizeStatus(t.PSAStatus), NormalizePriority(t.PSAPriority)
		if closed, _ := it["closedFlag"].(bool); closed && t.Status != "closed" {
			t.Status = "closed"
		}
		if t.ExternalID != "" && t.Title != "" {
			out.Tickets = append(out.Tickets, t)
		}
	}
	if len(items) == 100 {
		out.NextPage = strconv.Itoa(n + 1)
	}
	return out
}

// cwUpdate changes the board status by name; the names a board uses are discovered from the ticket's
// board. The normalized status picks the first board status whose name normalizes to it.
func cwUpdate(ctx context.Context, c *Conn, externalID string, patch TicketPatch) Result {
	if patch.Status == nil {
		return Result{OK: true, Code: CodeOK, Detail: "Nothing to push."}
	}
	r, body := do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/service/tickets/" + url.PathEscape(externalID) + "?fields=id,board", headers: cwHeaders(c)}, true)
	if !r.OK {
		return r
	}
	var t struct {
		Board struct {
			ID int `json:"id"`
		} `json:"board"`
	}
	_ = json.Unmarshal(body, &t)
	if t.Board.ID == 0 {
		return Result{Code: CodeBadResponse, HTTPStatus: r.HTTPStatus, Detail: "The ticket carries no board; its status cannot be mapped."}
	}
	key := "cwBoard:" + strconv.Itoa(t.Board.ID)
	statuses, ok := c.cache[key].([]map[string]any)
	if !ok {
		r2, b2 := do(ctx, c, probe{method: http.MethodGet, url: trimSlash(c.Endpoint) + "/service/boards/" + strconv.Itoa(t.Board.ID) + "/statuses?pageSize=100&orderBy=sortOrder asc", headers: cwHeaders(c)}, true)
		if !r2.OK {
			return r2
		}
		_ = json.Unmarshal(b2, &statuses)
		c.cache[key] = statuses
	}
	var chosen any
	for _, s := range statuses {
		if NormalizeStatus(str(s["name"])) == *patch.Status {
			chosen = s["id"]
			break
		}
	}
	if chosen == nil {
		return Result{Code: CodeUnsupported, Detail: "No status on board " + strconv.Itoa(t.Board.ID) + " corresponds to \"" + *patch.Status + "\"."}
	}
	ops := []map[string]any{{"op": "replace", "path": "status", "value": map[string]any{"id": chosen}}}
	r3, _ := do(ctx, c, probe{method: http.MethodPatch, url: trimSlash(c.Endpoint) + "/service/tickets/" + url.PathEscape(externalID), headers: cwHeaders(c), body: mustJSON(ops)}, false)
	return r3
}

// ---- custom REST ----
//
// Shape: GET <baseUrl><ticketsPath>?updated_since=<RFC3339>&page=<n>  → {"items":[{id,title,description,status,priority,requesterEmail,createdAt,updatedAt,resolvedAt,dueAt}],"nextPage":<n>|null}
//        PATCH <baseUrl><ticketsPath>/<id>  {"status":...}      POST <baseUrl><ticketsPath>/<id>/notes {"text":...}      POST <baseUrl><ticketsPath> {...} → {"id":...}

func crBase(c *Conn) string {
	path := c.str("ticketsPath")
	if path == "" {
		path = "/tickets"
	}
	return trimSlash(c.Endpoint) + path
}

func crHeaders(c *Conn) map[string]string {
	h := map[string]string{}
	switch c.AuthMethod {
	case "api_key":
		name := c.str("apiKeyHeader")
		if name == "" {
			name = "X-API-Key"
		}
		h[name] = c.cred("apiKey")
	case "basic":
		h["Authorization"] = basicAuth(c.cred("username"), c.cred("password"))
	case "oauth2_client_credentials":
		if tok, ok := c.cache["bearer"].(string); ok {
			h["Authorization"] = "Bearer " + tok
		}
	}
	return h
}

func crEnsureToken(ctx context.Context, c *Conn) *Result {
	if c.AuthMethod != "oauth2_client_credentials" {
		return nil
	}
	if _, ok := c.cache["bearer"]; ok {
		return nil
	}
	token, r := tokenRequest(ctx, c, c.str("tokenUrl"), url.Values{"grant_type": {"client_credentials"}, "client_id": {c.cred("clientId")}, "client_secret": {c.cred("clientSecret")}}, nil)
	if token == "" {
		return &r
	}
	c.cache["bearer"] = token
	return nil
}

func crList(ctx context.Context, c *Conn, since time.Time, page string) TicketPage {
	if r := crEnsureToken(ctx, c); r != nil {
		return TicketPage{Result: *r}
	}
	q := url.Values{"updated_since": {since.UTC().Format(time.RFC3339)}}
	if page != "" {
		q.Set("page", page)
	}
	r, body := do(ctx, c, probe{method: http.MethodGet, url: crBase(c) + "?" + q.Encode(), headers: crHeaders(c)}, true)
	if !r.OK {
		return TicketPage{Result: r}
	}
	var res struct {
		Items    []map[string]any `json:"items"`
		NextPage any              `json:"nextPage"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		var arr []map[string]any
		if json.Unmarshal(body, &arr) != nil {
			return TicketPage{Result: Result{Code: CodeBadResponse, HTTPStatus: r.HTTPStatus, Detail: "The ticket listing did not return the expected JSON."}}
		}
		res.Items = arr
	}
	out := TicketPage{Result: r}
	if res.NextPage != nil && str(res.NextPage) != "" && str(res.NextPage) != "null" {
		out.NextPage = str(res.NextPage)
	}
	for _, it := range res.Items {
		updated := parseTime(str(it["updatedAt"]))
		if updated == nil {
			now := time.Now().UTC()
			updated = &now
		}
		t := RemoteTicket{
			ExternalID: str(it["id"]), Title: left(str(it["title"]), 500), Description: left(str(it["description"]), 100000),
			PSAStatus: str(it["status"]), PSAPriority: str(it["priority"]), RequesterEmail: left(str(it["requesterEmail"]), 254),
			CreatedAt: parseTime(str(it["createdAt"])), UpdatedAt: *updated, ResolvedAt: parseTime(str(it["resolvedAt"])), DueAt: parseTime(str(it["dueAt"])),
		}
		t.Status, t.Priority = NormalizeStatus(t.PSAStatus), NormalizePriority(t.PSAPriority)
		if t.ExternalID != "" && t.Title != "" {
			out.Tickets = append(out.Tickets, t)
		}
	}
	return out
}

func crUpdate(ctx context.Context, c *Conn, externalID string, patch TicketPatch) Result {
	if r := crEnsureToken(ctx, c); r != nil {
		return *r
	}
	body := map[string]any{}
	if patch.Status != nil {
		body["status"] = *patch.Status
	}
	if len(body) == 0 {
		return Result{OK: true, Code: CodeOK, Detail: "Nothing to push."}
	}
	r, _ := do(ctx, c, probe{method: http.MethodPatch, url: crBase(c) + "/" + url.PathEscape(externalID), headers: crHeaders(c), body: mustJSON(body)}, false)
	return r
}
