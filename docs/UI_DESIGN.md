# PSA Control Center — UI / UX Design

Covers deliverables 5–10: dashboard, navigation, onboarding, deployment management, health monitoring, and Database Explorer.

## Design identity — "Signal"

An original, bright enterprise identity. **Calm surfaces, vivid signals:** neutral cool surfaces carry the content, and saturated color appears only where it means something (status, primary action, active navigation, chart series).

| Token | Value | Use |
|---|---|---|
| `--color-primary` | `#2563EB` | Primary actions, active nav, links, focus ring |
| `--color-cyan` | `#06B6D4` | Secondary data series, informational accents |
| `--color-emerald` | `#10B981` | Healthy / success |
| `--color-violet` | `#8B5CF6` | PSA / integration accents, tertiary series |
| `--color-amber` | `#F59E0B` | Degraded / warning |
| `--color-red` | `#EF4444` | Critical / destructive |
| `--color-bg` | `#F5F8FF` | App background |
| `--color-card` | `#FFFFFF` | Cards, tables, sidebar |
| `--color-ink` | `#0F172A` | Primary text |
| `--color-muted` | `#64748B` | Secondary text |

Text drawn on status colors uses the darker shade of that hue (e.g. `#047857` on emerald-50) to keep **WCAG AA contrast ≥ 4.5:1**. Raw `#10B981` text on white fails AA, so it is never used for text.

**Typography:** Inter (UI) and JetBrains Mono (identifiers such as `DEP-00042`, digests, versions). Scale: 12 / 13 / 14 (body) / 16 / 20 / 24 / 30. Tabular numerals in KPIs and tables.

**Shape and depth:** 12px card radius, 1px `slate-200/70` borders, two-layer soft shadow (`0 1px 2px` + `0 8px 24px -12px` tinted blue). One subtle brand gradient (blue → cyan → violet) is reserved for the logo mark, the welcome header hairline, and the primary chart. It is not used on surfaces.

**Status language** (used identically in pills, chart colors, and timeline):

| State | Dot | Pill |
|---|---|---|
| Healthy | emerald | emerald-50 / emerald-700 |
| Degraded | amber | amber-50 / amber-800 |
| Critical | red | red-50 / red-700 |
| Offline | slate-500 | slate-100 / slate-700 |
| Unknown | slate-300 dashed | slate-50 / slate-600 |

**State patterns:** every data region implements four states: loading (skeleton matching final layout), empty (icon + one-line explanation + the *real* next action, or "available in Module N"), error (inline alert with request ID and retry), and success (inline confirmation banner on the destination page, never a toast).

**No pop-ups:** there are no modal dialogs, popup wizards, `alert()`, `confirm()`, or toasts. Destructive or important confirmations use an inline confirmation section or a dedicated `/…/confirm` route. Playwright tests fail on any browser dialog.

---

## 5. Dashboard (`/dashboard`)

```
┌ Sidebar ─┬───────────────────────────────────────────────────────────────────────────┐
│ ◆ PSA    │ Overview                     [ Search clients, deployments…  ⌘K ] 🔔3  DEV  (AV)│
│ Control  ├───────────────────────────────────────────────────────────────────────────┤
│ Center   │ ⚠ Development sample data — 26 clients / 30 deployments are synthetic.        │
│          │                                                                            │
│ Overview │  Good afternoon, Avery                         Data as of 14:02 • Refresh ⟳ │
│ Clients  │  Operations overview for TechPio Development                                │
│ PSA      │                                                                            │
│ Services │ ┌Total clients┐┌PSA instances┐┌Active deploy.┐┌Offline deploy.┐            │
│ Deploy…  │ │ 26   +3 /30d││ 31  7 provid││ 22  of 30    ││ 3  needs atten.│            │
│ Images   │ └─────────────┘└─────────────┘└──────────────┘└───────────────┘            │
│ DB Expl. │ ┌Healthy inst.┐┌Critical     ┐┌Docker vers.  ┐┌Recent deploy. ┐            │
│ Health   │ │ 18  60%     ││ 2           ││ 4  latest 1.4││ 5  last 30 d  │            │
│ Integr.  │ └─────────────┘└─────────────┘└──────────────┘└───────────────┘            │
│ Licenses │ ┌ Installation status over time (stacked area, 30d) ──┐┌ Health dist. ─┐  │
│ Audit    │ │                                                     ││  (donut)      │  │
│ Settings │ └─────────────────────────────────────────────────────┘└───────────────┘  │
│          │ ┌ Client onboarding (12 mo) ┐┌ PSA providers (bar) ┐┌ Versions (bar) ┐     │
│          │ └───────────────────────────┘└─────────────────────┘└────────────────┘     │
│ (AV)     │ ┌ Recent deployments (table: ID, client, PSA, version, lifecycle, health, │
│ Avery V. │ │ last heartbeat, synthetic badge)                                          │
└──────────┴───────────────────────────────────────────────────────────────────────────┘
```

