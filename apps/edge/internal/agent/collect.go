package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"psacc.local/edge/internal/config"
	"psacc.local/edge/internal/inventory"
	"psacc.local/edge/internal/redact"
)

// ReportItem is one allow-listed report (packages/contracts health.ts). Payloads hold only what the
// agent measured; anything it cannot measure is null.
type ReportItem struct {
	SchemaVersion int            `json:"schemaVersion"`
	Type          string         `json:"type"`
	ObservedAt    time.Time      `json:"observedAt"`
	Payload       map[string]any `json:"payload"`
}

// ---- host resources (measured from inside the agent container: cgroup v2, /proc, statfs) ----

type cpuSample struct {
	busy, total uint64
	at          time.Time
}

func readCPU() (cpuSample, bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 8 || fields[0] != "cpu" {
			continue
		}
		var vals []uint64
		for _, s := range fields[1:] {
			v, _ := strconv.ParseUint(s, 10, 64)
			vals = append(vals, v)
		}
		var total uint64
		for _, v := range vals {
			total += v
		}
		idle := vals[3]
		if len(vals) > 4 {
			idle += vals[4] // iowait
		}
		return cpuSample{busy: total - idle, total: total, at: time.Now()}, true
	}
	return cpuSample{}, false
}

func readUint(path string) (uint64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	s := strings.TrimSpace(string(b))
	if s == "max" {
		return 0, false
	}
	v, err := strconv.ParseUint(s, 10, 64)
	return v, err == nil
}

func readMeminfo(key string) (uint64, bool) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), key+":") {
			fields := strings.Fields(sc.Text())
			if len(fields) >= 2 {
				kb, err := strconv.ParseUint(fields[1], 10, 64)
				return kb * 1024, err == nil
			}
		}
	}
	return 0, false
}

func uptime() (uint64, bool) {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, false
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(f[0], 64)
	return uint64(v), err == nil
}

func (a *Agent) hostResources() map[string]any {
	out := map[string]any{"cpuPercent": nil, "memoryUsedBytes": nil, "memoryLimitBytes": nil, "diskUsedBytes": nil, "diskTotalBytes": nil, "diskMount": nil, "uptimeSeconds": nil, "cpuCount": nil}
	// CPU: percentage of all cores between two /proc/stat samples (the previous collection, or 500 ms).
	if s, ok := readCPU(); ok {
		prev := a.prevCPU
		if prev.total == 0 {
			time.Sleep(500 * time.Millisecond)
			prev = s
			s, _ = readCPU()
		}
		if s.total > prev.total {
			out["cpuPercent"] = float64(int((float64(s.busy-prev.busy)/float64(s.total-prev.total))*1000)) / 10
		}
		a.prevCPU = s
	}
	// Memory: the container's cgroup limit when set, otherwise the host total.
	if used, ok := readUint("/sys/fs/cgroup/memory.current"); ok {
		out["memoryUsedBytes"] = used
		if limit, ok := readUint("/sys/fs/cgroup/memory.max"); ok {
			out["memoryLimitBytes"] = limit
		} else if total, ok := readMeminfo("MemTotal"); ok {
			out["memoryLimitBytes"] = total
		}
	} else if total, ok := readMeminfo("MemTotal"); ok {
		if avail, ok := readMeminfo("MemAvailable"); ok {
			out["memoryUsedBytes"] = total - avail
			out["memoryLimitBytes"] = total
		}
	}
	// Disk: the file system that holds the deployment's volumes (Docker's data root).
	var st syscall.Statfs_t
	if err := syscall.Statfs(a.OutboxDir, &st); err == nil && st.Blocks > 0 {
		total := uint64(st.Bsize) * st.Blocks
		free := uint64(st.Bsize) * st.Bavail
		out["diskTotalBytes"] = total
		out["diskUsedBytes"] = total - free
		out["diskMount"] = "docker-volumes"
	}
	if up, ok := uptime(); ok {
		out["uptimeSeconds"] = up
	}
	if n := len(onlineCPUs()); n > 0 {
		out["cpuCount"] = n
	}
	return out
}

func onlineCPUs() []string {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return nil
	}
	defer f.Close()
	var cpus []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if name := strings.Fields(sc.Text()); len(name) > 0 && strings.HasPrefix(name[0], "cpu") && name[0] != "cpu" {
			cpus = append(cpus, name[0])
		}
	}
	return cpus
}

// ---- service checks the agent can actually perform ----

