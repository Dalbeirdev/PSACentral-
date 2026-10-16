import type { SystemRoleKey } from '@psacc/contracts';
import pg from 'pg';
import { hashPassword } from '../modules/auth/password.js';
import { psaAdapterProviders } from '../modules/psa/adapters/registry.js';
import { ensureDefaultServiceCatalog } from './reference-data.js';

const FIRST_NAMES = ['Alex', 'Jamie', 'Priya', 'Mateo', 'Hannah', 'Kenji', 'Olivia', 'Samuel', 'Aisha', 'Lucas', 'Nora', 'Ethan', 'Mei', 'Daniel', 'Zara', 'Oscar'];
const LAST_NAMES = ['Carter', 'Nakamura', 'Okoye', 'Fischer', 'Silva', 'Brennan', 'Patel', 'Lindqvist', 'Moreau', 'Haddad', 'Kowalski', 'Ramirez', 'Osei', 'Whitfield'];

/**
 * Synthetic development data. Every row is flagged is_synthetic = true and the UI labels it.
 * Names are fictional; websites and PSA endpoints use the reserved `.example` TLD.
 * Deterministic (seeded PRNG) so screenshots and tests are reproducible.
 */
export const SEED_ORG_SLUG = 'psacc-dev';

export const SEED_USERS: { email: string; name: string; role: SystemRoleKey; timezone: string }[] = [
  { email: 'avery.admin@psacc.test', name: 'Avery Vance', role: 'super_admin', timezone: 'America/New_York' },
  { email: 'jordan.ops@psacc.test', name: 'Jordan Ellis', role: 'ops_admin', timezone: 'America/Chicago' },
  { email: 'morgan.tech@psacc.test', name: 'Morgan Price', role: 'tech_admin', timezone: 'Europe/London' },
  { email: 'riley.technician@psacc.test', name: 'Riley Brooks', role: 'technician', timezone: 'America/Denver' },
  { email: 'casey.service@psacc.test', name: 'Casey Nguyen', role: 'service_manager', timezone: 'America/Los_Angeles' },
  { email: 'sam.security@psacc.test', name: 'Sam Okafor', role: 'security_admin', timezone: 'UTC' },
  { email: 'taylor.audit@psacc.test', name: 'Taylor Reyes', role: 'auditor', timezone: 'Asia/Kolkata' },
  { email: 'quinn.viewer@psacc.test', name: 'Quinn Harper', role: 'read_only', timezone: 'Australia/Sydney' },
];