- KPI cards have an icon tile (tinted), a label, a large tabular value, and a one-line context. Each card links to its owning page.
- **Provenance:** when any visible record is synthetic, a persistent amber banner states the counts. Rows carry a `Synthetic` badge. Live states are never implied for synthetic rows ("last heartbeat" shows `synthetic` instead of a relative time).
- All values come from `GET /api/v1/dashboard/summary`, scoped by the viewer's RBAC client scope.
- Responsive: 4-col KPIs (≥1280px) → 2-col (≥640px) → 1-col. Under 1024px the sidebar collapses into a menu button that expands the navigation inline, pushing the content down rather than overlaying it.

## 6. Navigation structure

**Sidebar** (grouped):

| Group | Item | Route | Permission | Module |
|---|---|---|---|---|
| — | Overview | `/dashboard` | `dashboard.read` | 1 |
| Operate | Clients | `/clients` | `clients.read` | 2 |
| | PSA Management | `/psa` | `psa.read` | 3 |
| | Service Catalog | `/services` | `services.read` | 4 |
| | Deployments | `/deployments` | `deployments.read` | 5 |
| Infrastructure | Docker Images | `/docker-images` | `deployments.read` | 6 |
| | Database Explorer | `/database-explorer` | `database.metadata.read` | 9 |
| | Health Monitoring | `/monitoring` | `health.read` | 8 |
| Platform | Integrations | `/integrations` | `integrations.read` | 11 |
| | Licenses | `/licenses` | `licenses.read` | 14 |
| | Activity & Audit Logs | `/audit` | `audit.read` | 1 |
| | Settings | `/settings` | authenticated | 1 |

Items whose module is not yet built still appear, and they lead to an honest "Planned — Module N" page with no fake controls. Items the user lacks permission for are hidden; the API still enforces permissions independently.

**Top bar:** page title (+ breadcrumbs on detail pages), global search (submits to the full-page `/search?q=`), notifications bell (count of critical/offline deployments → `/notifications`), environment badge (DEV blue / TEST violet / STAGING amber / PROD red outline), and user button (profile, security, sign out).

**Breadcrumbs:** every non-root page shows `Section / Entity / Sub-page`. Workflow pages have **Back** and **Continue** buttons at the bottom of the page.

## 7. Client onboarding (Module 2) — `/clients/new` wizard

A full-page wizard with a persistent vertical stepper on the left (≥1024px) or a compact progress header (mobile). Each step is its own URL: `/clients/new/[draftId]/[step]`. Progress is saved server-side in `onboarding_drafts` on every **Continue**, so a refresh or a later visit resumes in the same place.

