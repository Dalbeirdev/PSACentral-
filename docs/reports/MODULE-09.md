# Module 9 Completion Report — Database Explorer

**Date:** 2026-10-14 · **Environment:** Windows 11, Docker Engine 29.1.3 + Compose 2.40.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete** (Module 9 scope)

**Tests: 432 executed, 432 passed, 0 failed, 0 skipped** — Go unit 24 · contracts 33 · API 252 (79 unit, 173 integration, of which **17 on the real Docker Engine**) · web unit 28 · E2E 95 (desktop and mobile). The real-Docker suite installs two client appliances (Autotask and ConnectWise) from generated packages and asserts the Control Plane's table pages against their live catalogs; the screenshots, `database-api-sample.json`, `table-detail-api-sample.json` and `inspector-privileges.txt` come from a third live appliance installed against the development stack.

**What works now:**
- The agent inspects the appliance database as `psa_edge_inspector` — a role with **no privileges on any table** — and reports, over its mutual-TLS channel, the inventory (database name, PostgreSQL version, size, schema and migration version, and per table the planner's row estimate, size, and column/index/key counts) plus a **schema snapshot** per table: columns (type, nullability, default expression, identity), primary key, indexes (definition and size), foreign keys (columns, referenced table, `ON DELETE`) and row-count statistics (estimate, live/dead rows, last analyze/vacuum, table/index/TOAST bytes).
- Pages: `/database-explorer` (fleet entry point, synthetic records separated, availability tiles and filters), `/deployments/[id]/database` (header facts, inspection errors, the table list with **≈ estimated rows** and the `pg_class.reltuples` footnote, status per table, a real-data chart of the largest tables) and `/deployments/[id]/database/tables/[schema.table]` (columns, primary key, foreign keys linking to their target tables, indexes, statistics).
- **Explicitly absent:** no record browser, no SQL console, no query box, no destructive buttons; every page states the metadata-only boundary. No API endpoint can return a row.
- On the real Docker engine, both client appliances reported their 13-table inventory and the full schema snapshot from the live catalog; the Control Plane's table pages show `helpdesk_tickets`' real columns, key, index and foreign key.

**Honest limits:**

| Area | Status |
|---|---|
| Row counts | Planner estimates (`pg_class.reltuples`, `pg_stat_all_tables`), shown as `≈` or "not analysed". The inspector cannot run `COUNT(*)` by design, so exact counts do not exist on the Control Plane. |
| Schema freshness | Details are a snapshot: sent when the inventory fingerprint changes, re-sent every 6 h, retried every 5 min until acknowledged. A column type change that leaves the column count unchanged is picked up by the 6-hourly resend. |
| Scope | Tables in the `public` schema (`relkind` r/p). Views, sequences and other schemas are not inventoried. |
| Comments | Table and column comments are not reported: they are free text and could carry anything. |

---

## Agent (edge appliance)

| Part | Implementation |
|---|---|
| Inventory | `internal/inventory.Collect` now also reports `databaseName` (`current_database()`). Unchanged otherwise. |
| Schema snapshot | `internal/inventory.CollectSchema`: four catalog-wide queries (`pg_class`/`pg_stat_all_tables`, `pg_attribute`+`pg_attrdef`, `pg_constraint`, `pg_index`) as the inspector role; DDL text from `pg_get_indexdef` / `pg_get_expr`. `inventory.Fingerprint` hashes the schema version, migration count and each table's column/index/key counts. |
| Scheduling | `internal/agent/schema.go`: `schemaDue` (fingerprint changed → now; unacknowledged → retry every 5 min; acknowledged → every 6 h). State keeps `schemaAttemptFingerprint/At` and `schemaDeliveredFingerprint`; delivery marks the fingerprint acknowledged only when the Control Plane accepted the batch with no rejection. |
| Transport | Parts of at most 25 tables, one outbox batch each (`report-<ts>-NN.json`), through the existing bounded outbox and `/agent/v1/reports` delivery. `printable()` bounds definitions and defaults to printable ASCII (200 / 500 chars). |

## Control Plane

| Part | Implementation |
|---|---|
| Contracts | `databaseSchemaReportSchema` (strict; `fingerprint`, `part`/`parts`, ≤ 50 tables with ≤ 300 columns, ≤ 100 indexes, ≤ 100 foreign keys; DDL as bounded printable ASCII; `onDelete` enum) added to `REPORT_SCHEMAS`; `databaseName` on the database report; `EDGE_REPORT_TYPES` now lists 10 types. DTOs in `packages/contracts/src/database-explorer.ts`. |
| Storage (migration `0007`) | `deployment_tables`: one row per deployment table (kind, fingerprint, observed/received, `columns`, `primary_key`, `indexes`, `foreign_keys`, `stats` as jsonb with type checks), FORCE RLS with client scope. |
| Ingestion | `storeSchemaPart` upserts each table (an older part never overwrites a newer row); the last part of a snapshot deletes rows with another fingerprint. Parts are **not** kept in `deployment_reports`. Invalid parts are rejected per report and audited (`agent.report.rejected`) without the offending content, like every other report. |
| API (`database.metadata.read`) | `GET /database-explorer` (summary and rows, `q`/`live`/`availability`), `GET /deployments/:id/database` (summary, inventory merged with detail availability, inspection state, errors of the last 7 days grouped by code), `GET /deployments/:id/database/tables/:schema/:table` (404 when never reported). Read-only; no write routes exist. |

## Frontend

| Route | What it does |
|---|---|
| `/database-explorer` | Fleet entry point: synthetic alert with "show live only", tiles for available / unavailable / awaiting first inventory (filters), search, and per deployment the database name and availability, health, PostgreSQL version, schema version and migrations, table count and how many have details, size, last inventory. Rows open the deployment's database page. |
| `/deployments/[id]/database` | Header facts (name, connection, PostgreSQL, size, tables, schema version, migrations, last successful inventory, schema details progress, inspection errors); inspection error codes; the table list (**Est. rows ≈** with footnote, size, columns, PK / indexes / FK counts, status: Analysed / Never analysed / Details pending); a Recharts bar chart of the largest tables from real inventory sizes (with a data table); the metadata-only note. Synthetic records and deployments without reports show honest placeholders. |
| `/deployments/[id]/database/tables/[schema.table]` | Statistics (estimate, live/dead rows, last analyze/vacuum, size breakdown), columns (position, name, type, nullable, default, identity; PK columns marked), primary key, foreign keys (linking to the referenced table's page), indexes (unique/primary/size/definition). Unknown or malformed table references are real 404s. |
| Elsewhere | Database Explorer is no longer "Planned" in navigation; the deployment "Database" tab and the Health page's "Database tab for the inventory" now lead to real pages. |

## Security

- **Data boundary:** the inspector role has no table privileges (verified on the real appliance: `has_table_privilege` is false for every public table); the strict schema rejects any field beyond catalog metadata (`rows`, `sample`, a non-printable definition, `part > parts`), and the rejection audit never contains the offending content.
- **Authorization:** every route requires `database.metadata.read` (held by super/ops/tech admins, technicians for assigned clients, security admin, auditor; not by Read Only). RLS scopes `deployment_tables` by organization and client: a technician gets 404 for an unassigned client's deployment, organization B sees nothing, and the application role without a tenant context reads 0 rows.
- **No mutation path:** only GET routes; the pages have no form, textarea or button other than Refresh (asserted in E2E).

## Testing — executed results

Raw output in [`module-09/`](module-09): `edge-go-test.txt`, `api-vitest.txt` (including both real-Docker suites), `contracts-vitest.txt`, `web-vitest.txt`, `e2e-playwright.txt`, `typecheck.txt`. Real-appliance evidence: `database-api-sample.json`, `table-detail-api-sample.json` (the explorer's view of a live appliance), `inspector-privileges.txt` (the inspector role can read 0 tables) and `agent-log-excerpt.txt`. Screenshots are in [`module-09/screenshots/`](module-09/screenshots). The evidence files were scanned for secrets and enrollment tokens; none were found.

| Suite | Files | Tests | Result |
|---|---|---|---|
| Go unit (`go vet` + `go test`, edge appliance; schema scheduling, fingerprint, parts, acknowledgement added) | 6 packages | 24 | ✅ |
| TypeScript typecheck (all workspaces) | — | — | ✅ 0 errors |
| Contracts (strict `database_schema` report added) | 5 | 33 | ✅ |
| API unit | 5 | 79 | ✅ |
| API integration (real PostgreSQL, rebuilt per run), including the explorer suite (4), health (7), gateway (10) and the two real-Docker suites (12 + 5) | 13 | 173 | ✅ |
| Web unit (explorer helpers added) | 4 | 28 | ✅ |
| E2E — Edge, production build with its own agent gateway, desktop 1440 px + mobile 375 px, including `database-explorer.spec.ts` (4) | 12 | 95 | ✅ |
| **Total** | | **432** | **✅ 0 failed, 0 skipped** |

### Representative Module 9 cases

| # | Category | Test | Input | Expected | Actual | ✓ |
|---|---|---|---|---|---|---|
| 1 | Unit (contracts) | Strict schema report | Valid part; `rows` on a table; `sample` on a column; 501-char definition; non-ASCII default; `part 3 of 2`; non-hex fingerprint; 51 tables | Accepted; rejected ×7 | As expected | ✅ |
| 2 | Go unit | Snapshot scheduling | Never collected; attempted 1 min / 6 min ago unacknowledged; acknowledged 1 h / 7 h ago; fingerprint changed | due; not due; due; not due; due; due | As expected | ✅ |
| 3 | Go unit | Fingerprint | Row estimate and size change; a column added | Unchanged; changed | As expected | ✅ |
| 4 | Go unit | Parts | 28 tables with a multi-line index definition | 2 parts (25 + 3), `database_schema` type, no `rows`/`sample`/`records`/`value` keys, definitions printable | As expected | ✅ |
| 5 | Go unit | Acknowledgement | Delivered batch carries the fingerprint | Not due until the periodic resend; still retried before | As expected | ✅ |
| 6 | Web unit | Helpers | `schema.table` refs, estimates, status, sizes | Round-trip, `≈ 1,234,567` / "not analysed", status from reported facts, GB formatting | As expected | ✅ |
| 7 | Integration | Snapshot projection | Snapshot 1 in two parts (3 tables); snapshot 2 (one table gone, one wider); a late older part | 3 rows → 2 rows with the new fingerprint and 6 columns; the late part does not overwrite; no `database_schema` history rows | As expected | ✅ |
| 8 | Integration | Deployment view | No reports; inventory; one detail; inventory failures | Nulls; 2 tables pending; 1 detailed / 1 pending (inventory counts win); errors grouped `database_unavailable ×2`, details kept, 404 for an unknown table, 400 for an over-long name | As expected | ✅ |
| 9 | Security | Strict rejection | `rows`, `sample`, `\u0000` in a definition, `part > parts` | 400 with the reason, nothing stored, ≥ 3 audit events without the secret text | As expected | ✅ |
| 10 | RBAC / isolation | Fleet and detail | Read Only; auditor and security admin; technician (unassigned); org B; app role without context; POST to a table route | 403; 200; 404 and absent from the fleet; 404 ×2 and absent; 0 rows; 404 | As expected | ✅ |
| 11 | Integration | Fleet filters | `live=1`, `availability=available/unavailable`, `q=<code>`, `availability=sometimes` | Synthetic excluded; present/absent; exactly one row; 400 | As expected | ✅ |
| 12 | **Docker** | Two real appliances | Autotask and ConnectWise appliances from generated packages | `psa_edge`, available, schema `0002`, **13 tables with details**; `helpdesk_tickets` has PK `id`, the expected columns, an FK to `psa_connections` and a btree PK index; no token, key, `rows` or `sample` in the response | As expected | ✅ |
| 13 | E2E | Fleet page | Live agent | "Awaiting first inventory" → Available / 17.6 after reports; live-only; availability filter; row opens the deployment page | As expected | ✅ |
| 14 | E2E | Database and table pages | Inventory then schema snapshot | `Est. rows ≈` + footnote, `≈ 0`, Details pending (no link) → Analysed, "1 of 1 tables", chart; no textarea/buttons but Refresh; table page shows 5 columns, `gen_random_uuid()`, PK, FK to `public.psa_connections`, index definition; unknown or malformed table → 404 | As expected | ✅ |
| 15 | E2E | Permission | Read Only user | 404 on the explorer and the deployment database page; no nav item; no Database tab | As expected | ✅ |
| 16 | Accessibility / responsive | axe and 375 px | Explorer, database and table pages | 0 serious or critical; no horizontal scroll | As expected | ✅ |

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | A whole-batch rejection returns 400 | Existing gateway behaviour when nothing in a batch is acceptable (the body still lists the reasons) | Test aligned; the agent already drops a 400 batch after logging the reasons |
| 2 | Failure reports back-dated in a test were not "latest" | `deployment_report_latest` keeps the newest `observed_at` by design | Test sends them with current timestamps |
| 3 | Stale generated route types after removing the placeholder | `.next/types` still referenced the deleted `[[...slug]]` route | Regenerated by restarting the dev server |

## Outstanding

- **Module 10:** the first-milestone demonstration (two client installations on one dashboard with real table inventory and live health) and control-plane containerization; fleet-scale load test (TEST-LOAD).
- Views, sequences and non-public schemas are outside the inventory; add when a client schema needs it.
- Notifications on inspection errors are backlog with the other alerting.

## Next module

**Module 10 — First milestone demonstration and control-plane containerization:** two separate client installations (independent PostgreSQL, different PSA providers) visible on one dashboard with live health and the real table inventory, the Control Plane packaged for Docker with its own compose stack, and the milestone acceptance evidence.