type ClientSeed = [display: string, legal: string, business: string, country: string, region: string, city: string, tz: string];
const CLIENTS: ClientSeed[] = [
  ['Bluepeak Logistics', 'Bluepeak Logistics LLC', 'Logistics', 'US', 'Texas', 'Austin', 'America/Chicago'],
  ['Harbor & Finch Legal', 'Harbor & Finch LLP', 'Legal services', 'US', 'Massachusetts', 'Boston', 'America/New_York'],
  ['Northgate Dental Partners', 'Northgate Dental Partners PC', 'Healthcare', 'US', 'Illinois', 'Chicago', 'America/Chicago'],
  ['Copperleaf Architects', 'Copperleaf Architecture Studio Inc.', 'Architecture & engineering', 'US', 'Oregon', 'Portland', 'America/Los_Angeles'],
  ['Meridian Credit Union', 'Meridian Community Credit Union', 'Financial services', 'US', 'Ohio', 'Columbus', 'America/New_York'],
  ['Saltmarsh Brewing Co.', 'Saltmarsh Brewing Company Ltd', 'Manufacturing', 'GB', 'England', 'Bristol', 'Europe/London'],
  ['Alder & Vine Hospitality', 'Alder & Vine Hotels Ltd', 'Hospitality', 'GB', 'Scotland', 'Edinburgh', 'Europe/London'],
  ['Kestrel Aerospace Components', 'Kestrel Aerospace Components GmbH', 'Manufacturing', 'DE', 'Bavaria', 'Munich', 'Europe/Berlin'],
  ['Lumen Pediatrics', 'Lumen Pediatric Group', 'Healthcare', 'CA', 'Ontario', 'Toronto', 'America/Toronto'],
  ['Granite Ridge Construction', 'Granite Ridge Construction Ltd', 'Construction', 'CA', 'Alberta', 'Calgary', 'America/Edmonton'],
  ['Tidewater Insurance Brokers', 'Tidewater Insurance Brokers Inc.', 'Insurance', 'US', 'Virginia', 'Norfolk', 'America/New_York'],
  ['Silverline Retail Group', 'Silverline Retail Group Pty Ltd', 'Retail', 'AU', 'New South Wales', 'Sydney', 'Australia/Sydney'],
  ['Fernhill School District', 'Fernhill Unified School District', 'Education', 'US', 'California', 'Sacramento', 'America/Los_Angeles'],
  ['Orchid Bay Wellness', 'Orchid Bay Wellness Clinics Pte Ltd', 'Healthcare', 'SG', 'Singapore', 'Singapore', 'Asia/Singapore'],
  ['Quarry Lane Accounting', 'Quarry Lane Accounting LLP', 'Professional services', 'US', 'Colorado', 'Denver', 'America/Denver'],
  ['Brightwater Utilities', 'Brightwater Municipal Utilities', 'Utilities', 'US', 'Washington', 'Spokane', 'America/Los_Angeles'],
  ['Cobalt Freight Forwarding', 'Cobalt Freight Forwarding B.V.', 'Logistics', 'NL', 'North Holland', 'Amsterdam', 'Europe/Amsterdam'],
  ['Redwood Senior Living', 'Redwood Senior Living Communities Inc.', 'Healthcare', 'US', 'Arizona', 'Phoenix', 'America/Phoenix'],
  ['Ironbark Mining Services', 'Ironbark Mining Services Pty Ltd', 'Mining', 'AU', 'Western Australia', 'Perth', 'Australia/Perth'],
  ['Marigold Media Studio', 'Marigold Media Studio Ltd', 'Media', 'IE', 'Leinster', 'Dublin', 'Europe/Dublin'],
  ['Pinecrest Veterinary', 'Pinecrest Veterinary Hospital PLLC', 'Healthcare', 'US', 'North Carolina', 'Raleigh', 'America/New_York'],
  ['Atlas Precision Machining', 'Atlas Precision Machining Inc.', 'Manufacturing', 'US', 'Michigan', 'Grand Rapids', 'America/Detroit'],
  ['Seabright Property Management', 'Seabright Property Management LLC', 'Real estate', 'US', 'Florida', 'Tampa', 'America/New_York'],
  ['Juniper Community Alliance', 'Juniper Community Alliance', 'Nonprofit', 'US', 'Minnesota', 'Minneapolis', 'America/Chicago'],
  ['Vantage Point Engineering', 'Vantage Point Engineering Pvt Ltd', 'Architecture & engineering', 'IN', 'Karnataka', 'Bengaluru', 'Asia/Kolkata'],
  ['Wildflower Organic Foods', 'Wildflower Organic Foods Inc.', 'Food & beverage', 'US', 'Vermont', 'Burlington', 'America/New_York'],
];

// 26 primary PSA instances (weighted toward Autotask / ConnectWise, as in our customer base).
const PRIMARY_PROVIDERS = [
  'autotask', 'connectwise', 'autotask', 'halopsa', 'connectwise', 'autotask', 'connectwise', 'kaseya_bms', 'autotask',
  'connectwise', 'halopsa', 'autotask', 'freshservice', 'connectwise', 'autotask', 'servicenow', 'halopsa', 'autotask',
  'connectwise', 'custom_rest', 'autotask', 'connectwise', 'halopsa', 'kaseya_bms', 'connectwise', 'autotask',
] as const;
const SECONDARY: Record<number, string> = { 4: 'servicenow', 7: 'custom_rest', 15: 'halopsa' };

/** Provider-valid synthetic configuration. Tenant-specific hosts use the reserved .example TLD. */
function sampleConfig(provider: string, slug: string, country: string, rand: () => number): Record<string, unknown> {
  const europe = ['GB', 'IE', 'DE', 'NL'].includes(country);
  const apac = ['AU', 'SG', 'IN'].includes(country);
  switch (provider) {
    case 'autotask':
      return { zone: `webservices${1 + Math.floor(rand() * 24)}`, defaultQueueId: 29683000 + Math.floor(rand() * 400) };
    case 'connectwise':
      return { site: europe ? 'eu' : apac ? 'au' : 'na', companyId: slug.replace(/-/g, '').slice(0, 24), defaultBoard: 'Help Desk' };
    case 'halopsa':
      return { tenantUrl: `https://${slug}.halopsa.example`, scope: 'all' };
    case 'kaseya_bms':
      return { region: europe ? 'bmsemea.kaseya.com' : apac ? 'bmsapac.kaseya.com' : 'bms.kaseya.com', tenant: slug };
    case 'freshservice':
      return { domain: `${slug}.freshservice.example` };
    case 'servicenow':
      return { instanceUrl: `https://${slug}.service-now.example`, incidentTable: 'incident' };
    default:
      return { baseUrl: `https://psa.${slug}.example/api`, ticketsPath: '/tickets', apiKeyHeader: 'X-API-Key', pagination: 'page' };
  }
}