| # | Step | Content |
|---|---|---|
| 1 | Client information | Company block (legal name, display name, reference w/ live uniqueness check, business type, country/state/city, time zone, website), contacts block (primary/technical/billing, repeatable rows) |
| 2 | PSA provider | Provider cards (logo glyph, capabilities, "configuration only · runs on the client appliance") |
| 3 | PSA configuration | Provider-specific form rendered from the adapter's config schema; credentials section explains appliance-side entry |
| 4 | Services | Category-grouped checklist; **Help Desk pre-selected**; dependency hints ("requires PSA ticket capability") |
| 5 | Deployment preferences | Environment (Windows Docker / Linux Docker / VM / client server / cloud VM / local test), OS, architecture (amd64/arm64), hostname label |
| 6 | Review | Read-only summary per step with "Edit" links back to that step |
| 7 | Create deployment | Inline confirmation section; on submit shows generated Client / PSA Instance / License / Deployment / Installation IDs and token expiry (token value shown once). Since Module 14 the wizard also creates the client's first license (one deployment, the contract term) so step 8 can generate the package |
| 8 | Download | Package card (files list, SHA-256, size), download button, install commands per OS |
| 9 | Verify installation | Live checklist: package downloaded → enrolled → first heartbeat → DB initialized → schema verified, each with timestamps from real events |
| 10 | Complete | Health summary + links to the deployment's dashboard pages |

## 8. Deployment management (Module 5+) — `/deployments/[id]`

Header: `DEP-00042` (mono), client name, PSA chip, health pill, and a lifecycle **stage tracker**:
`Generated → Downloaded → Enrolled → Verified` (plus `Suspended` / `Decommissioned` side states). Each stage shows its timestamp and source event. Downloading never advances the tracker past *Downloaded*.

Sub-navigation (link tabs, each a route): **Overview** · **Installation** (`/installation`: package versions, digest, download, commands, verification script) · **Health** (`/health`) · **Database** (`/database`) · **Logs** (`/logs`: agent-reported errors and installation events) · **Settings** (`/settings`).

Overview cards: identity (Deployment / Installation / License IDs, image version + digest, target platform), agent (status, version, last heartbeat, certificate expiry), database (status, schema version, table count), and recent errors.

## 9. Health monitoring (Module 8) — `/monitoring` and `/deployments/[id]/health`

- **Fleet view:** scorecards per health state (click filters the table), a fleet table sortable by severity/last heartbeat, and a health timeline (stacked bar per hour).
- **Deployment view:** a component checklist (agent, edge-api, edge-worker, PostgreSQL, migrations, disk) with the rule that produced each state; CPU/memory/disk line charts (last 24h, agent-reported only); a heartbeat history strip (one tick per heartbeat, gaps visible); a service health breakdown; and the latest error with timestamp and correlation ID.
- Refresh button + "auto-refresh every 30s" toggle; all timestamps in the user's profile time zone with UTC in tooltip/title.
- "Heartbeat received" never equals "Healthy". The rules table is shown on the page.

## 10. Database Explorer (Module 9) — `/deployments/[id]/database` and `/database-explorer`

- Header facts: database name, PostgreSQL version, connection status, size, table count, schema version, migration version, last successful inspection, inspection errors.
- Table list: Table · Schema · **Est. rows** (column header has an `≈` marker and a footnote: "from `pg_class.reltuples`; not an exact count") · Size · Status. Rows link to `/deployments/[id]/database/tables/[schema].[table]`.
- Table detail: columns (name, type, nullable, default), primary key, indexes (definition, unique), foreign keys (→ target), row-count metadata (estimate, last analyze/vacuum).
- **Explicitly absent:** no record browser, no SQL console, no query box, no destructive buttons. A footer note explains that inspection is metadata-only and performed by the appliance's `edge_inspector` role, which has no table privileges.
- `/database-explorer` is the fleet entry point: choose a deployment (scoped by RBAC), then open its explorer.

## 11. Service Catalog (Module 4) — `/services`