type healthStatus struct {
	WorkerLastSeen                                  *time.Time
	PSAInstance, PSAProvider, PSAStatus             string
	PSACredsPresent                                 int
	PSALastTestAt                                   *time.Time
	PSALastTestResult                               *string
	BackupStatus                                    string
	BackupAt                                        *time.Time
	BackupSize                                      *int64
	BackupRetained                                  int
	BackupError                                     *string
	TicketsTotal, TicketsOpen, Events24h, Failed24h int
	TicketLastAt                                    *time.Time
	SyncLastAt                                      *time.Time
	SyncStatus                                      *string
	SyncRecv, SyncSent, SyncFailed                  *int
	SyncError                                       *string
	Errors24h, AdminFailed24h                       int
	AdminLocked                                     bool
}

type psaStatus struct {
	LastTestCode          *string
	LastTestHTTPStatus    *int16
	LastTestLatencyMs     *int32
	LastTestedBy          *string
	LastSuccessAt         *time.Time
	RemoteIdentity        map[string]string
	ConsecutiveFailures   int
	Tests24h, Failures24h int
}

// queryPSAStatus reads the connection-test metadata exposed to the inspector role (Module 11).
func queryPSAStatus(ctx context.Context, pool *pgxpool.Pool) (*psaStatus, error) {
	var p psaStatus
	var ident []byte
	err := pool.QueryRow(ctx, `SELECT * FROM edge_psa_status()`).Scan(&p.LastTestCode, &p.LastTestHTTPStatus, &p.LastTestLatencyMs, &p.LastTestedBy, &p.LastSuccessAt, &ident, &p.ConsecutiveFailures, &p.Tests24h, &p.Failures24h)
	if err != nil {
		return nil, err
	}
	p.RemoteIdentity = map[string]string{}
	_ = json.Unmarshal(ident, &p.RemoteIdentity)
	return &p, nil
}

func intOrNil[T int16 | int32](p *T) any {
	if p == nil {
		return nil
	}
	return int(*p)
}

type syncStatus struct {
	PendingOutbound, Conflicts24h, Runs24h, FailedRuns24h, LocalOnly, PushFailed int
	LastSucceededAt, Watermark                                                   *time.Time
}