const LIFECYCLE_PLAN = [
  'verified', 'verified', 'verified', 'verified', 'enrolled', 'verified', 'verified', 'verified', 'package_downloaded',
  'verified', 'verified', 'verified', 'enrolled', 'verified', 'verified', 'verified', 'package_generated', 'verified',
  'verified', 'verified', 'enrolled', 'verified', 'draft', 'decommissioned', 'package_generated', 'verified', 'package_downloaded',
] as const;
const HEALTH_PLAN = ['healthy', 'healthy', 'degraded', 'healthy', 'healthy', 'critical', 'healthy', 'offline', 'healthy', 'healthy',
  'degraded', 'healthy', 'healthy', 'healthy', 'critical', 'healthy', 'offline', 'healthy', 'degraded', 'healthy', 'healthy'] as const;
const VERSION_PLAN = ['1.4.0', '1.4.0', '1.3.2', '1.4.0', '1.2.5', '1.3.2', '1.4.0', '1.1.0', '1.4.0', '1.3.2', '1.4.0',
  '1.2.5', '1.4.0', '1.3.2', '1.4.0', '1.1.0', '1.3.2', '1.4.0', '1.2.5', '1.3.2', '1.4.0'] as const;
const REASONS: Record<string, string[]> = {
  degraded: ['PSA connector worker not running', 'Disk usage 87% on data volume', '1 database migration pending'],
  critical: ['PostgreSQL unreachable for 6 minutes', 'edge-api health check failing'],
  offline: ['No heartbeat for 3 h 12 min', 'No heartbeat for 26 h'],
};
const ENVIRONMENTS = ['linux_docker', 'windows_docker', 'virtual_machine', 'client_server', 'cloud_vm', 'linux_docker'] as const;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const slugify = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface SeedResult {
  status: 'seeded' | 'skipped';
  organizationId: string;
  counts?: Record<string, number>;
}