- **List**: category tiles (active / inactive counts) act as filters; the filter row (search, category, status, PSA use, dependency) submits to the server and lives in the URL. Columns: Service (name, key, Default / Uses PSA badges) · Category · Dependencies (chips) · Settings (count, required) · Clients · Status.
- **Detail** (`/services/[id]`): definition rows, status card with inline activate / deactivate confirmation (states the consequences and the assigned-client count), dependency chips with a **provider support matrix** built from the adapter descriptors, configuration requirements, assigned clients (with "Settings incomplete" where required values are missing) and recent activity.
- **Create / edit** (`/services/new`, `/services/[id]/edit`): one full-page form; the key is suggested from the name and read-only once created; choosing a PSA-data dependency switches "Uses the client's PSA" on; the requirements editor adds settings inline (label, camelCase key, type, required, description, placeholder, options or range). Secrets are refused with an explanation.
- **Categories** (`/services/categories`): table plus a "New category" card on the same page; edit on `/services/categories/[id]` with delete behind an inline confirmation, only when empty.
- **Where it shows up**: the client Services page renders the requirement fields under each selected service, marks inactive-but-assigned services, and warns about dependencies no client PSA supports; the wizard's services step does the same; deployment pages show "settings incomplete" on a service and the readiness check *Service settings complete*.

## 12. Integrations (Module 11) — `/integrations` and the appliance's credentials page

- **Integrations** (`/integrations`): four counters (Verified, Failing, Untested, Appliances reporting), filters (search, provider, connection, credentials, live only) that run on the server, and a table: PSA instance · Client · Connection · Credentials · Last test on the appliance (code label, time, HTTP status, latency, who ran it) · Appliance (deployment link). Failing rows sort first. The page states that statuses come from the appliance and that the Control Plane never calls a PSA; there is no "test" button here by design.
- **PSA instance page**: the Connection card shows the status plus what the bound appliance reported (deployment, last test with code / HTTP / latency / run by, consecutive failures, remote identity such as API name and host); a **Connection tests** table lists every reported test, newest first. The activity feed shows `psa_instance.connection.reported` events.
- **Appliance local admin** (`http://127.0.0.1:<port>/credentials`): credential fields, an optional private CA certificate (PEM) for on-premise servers, **Test connection now** (synchronous, result inline with code, HTTP status, latency and the non-secret remote identity), and the last ten tests. The dashboard shows the last outcome.

## 13. Tickets and synchronization (Module 12) — appliance pages and Control Plane counters