// querySyncStatus reads the synchronization counters exposed to the inspector role (Module 12).
func querySyncStatus(ctx context.Context, pool *pgxpool.Pool) (*syncStatus, error) {
	var s syncStatus
	err := pool.QueryRow(ctx, `SELECT * FROM edge_sync_status()`).Scan(&s.PendingOutbound, &s.Conflicts24h, &s.LastSucceededAt, &s.Runs24h, &s.FailedRuns24h, &s.LocalOnly, &s.PushFailed, &s.Watermark)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func queryHealthStatus(ctx context.Context, pool *pgxpool.Pool) (*healthStatus, error) {
	var h healthStatus
	err := pool.QueryRow(ctx, `SELECT * FROM edge_health_status()`).Scan(
		&h.WorkerLastSeen, &h.PSAInstance, &h.PSAProvider, &h.PSAStatus, &h.PSACredsPresent, &h.PSALastTestAt, &h.PSALastTestResult,
		&h.BackupStatus, &h.BackupAt, &h.BackupSize, &h.BackupRetained, &h.BackupError,
		&h.TicketsTotal, &h.TicketsOpen, &h.Events24h, &h.Failed24h, &h.TicketLastAt,
		&h.SyncLastAt, &h.SyncStatus, &h.SyncRecv, &h.SyncSent, &h.SyncFailed, &h.SyncError,
		&h.Errors24h, &h.AdminFailed24h, &h.AdminLocked)
	return &h, err
}

func (a *Agent) probeAPI(ctx context.Context) (state, detail string) {
	url := config.Env("PSA_EDGE_API_URL", "http://edge-api:8480") + "/healthz"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return "down", "connection_refused"
	}
	defer res.Body.Close()
	var body struct {
		Status string `json:"status"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	switch {
	case res.StatusCode == 200:
		return "up", ""
	case res.StatusCode == 503:
		return "down", "degraded_" + body.Status
	default:
		return "unknown", "http_" + strconv.Itoa(res.StatusCode)
	}
}

func tsOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339Nano)
}
func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}
func intOr0(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// CollectAll builds every allow-listed report from real measurements.
func (a *Agent) CollectAll(ctx context.Context) []ReportItem {
	now := time.Now().UTC()
	item := func(t string, p map[string]any) ReportItem {
		return ReportItem{SchemaVersion: 1, Type: t, ObservedAt: now, Payload: p}
	}
	var out []ReportItem

	// database (also the inventory for the Database Explorer)
	var db inventory.Database
	dbState := "down"
	if a.Pool == nil {
		db = inventory.Database{Error: "database_unavailable", Tables: []inventory.Table{}}
	} else {
		db = inventory.Collect(ctx, a.Pool)
		if db.Available {
			dbState = "up"
		}
	}
	tables := make([]map[string]any, 0, len(db.Tables))
	for _, t := range db.Tables {
		var est any
		if t.EstimatedRows != nil {
			est = *t.EstimatedRows
		}
		tables = append(tables, map[string]any{"schema": t.Schema, "name": t.Name, "estimatedRows": est, "sizeBytes": t.SizeBytes, "columns": t.Columns, "hasPrimaryKey": t.HasPrimaryKey, "indexes": t.Indexes, "foreignKeys": t.ForeignKeys})
	}
	a.lastInventory = db
	dbp := map[string]any{"available": db.Available, "migrationsApplied": db.MigrationsApplied, "sizeBytes": db.SizeBytes, "tables": tables}
	if db.DatabaseName != "" {
		dbp["databaseName"] = db.DatabaseName
	}
	if db.ServerVersion != "" {
		dbp["serverVersion"] = db.ServerVersion
	}
	if db.SchemaVersion != "" {
		dbp["schemaVersion"] = db.SchemaVersion
	}
	if db.LastMigratedAt != nil {
		dbp["lastMigratedAt"] = tsOrNil(db.LastMigratedAt)
	}
	if db.Error != "" {
		dbp["error"] = db.Error
	}
	out = append(out, item("database", dbp))

	out = append(out, item("host_resources", a.hostResources()))

	apiState, apiDetail := a.probeAPI(ctx)
	services := []map[string]any{
		{"name": "edge-postgres", "probe": "database", "state": dbState},
		{"name": "edge-api", "probe": "http", "state": apiState},
		{"name": "edge-agent", "probe": "self", "state": "up"},
	}
	if apiDetail != "" {
		services[1]["detail"] = apiDetail
	}
	if dbState == "down" {
		services[0]["detail"] = "database_unavailable"
	}

	var hs *healthStatus
	if a.Pool != nil && db.Available {
		if h, err := queryHealthStatus(ctx, a.Pool); err == nil {
			hs = h
		} else {
			a.Log.Warn("health status query failed", "err", redact.Text(err.Error(), 200))
		}
	}
	workerState, backupState := "unknown", "unknown"
	var workerSeen any
	if hs != nil {
		workerState = "stale"
		if hs.WorkerLastSeen != nil {
			workerSeen = tsOrNil(hs.WorkerLastSeen)
			if now.Sub(*hs.WorkerLastSeen) < 3*time.Minute {
				workerState = "up"
			}
		}
		backupState = "up"
		if hs.BackupStatus == "failed" {
			backupState = "stale"
		}
	}
	services = append(services,
		map[string]any{"name": "edge-worker", "probe": "liveness", "state": workerState, "lastSeenAt": workerSeen},
		map[string]any{"name": "edge-backup", "probe": "liveness", "state": backupState})
	out = append(out, item("containers", map[string]any{"services": services}))

	if hs != nil {
		psaStatus := hs.PSAStatus
		if psaStatus == "" {
			psaStatus = "not_configured"
		}
		psaReport := map[string]any{
			"provider": hs.PSAProvider, "instanceCode": hs.PSAInstance, "status": psaStatus, "credentialFields": len(a.Cfg.PSA.CredentialFields),
			"credentialsPresent": hs.PSACredsPresent, "lastTestAt": tsOrNil(hs.PSALastTestAt), "lastTestResult": strOrNil(hs.PSALastTestResult), "apiCallsImplemented": true,
		}
		if ps, err := queryPSAStatus(ctx, a.Pool); err == nil {
			psaReport["lastTestCode"] = strOrNil(ps.LastTestCode)
			psaReport["lastTestHttpStatus"] = intOrNil(ps.LastTestHTTPStatus)
			psaReport["lastTestLatencyMs"] = intOrNil(ps.LastTestLatencyMs)
			psaReport["lastTestedBy"] = strOrNil(ps.LastTestedBy)
			psaReport["lastSuccessAt"] = tsOrNil(ps.LastSuccessAt)
			psaReport["remoteIdentity"] = ps.RemoteIdentity
			psaReport["consecutiveFailures"] = ps.ConsecutiveFailures
			psaReport["testsLast24h"] = ps.Tests24h
			psaReport["failedTestsLast24h"] = ps.Failures24h
		} else {
			a.Log.Warn("psa status query failed", "err", redact.Text(err.Error(), 200))
		}
		out = append(out, item("psa_integration_status", psaReport))
		ticketReport := map[string]any{
			"ticketsTotal": hs.TicketsTotal, "ticketsOpen": hs.TicketsOpen, "eventsLast24h": hs.Events24h, "failedLast24h": hs.Failed24h, "lastProcessedAt": tsOrNil(hs.TicketLastAt),
		}
		var ss *syncStatus
		if v, err := querySyncStatus(ctx, a.Pool); err == nil {
			ss = v
			ticketReport["pendingOutbound"] = v.PendingOutbound
			ticketReport["conflictsLast24h"] = v.Conflicts24h
			ticketReport["localOnly"] = v.LocalOnly
			ticketReport["pushFailed"] = v.PushFailed
		}
		out = append(out, item("ticket_processing_metrics", ticketReport))
		errs := []map[string]any{}
		if rows, err := a.Pool.Query(ctx, `SELECT occurred_at, component, error_code, http_status, message FROM edge_recent_errors(10)`); err == nil {
			for rows.Next() {
				var at time.Time
				var comp, msg string
				var code *string
				var status *int16
				if rows.Scan(&at, &comp, &code, &status, &msg) == nil {
					e := map[string]any{"at": at.UTC().Format(time.RFC3339Nano), "component": comp, "code": strOrNil(code), "httpStatus": nil, "message": redact.Text(msg, 200)}
					if status != nil {
						e["httpStatus"] = int(*status)
					}
					errs = append(errs, e)
				}
			}
			rows.Close()
		}
		var syncErrCode any
		if hs.SyncError != nil {
			syncErrCode = *hs.SyncError
		}
		syncReport := map[string]any{
			"lastRunAt": tsOrNil(hs.SyncLastAt), "lastStatus": strOrNil(hs.SyncStatus), "itemsReceived": intOr0(hs.SyncRecv), "itemsSent": intOr0(hs.SyncSent),
			"itemsFailed": intOr0(hs.SyncFailed), "errorCode": syncErrCode, "httpStatus": nil, "recentErrors": errs, "errorsLast24h": hs.Errors24h,
		}
		if ss != nil {
			syncReport["lastSucceededAt"] = tsOrNil(ss.LastSucceededAt)
			syncReport["runsLast24h"] = ss.Runs24h
			syncReport["failedRunsLast24h"] = ss.FailedRuns24h
			syncReport["watermark"] = tsOrNil(ss.Watermark)
			syncReport["implemented"] = true
		}
		out = append(out, item("synchronization", syncReport))
		var size any
		if hs.BackupSize != nil {
			size = *hs.BackupSize
		}
		out = append(out, item("backup", map[string]any{"lastStatus": hs.BackupStatus, "lastAt": tsOrNil(hs.BackupAt), "lastSizeBytes": size, "retained": hs.BackupRetained, "lastError": strOrNil(hs.BackupError)}))
	}

	var schema any
	if db.SchemaVersion != "" {
		schema = db.SchemaVersion
	}
	var pg any
	if db.ServerVersion != "" {
		pg = db.ServerVersion
	}
	// image: the version this binary was built into (the image tag), not the package's intended image; an upgrade is only reported once it really runs.
	out = append(out, item("versions", map[string]any{"agent": a.Version, "image": a.Version, "application": a.Version, "schema": schema, "postgres": pg}))

	if s := a.LoadState(); s.State == "enrolled" && s.NotAfter != nil && s.Serial != "" {
		failed, locked := 0, false
		if hs != nil {
			failed, locked = hs.AdminFailed24h, hs.AdminLocked
		}
		out = append(out, item("certificates_security", map[string]any{
			"certificateSerial": s.Serial, "certificateNotAfter": s.NotAfter.UTC().Format(time.RFC3339Nano), "daysRemaining": int(time.Until(*s.NotAfter).Hours() / 24),
			"localAdminFailedLogins24h": failed, "localAdminLocked": locked, "encryptedDiskConfirmed": nil,
			// Module 16: the appliance's own verification of its license token.
			"license": a.LicenseStatus(),
		}))
	}
	return out
}