export async function seed(ownerUrl: string, opts: { password: string; reset?: boolean; log?: (m: string) => void }): Promise<SeedResult> {
  const log = opts.log ?? console.log;
  const env = process.env.APP_ENV;
  if (env !== 'development' && env !== 'test') throw new Error(`Refusing to seed synthetic data when APP_ENV=${env ?? '(unset)'}.`);
  const rand = mulberry32(42);
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]!;
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'psacc-seed' });
  await client.connect();
  const q = (sql: string, params?: unknown[]) => client.query(sql, params);
  try {
    await q('BEGIN');
    const existing = await q('SELECT id FROM organizations WHERE slug = $1', [SEED_ORG_SLUG]);
    if (existing.rows[0] && !opts.reset) {
      await q('ROLLBACK');
      log('Synthetic organization already present — skipping (use --reset to rebuild it).');
      return { status: 'skipped', organizationId: existing.rows[0].id as string };
    }
    if (existing.rows[0]) {
      const orgId = existing.rows[0].id as string;
      await q(`SELECT set_config('app.org_id', $1, true), set_config('app.scope_all', 'on', true)`, [orgId]);
      // audit_events is append-only even for the owner (no DELETE policy under FORCE RLS). This dev-only
      // reset lifts FORCE inside this transaction; it is restored before COMMIT.
      await q('ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY');
      for (const t of ['audit_events', 'onboarding_drafts', 'retention_policies', 'remote_commands', 'deployment_reports', 'deployment_report_latest', 'deployment_heartbeats', 'deployment_tables', 'deployment_health_events', 'agent_certificates', 'deployment_package_downloads', 'enrollment_tokens', 'deployment_packages', 'deployments', 'licenses', 'psa_instance_services', 'psa_instances', 'client_services',
        'client_contacts', 'user_client_assignments', 'clients', 'services', 'service_categories', 'sessions', 'user_recovery_codes', 'user_roles', 'organization_sequences']) {
        await q(`DELETE FROM ${t} WHERE organization_id = $1`, [orgId]);
      }
      await q('UPDATE users SET created_by = NULL WHERE organization_id = $1', [orgId]);
      await q('DELETE FROM users WHERE organization_id = $1', [orgId]);
      await q('DELETE FROM organizations WHERE id = $1', [orgId]);
      await q('ALTER TABLE audit_events FORCE ROW LEVEL SECURITY');
      log('Removed previous synthetic organization.');
    }

    const org = await q(
      `INSERT INTO organizations (slug, name, is_synthetic) VALUES ($1, 'TechPio Operations (Development)', true) RETURNING id`,
      [SEED_ORG_SLUG],
    );
    const orgId = org.rows[0].id as string;
    await ensureDefaultServiceCatalog(client, orgId); // also sets the tenant context

    // Users ---------------------------------------------------------------
    const userIds: Record<string, string> = {};
    for (const u of SEED_USERS) {
      const hash = await hashPassword(opts.password);
      const r = await q(
        `INSERT INTO users (organization_id, email, display_name, password_hash, password_changed_at, timezone, is_synthetic)
         VALUES ($1, $2, $3, $4, now(), $5, true) RETURNING id`,
        [orgId, u.email, u.name, hash, u.timezone],
      );
      userIds[u.role] = r.rows[0].id as string;
      await q(
        `INSERT INTO user_roles (organization_id, user_id, role_id)
         SELECT $1, $2, id FROM roles WHERE key = $3 AND organization_id IS NULL`,
        [orgId, r.rows[0].id, u.role],
      );
    }

    // Clients -------------------------------------------------------------
    const now = Date.now();
    const clientRows: { id: string; slug: string; createdAt: number; status: string }[] = [];
    for (let i = 0; i < CLIENTS.length; i++) {
      const [display, legal, business, country, region, city, tz] = CLIENTS[i]!;
      const slug = slugify(display);
      // Spread onboarding over the last 12 months; the last three are inside the last 30 days.
      const ageDays = i >= CLIENTS.length - 3 ? 4 + (CLIENTS.length - 1 - i) * 9 : 360 - i * 14;
      const createdAt = now - ageDays * DAY - Math.floor(rand() * 8) * HOUR;
      const status = i === CLIENTS.length - 1 ? 'prospect' : i >= CLIENTS.length - 3 ? 'onboarding' : i === 9 ? 'suspended' : 'active';
      const serviceStatus = { prospect: 'not_started', onboarding: 'in_progress', suspended: 'paused', active: 'live' }[status]!;
      const start = new Date(createdAt);
      const end = new Date(createdAt + 3 * 365 * DAY);
      const r = await q(
        `INSERT INTO clients (organization_id, code, client_reference, legal_name, display_name, business_type, country_code,
           state_region, city, timezone, website, status, service_status, account_manager_user_id, technical_owner_user_id,
           onboarding_date, contract_start_date, contract_end_date, internal_notes, is_synthetic, created_at, updated_at)
         VALUES ($1, next_org_code('client', 'CL'), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date, $15::date, $16::date,
           'Synthetic development record.', true, $17, $17)
         RETURNING id`,
        [orgId, `ACCT-${1040 + i * 7}`, legal, display, business, country, region, city, tz, `https://www.${slug}.example`,
          status, serviceStatus, userIds.ops_admin, i % 2 ? userIds.tech_admin : userIds.technician,
          start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), new Date(createdAt)],
      );
      clientRows.push({ id: r.rows[0].id as string, slug, createdAt, status });
    }

    // Technician scope: four assigned clients.
    for (const idx of [0, 2, 5, 8]) {
      await q('INSERT INTO user_client_assignments (organization_id, user_id, client_id, assigned_by) VALUES ($1, $2, $3, $4)', [
        orgId, userIds.technician, clientRows[idx]!.id, userIds.ops_admin,
      ]);
    }

    // Contacts (primary + technical, billing for every third client) and services ------
    const services = await q(`SELECT id, key FROM services WHERE organization_id = $1`, [orgId]);
    const serviceId = Object.fromEntries(services.rows.map((r) => [r.key as string, r.id as string]));
    const optional = ['endpoint_management', 'patch_management', 'backup_management', 'microsoft_365', 'email_security', 'soc_mdr', 'network_management', 'security_awareness_training'];
    let contactCount = 0;
    for (let i = 0; i < clientRows.length; i++) {
      const c = clientRows[i]!;
      const people: [string, string[]][] = [
        [`${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, ['primary']],
        [`${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, i % 3 === 0 ? ['technical', 'escalation'] : ['technical']],
        ...(i % 3 === 0 ? ([[`${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, ['billing']]] as [string, string[]][]) : []),
      ];
      const used = new Set<string>();
      for (const [k, [name, roles]] of people.entries()) {
        let local = name.toLowerCase().replace(/[^a-z]+/g, '.');
        if (used.has(local)) local = `${local}${k + 1}`;
        used.add(local);
        await q(
          `INSERT INTO client_contacts (organization_id, client_id, full_name, job_title, email, phone, roles, is_synthetic)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
          [orgId, c.id, name, roles.includes('primary') ? 'Operations Director' : roles.includes('billing') ? 'Finance Manager' : 'IT Manager',
            `${local}@${c.slug}.example`, `+1 555 01${String((i * 3 + k) % 100).padStart(2, '0')}`, roles],
        );
        contactCount++;
      }
      if (c.status === 'prospect') continue;
      const chosen = ['help_desk', ...optional.filter((_, j) => (i + j) % 4 === 0).slice(0, 3)];
      for (const key of chosen) {
        // Values for the catalog's configuration requirements (non-secret); some clients leave optional ones unset.
        const config: Record<string, string | number> =
          key === 'help_desk' && i % 3 !== 2 ? { defaultPriority: ['low', 'medium', 'high'][i % 3]!, supportHours: i % 2 ? 'business' : '24x7' }
          : key === 'backup_management' ? { retentionDays: 30 + (i % 4) * 30 }
          : key === 'microsoft_365' ? { tenantDomain: `${c.slug}.onmicrosoft.example` }
          : {};
        await q('INSERT INTO client_services (organization_id, client_id, service_id, config, enabled_by) VALUES ($1, $2, $3, $4, $5)', [
          orgId, c.id, serviceId[key], JSON.stringify(config), userIds.ops_admin,
        ]);
      }
    }

    // PSA instances -------------------------------------------------------
    const psaByClient = new Map<string, string>();
    let psaCount = 0;
    // Configuration goes through the same provider adapters as user input, so seeded rows are valid.
    const adapters = new Map(psaAdapterProviders[0]!.useFactory().map((a) => [a.key as string, a]));
    const insertPsa = async (c: (typeof clientRows)[number], country: string, provider: string, label: string) => {
      const adapter = adapters.get(provider)!;
      const authMethod = adapter.descriptor.authMethods[0]!.key;
      const parsed = adapter.parseConfig(sampleConfig(provider, c.slug, country, rand), authMethod);
      if (!parsed.ok) throw new Error(`Seed config invalid for ${provider}: ${JSON.stringify(parsed.issues)}`);
      const r = await q(
        `INSERT INTO psa_instances (organization_id, client_id, code, provider_key, display_name, api_endpoint, auth_method,
           config, credential_status, connection_status, is_synthetic, created_at, updated_at)
         VALUES ($1, $2, next_org_code('psa_instance', 'PSA'), $3, $4, $5, $6, $7::jsonb, $8, 'untested', true, $9, $9)
         RETURNING id`,
        [orgId, c.id, provider, label, parsed.endpoint, authMethod, JSON.stringify(parsed.config),
          c.status === 'prospect' ? 'not_configured' : 'pending_appliance', new Date(c.createdAt + 2 * HOUR)],
      );
      psaCount++;
      return r.rows[0].id as string;
    };
    for (let i = 0; i < clientRows.length; i++) {
      const c = clientRows[i]!;
      const country = CLIENTS[i]![3];
      const primary = await insertPsa(c, country, PRIMARY_PROVIDERS[i]!, `${CLIENTS[i]![0]} — Production`);
      psaByClient.set(c.id, primary);
      if (SECONDARY[i]) await insertPsa(c, country, SECONDARY[i]!, `${CLIENTS[i]![0]} — ${SECONDARY[i] === 'servicenow' ? 'Corporate ITSM' : 'Secondary'}`);
      // Services that work through the PSA (Help Desk, SOC/MDR, …) are enabled on the primary instance.
      await q(
        `INSERT INTO psa_instance_services (organization_id, client_id, psa_instance_id, service_id, enabled_by)
         SELECT cs.organization_id, cs.client_id, $2, cs.service_id, cs.enabled_by
         FROM client_services cs JOIN services s ON s.id = cs.service_id AND s.requires_psa WHERE cs.client_id = $1`,
        [c.id, primary],
      );
    }

    // Licenses (Module 14): one per client that is past the prospect stage; a few expiring, one suspended.
    const licenseByClient = new Map<string, string>();
    const PLANS = ['Help Desk Standard', 'Help Desk Plus', 'Managed Services Core', 'Backup & Monitoring'];
    const nonProspects = clientRows.filter((c) => c.status !== 'prospect');
    for (let i = 0; i < nonProspects.length; i++) {
      const c = nonProspects[i]!;
      const start = new Date(now - (200 + Math.floor(rand() * 400)) * DAY);
      const endDays = i % 7 === 3 ? 12 : i % 7 === 5 ? 25 : i % 9 === 8 ? -4 : 180 + Math.floor(rand() * 500); // some expiring, one past its date
      const perpetual = i % 11 === 10;
      const status = c.status === 'suspended' ? 'suspended' : endDays < 0 ? 'expired' : 'active';
      const l = await q(
        `INSERT INTO licenses (organization_id, client_id, code, display_name, status, starts_at, ends_at, max_deployments, notes, suspended_at, suspended_reason, is_synthetic, created_at, updated_at)
         VALUES ($1, $2, next_org_code('license', 'LIC'), $3, $4, $5::date, $6::date, $7, 'Synthetic development record.', $8, $9, true, $10, $10)
         RETURNING id`,
        [orgId, c.id, PLANS[i % PLANS.length], status, start.toISOString().slice(0, 10), perpetual ? null : new Date(now + endDays * DAY).toISOString().slice(0, 10),
          i === 1 || i === 4 ? 3 : 1 + Math.floor(rand() * 2), status === 'suspended' ? new Date(now - 5 * DAY) : null, status === 'suspended' ? 'Client account suspended' : null, start],
      );
      licenseByClient.set(c.id, l.rows[0].id as string);
    }

    // Deployments + health timeline --------------------------------------
    const targets = clientRows.filter((c) => c.status !== 'prospect');
    targets.push(clientRows[1]!, clientRows[4]!); // two clients also run a second (staging) appliance
    let healthIdx = 0;
    let eventCount = 0;
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i]!;
      const lifecycle = LIFECYCLE_PLAN[i % LIFECYCLE_PLAN.length]!;
      const enrolled = lifecycle === 'enrolled' || lifecycle === 'verified';
      const health = enrolled ? HEALTH_PLAN[healthIdx % HEALTH_PLAN.length]! : 'unknown';
      const version = enrolled ? VERSION_PLAN[healthIdx % VERSION_PLAN.length]! : lifecycle === 'draft' ? null : '1.4.0';
      if (enrolled) healthIdx++;
      // After the client exists, and early enough that enrollment/verification are in the past.
      const createdAt = Math.max(c.createdAt + HOUR, Math.min(c.createdAt + (1 + Math.floor(rand() * 6)) * DAY, now - 3 * DAY));
      const generatedAt = lifecycle === 'draft' ? null : createdAt + HOUR;
      const downloadedAt = ['package_downloaded', 'enrolled', 'verified'].includes(lifecycle) ? createdAt + 3 * HOUR : null;
      const enrolledAt = enrolled ? createdAt + DAY : null;
      const verifiedAt = lifecycle === 'verified' ? createdAt + DAY + 2 * HOUR : null;
      const lastHeartbeat = !enrolled ? null : health === 'offline' ? now - (3 + Math.floor(rand() * 24)) * HOUR : now - (5 + Math.floor(rand() * 50)) * 1000;
      const reason = REASONS[health] ? pick(REASONS[health]!) : null;
      const env = pick(ENVIRONMENTS);
      const digest = version ? `sha256:${Array.from({ length: 64 }, () => Math.floor(rand() * 16).toString(16)).join('')}` : null;

      // Module 15: a decommissioned sample ran as a verified appliance for a while, then its identity was retired.
      const decommissioned = lifecycle === 'decommissioned';
      const decommissionedAt = decommissioned ? now - (10 + Math.floor(rand() * 20)) * DAY : null;
      const d = await q(
        `INSERT INTO deployments (organization_id, client_id, psa_instance_id, code, installation_id, target_environment, target_os,
           target_arch, lifecycle_state, health_state, health_reason, image_version, image_digest, agent_version, last_heartbeat_at,
           package_generated_at, package_downloaded_at, enrolled_at, verified_at, is_synthetic, created_at, updated_at, license_id,
           decommissioned_at, decommissioned_reason, decommissioned_from_state, decommission_identity)
         VALUES ($1, $2, $3, next_org_code('deployment', 'DEP'), $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $13, $14, $15, $16, $17, true, $18, $18, $19, $20, $21, $22, $23)
         RETURNING id`,
        [orgId, c.id, psaByClient.get(c.id), enrolled || decommissioned ? crypto.randomUUID() : null, env,
          env === 'windows_docker' ? 'windows' : 'linux', rand() < 0.85 ? 'amd64' : 'arm64', lifecycle, decommissioned ? 'unknown' : health, decommissioned ? 'Decommissioned' : reason,
          decommissioned ? '1.4.0' : version, decommissioned ? `sha256:${'0'.repeat(64)}` : digest,
          decommissioned ? new Date(decommissionedAt! - HOUR) : lastHeartbeat ? new Date(lastHeartbeat) : null, decommissioned ? new Date(createdAt + HOUR) : generatedAt ? new Date(generatedAt) : null,
          decommissioned ? new Date(createdAt + 3 * HOUR) : downloadedAt ? new Date(downloadedAt) : null, decommissioned ? new Date(createdAt + DAY) : enrolledAt ? new Date(enrolledAt) : null,
          decommissioned ? new Date(createdAt + DAY + 2 * HOUR) : verifiedAt ? new Date(verifiedAt) : null, new Date(createdAt), licenseByClient.get(c.id) ?? null,
          decommissionedAt ? new Date(decommissionedAt) : null, decommissioned ? 'Site closed; contract ended' : null, decommissioned ? 'verified' : null,
          decommissioned ? JSON.stringify({ certificatesRevoked: 1, tokensRevoked: 0, packagesRevoked: 0, commandsCancelled: 0 }) : null],
      );
      if (!enrolledAt) continue;
      const depId = d.rows[0].id as string;
      // Timeline: healthy from enrollment, occasional short incidents, ending in the current state.
      const events: [string, number, string | null][] = [['healthy', enrolledAt, 'First heartbeat received']];
      for (let t = enrolledAt + DAY; t < now - 2 * DAY; t += DAY) {
        if (rand() < 0.08) {
          const s = rand() < 0.7 ? 'degraded' : 'critical';
          events.push([s, t + Math.floor(rand() * 12) * HOUR, pick(REASONS[s]!)]);
          events.push(['healthy', t + 14 * HOUR, 'Recovered']);
        }
      }
      const finalAt = health === 'offline' ? lastHeartbeat! + 90_000 : health === 'healthy' ? now - DAY : now - (6 + Math.floor(rand() * 30)) * HOUR;
      events.push([health, Math.max(finalAt, enrolledAt + 60_000), reason]);
      for (const [state, at, why] of events) {
        await q(
          `INSERT INTO deployment_health_events (organization_id, client_id, deployment_id, health_state, reason, source, observed_at)
           VALUES ($1, $2, $3, $4, $5, 'synthetic', $6)`,
          [orgId, c.id, depId, state, why, new Date(at)],
        );
        eventCount++;
      }
    }

    await q(
      `INSERT INTO audit_events (organization_id, actor_type, actor_display, action, outcome, metadata)
       VALUES ($1, 'system', 'seed', 'system.seed.applied', 'success', $2)`,
      [orgId, JSON.stringify({ synthetic: true, users: SEED_USERS.length, clients: clientRows.length })],
    );
    await q('COMMIT');
    const counts = { users: SEED_USERS.length, clients: clientRows.length, contacts: contactCount, psaInstances: psaCount, deployments: targets.length, healthEvents: eventCount };
    log(`Seeded synthetic organization: ${JSON.stringify(counts)}`);
    return { status: 'seeded', organizationId: orgId, counts };
  } catch (err) {
    await q('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