- **Appliance → Tickets** (`/tickets`): filters (search, status, sync state), counts per status, table (ticket + PSA id + origin · status with the PSA's label · priority · requester · sync state pill · updated), paging, *New ticket*. **Ticket** (`/tickets/{id}`): fields, description, actions (change status, add note — stored first, pushed by the worker) and the timeline with push outcome per local event. **New ticket**: title, description, priority, requester; the page says whether the PSA will receive it (custom REST) or it stays local (Autotask / ConnectWise without a company mapping).
- **Appliance → Synchronization** (`/sync`): last success, inbound watermark, runs in 24 h, local changes waiting, conflicts, local-only tickets, schedule, *Sync now* (disabled until the connection is verified), and the last 20 runs with trigger, status, counts, pages and error code.
- **Control Plane**: Integrations gains *Synchronization* (status, time, in/out/failed, code) and *Tickets* (open / total, waiting to push) columns; the PSA instance page shows the same in the connection card; the deployment health page has a *Tickets & synchronization* card. All of it is counts and statuses; there is no ticket browser on the Control Plane by design.

## 14. Remote operations (Module 13) — deployment Operations tab

- **Deployment → Operations** (`/deployments/{id}/operations`): header facts (appliance image with *up to date* / *upgrade available*, standard image, command signing key, open commands); a grid of the six possible commands as selectable cards (disabled while one of that type is open, or when an upgrade would be a no-op); selecting a card opens an **inline** issue panel (what it does, where it runs, service picker for restarts, expiry 15 min – 24 h, optional note) with *Issue command* / *Back* — no dialog. **Command history** table: command (type, parameters, short ID, signing key, note), status pill (*Waiting for the agent*, *Delivered — running on the appliance*, *Staged — waiting for the host operator*, *Succeeded*, *Failed*, *Expired*, *Cancelled*), issued (time, by), expiry, the appliance's answer (code, message, finished time, agent version), and *Cancel* for pending commands only. A second card explains the protections and lists the deliberately absent destructive operations (Modules 14–15).
- **Deployment → Health**: *Ask the appliance to report now* issues a `refresh_health` command with inline feedback and a link to Operations.
- **Appliance local admin → Status**: a *Remote commands* card lists the commands the agent handled (received, type, outcome, detail, reported) and, when an upgrade is staged, a notice with the exact host command (`scripts/upgrade.sh`), the target image and the order's expiry.
- Readers without `deployments.commands.issue` see the history and a sentence saying which permission issuing needs; drafts and synthetic records say why nothing can be issued.

## 15. Licenses and lifecycle (Module 14)

- **Licenses** (`/licenses`): count cards (all, active, expiring within 30 days, suspended, expired / revoked) that act as filters; search by license ID, plan or client; status filter; table with license ID (+ synthetic badge), client, plan, status pill, term with *Ends in N day(s)* / *Ended N day(s) ago* / *Perpetual*, deployments used of allowed (+ *full*); pagination. **New / edit** (`/licenses/new`, `/licenses/{id}/edit`): full-page form (client, plan, starts, ends or perpetual, maximum deployments, notes) with inline validation. **Detail** (`/licenses/{id}`): entitlement card (IDs, plan, term, usage, status with the suspension / revocation reason, created / updated by), what the license controls, inline *Suspend / Resume / Revoke* with a reason (no dialog), the deployments under the license, and its audit activity. Synthetic licenses are read-only and labelled.
- **Client overview** gains a *Licenses* card (code, plan, status, usage; *New license* for managers). **Deployment overview**: the identity card shows the **License ID** (code, plan, status, end), and the lifecycle card gains *Suspend deployment* / *Resume deployment* with an inline reason; while suspended a warning explains since when, by whom, why and which state returns on resume. **Deployment settings** (drafts): a license selector showing capacity.
- **Operations tab**: lifecycle commands appear in the history (*Suspend (lifecycle)*, *Resume (lifecycle)*) but never as issue cards; while suspended the page says commands cannot be issued and why. **Health** shows `deployment_suspended` and the licensing findings.
- **Appliance local admin**: a red *Suspended by the provider* banner (since, reason) on the status and synchronization pages, *Sync now* disabled; the status page shows the license identifier and the lifecycle state.


## 16. Decommissioning and removal (Module 15)

- **Deployment overview**: the lifecycle card offers *Decommission (final)…* (permission `deployments.decommission`; never for synthetic records) as a link to a **full page** `/deployments/[id]/decommission`: a summary of the record (client, lifecycle, installation ID, license, last heartbeat, active certificate, usable package), two explanatory panels (what happens on the Control Plane now; what happens on the client's host — never remotely, nothing deleted), a reason field and a *Type DEP-nnnnn to confirm* field with inline validation, and a danger button. No dialog, no popup.
- **After decommissioning** the overview shows a success alert and a *Decommissioned* card: when, by whom, why, the state it had before, what was retired (certificates, tokens, packages, cancelled commands), when the retained metadata is purged (or was), the **removal instructions** for Linux and Windows hosts (stop vs. wipe with the typed ID), and *Remove from the Control Plane* with an inline typed confirmation. The lifecycle tracker shows the history of the retired appliance; *Suspend* and *Decommission* are gone; Operations and Health explain why nothing can be issued or measured.
- **Deployments list**: *Suspended* and *Decommissioned* stage cards act as filters beside the five build stages.
- **Settings → Data retention** (`/settings/retention`, `settings.manage`): three count cards (decommissioned, awaiting purge with the next due time, purged), the retention days field with inline validation, *Reset to default (90 days)*, and *Purge what is due now* with an inline confirmation and an honest result (how many were purged, or that nothing was due).
- **Appliance local admin**: a red *Decommissioned by the provider* banner on the status and synchronization pages (linking to *Removal*), *Sync now* disabled, the lifecycle pill *decommissioned*, and a **Removal** page with the order of operations, the stop and wipe commands for both host types, and what the Control Plane keeps.
