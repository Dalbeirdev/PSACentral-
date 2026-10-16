import { Inject, Injectable } from '@nestjs/common';
import {
  type DashboardSummary,
  type DeploymentLifecycleState,
  HEALTH_STATES,
  type HealthState,
  type NotificationItem,
  type NotificationsResponse,
  type PsaProviderKey,
  type SearchResponse,
  type SearchResult,
} from '@psacc/contracts';
import type { AuthContext } from '../../common/auth-context.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { escapeLike } from '../audit/audit.service.js';

/**
 * Read models for the overview. Every query runs inside the caller's tenant transaction,
 * so row-level security restricts results to the organization and the user's client scope.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  private async userTimezone(q: Queryable, userId: string): Promise<string> {
    return (await q.one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [userId])).timezone;
  }

  async summary(auth: AuthContext): Promise<DashboardSummary> {
    return this.db.tenant(auth, async (q) => {
      const tz = await this.userTimezone(q, auth.userId);
      const k = await q.one<Record<string, number | string | null>>(`
        SELECT
          (SELECT count(*)::int FROM clients) AS total_clients,
          (SELECT count(*)::int FROM clients WHERE created_at >= now() - interval '30 days') AS new_clients,
          (SELECT count(*)::int FROM psa_instances) AS total_psa,
          (SELECT count(DISTINCT provider_key)::int FROM psa_instances) AS providers_in_use,
          (SELECT count(*)::int FROM deployments WHERE lifecycle_state <> 'decommissioned') AS total_deployments,
          (SELECT count(*)::int FROM deployments
             WHERE lifecycle_state IN ('enrolled', 'verified') AND health_state NOT IN ('offline', 'unknown')) AS active,
          (SELECT count(*)::int FROM deployments WHERE health_state = 'offline') AS offline,
          (SELECT count(*)::int FROM deployments WHERE health_state = 'healthy') AS healthy,
          (SELECT count(*)::int FROM deployments WHERE health_state = 'critical') AS critical,
          (SELECT count(DISTINCT image_version)::int FROM deployments
             WHERE image_version IS NOT NULL AND lifecycle_state IN ('enrolled', 'verified')) AS versions,
          (SELECT image_version FROM deployments WHERE image_version IS NOT NULL
             ORDER BY string_to_array(split_part(split_part(image_version, '-', 1), '+', 1), '.')::int[] DESC LIMIT 1) AS latest,
          (SELECT count(*)::int FROM deployments WHERE created_at >= now() - interval '30 days') AS recent,
          (SELECT (SELECT count(*) FILTER (WHERE is_synthetic) FROM clients)
                + (SELECT count(*) FILTER (WHERE is_synthetic) FROM psa_instances)
                + (SELECT count(*) FILTER (WHERE is_synthetic) FROM deployments))::int AS synthetic,
          (SELECT (SELECT count(*) FILTER (WHERE NOT is_synthetic) FROM clients)
                + (SELECT count(*) FILTER (WHERE NOT is_synthetic) FROM psa_instances)
                + (SELECT count(*) FILTER (WHERE NOT is_synthetic) FROM deployments))::int AS live
      `);

      const health = await q.query<{ state: HealthState; count: number }>(
        `SELECT health_state AS state, count(*)::int AS count FROM deployments
         WHERE lifecycle_state <> 'decommissioned' GROUP BY health_state`,
      );
      const providers = await q.query<{ provider: PsaProviderKey; name: string; count: number }>(
        `SELECT p.key AS provider, p.name, count(i.id)::int AS count
         FROM psa_instances i JOIN psa_providers p ON p.key = i.provider_key
         GROUP BY p.key, p.name, p.sort_order ORDER BY count DESC, p.sort_order`,
      );
      const onboarding = await q.query<{ month: string; count: number }>(
        `WITH months AS (
           SELECT generate_series(date_trunc('month', now() AT TIME ZONE $1) - interval '11 months',
                                  date_trunc('month', now() AT TIME ZONE $1), interval '1 month') AS m)
         SELECT to_char(m, 'YYYY-MM') AS month,
                (SELECT count(*)::int FROM clients c
                   WHERE date_trunc('month', coalesce(c.onboarding_date::timestamp, c.created_at AT TIME ZONE $1)) = months.m) AS count
         FROM months ORDER BY m`,
        [tz],
      );
      const versions = await q.query<{ version: string; count: number }>(
        `SELECT image_version AS version, count(*)::int AS count FROM deployments
         WHERE image_version IS NOT NULL AND lifecycle_state IN ('enrolled', 'verified')
         GROUP BY image_version
         ORDER BY string_to_array(split_part(split_part(image_version, '-', 1), '+', 1), '.')::int[]`,
      );
      // End-of-day state per deployment for the last 30 local days (user's time zone).
      const timeline = await q.query<{ day: string; state: HealthState | null; count: number }>(
        `WITH days AS (
           SELECT d::date AS day
           FROM generate_series((now() AT TIME ZONE $1)::date - 29, (now() AT TIME ZONE $1)::date, interval '1 day') d),
         states AS (
           SELECT days.day, s.state
           FROM days
           CROSS JOIN deployments dep
           CROSS JOIN LATERAL (
             SELECT e.health_state AS state FROM deployment_health_events e
             WHERE e.deployment_id = dep.id AND e.observed_at < ((days.day + 1)::timestamp AT TIME ZONE $1)
             ORDER BY e.observed_at DESC LIMIT 1) s)
         SELECT to_char(days.day, 'YYYY-MM-DD') AS day, states.state, count(states.state)::int AS count
         FROM days LEFT JOIN states ON states.day = days.day
         GROUP BY days.day, states.state ORDER BY days.day`,
        [tz],
      );
      const recent = await q.query<Record<string, unknown>>(
        `SELECT d.id, d.code, d.client_id, c.display_name AS client_name, p.key AS provider, p.name AS provider_name,
                d.image_version, d.lifecycle_state, d.health_state, d.last_heartbeat_at, d.created_at, d.is_synthetic
         FROM deployments d
         JOIN clients c ON c.id = d.client_id
         LEFT JOIN psa_instances i ON i.id = d.psa_instance_id
         LEFT JOIN psa_providers p ON p.key = i.provider_key
         ORDER BY d.created_at DESC LIMIT 8`,
      );

      const days = buildDays(timeline);
      const synthetic = Number(k.synthetic);
      const live = Number(k.live);
      return {
        generatedAt: new Date().toISOString(),
        provenance: { syntheticRecords: synthetic, liveRecords: live, containsSynthetic: synthetic > 0 },
        kpis: {
          totalClients: Number(k.total_clients),
          newClientsLast30Days: Number(k.new_clients),
          totalPsaInstances: Number(k.total_psa),
          psaProvidersInUse: Number(k.providers_in_use),
          totalDeployments: Number(k.total_deployments),
          activeDeployments: Number(k.active),
          offlineDeployments: Number(k.offline),
          healthyInstallations: Number(k.healthy),
          criticalAlerts: Number(k.critical),
          dockerVersionsInUse: Number(k.versions),
          latestImageVersion: (k.latest as string | null) ?? null,
          recentDeploymentsLast30Days: Number(k.recent),
        },
        healthDistribution: HEALTH_STATES.map((state) => ({ state, count: health.find((h) => h.state === state)?.count ?? 0 })),
        psaProviderDistribution: providers,
        onboardingTrend: onboarding,
        versionDistribution: versions,
        statusOverTime: days,
        recentDeployments: recent.map((r) => ({
          id: r.id as string,
          code: r.code as string,
          clientId: r.client_id as string,
          clientName: r.client_name as string,
          psaProvider: (r.provider as PsaProviderKey | null) ?? null,
          psaProviderName: (r.provider_name as string | null) ?? null,
          imageVersion: (r.image_version as string | null) ?? null,
          lifecycleState: r.lifecycle_state as DeploymentLifecycleState,
          healthState: r.health_state as HealthState,
          lastHeartbeatAt: (r.last_heartbeat_at as Date | null)?.toISOString() ?? null,
          createdAt: (r.created_at as Date).toISOString(),
          isSynthetic: r.is_synthetic as boolean,
        })),
      };
    });
  }

  async search(auth: AuthContext, raw: string): Promise<SearchResponse> {
    const query = raw.trim().slice(0, 100);
    if (query.length < 2) return { query, results: [] };
    const like = `%${escapeLike(query)}%`;
    return this.db.tenant(auth, async (q) => {
      const results: SearchResult[] = [];
      if (auth.permissions.has('clients.read')) {
        const rows = await q.query<Record<string, unknown>>(
          `SELECT id, code, display_name, legal_name, client_reference, status, is_synthetic FROM clients
           WHERE display_name ILIKE $1 OR legal_name ILIKE $1 OR client_reference ILIKE $1 OR code ILIKE $1
           ORDER BY similarity(display_name, $2) DESC, display_name LIMIT 8`,
          [like, query],
        );
        for (const r of rows) {
          results.push({
            type: 'client', id: r.id as string, title: r.display_name as string,
            subtitle: `${r.code as string} · ${r.legal_name as string} · ref ${r.client_reference as string}`,
            href: `/clients/${r.id as string}`, isSynthetic: r.is_synthetic as boolean,
          });
        }
      }
      if (auth.permissions.has('deployments.read')) {
        const rows = await q.query<Record<string, unknown>>(
          `SELECT d.id, d.code, d.health_state, d.lifecycle_state, c.display_name, d.is_synthetic FROM deployments d
           JOIN clients c ON c.id = d.client_id
           WHERE d.code ILIKE $1 OR c.display_name ILIKE $1 ORDER BY d.code LIMIT 8`,
          [like],
        );
        for (const r of rows) {
          results.push({
            type: 'deployment', id: r.id as string, title: r.code as string,
            subtitle: `${r.display_name as string} · ${(r.lifecycle_state as string).replace(/_/g, ' ')} · ${r.health_state as string}`,
            href: `/deployments/${r.id as string}`, isSynthetic: r.is_synthetic as boolean,
          });
        }
      }
      if (auth.permissions.has('psa.read')) {
        const rows = await q.query<Record<string, unknown>>(
          `SELECT i.id, i.code, i.display_name, p.name AS provider, c.display_name AS client, i.is_synthetic
           FROM psa_instances i JOIN psa_providers p ON p.key = i.provider_key JOIN clients c ON c.id = i.client_id
           WHERE i.code ILIKE $1 OR i.display_name ILIKE $1 ORDER BY i.code LIMIT 8`,
          [like],
        );
        for (const r of rows) {
          results.push({
            type: 'psa_instance', id: r.id as string, title: `${r.code as string} · ${r.display_name as string}`,
            subtitle: `${r.provider as string} · ${r.client as string}`, href: `/psa/${r.id as string}`,
            isSynthetic: r.is_synthetic as boolean,
          });
        }
      }
      return { query, results };
    });
  }

  async notifications(auth: AuthContext): Promise<NotificationsResponse> {
    return this.db.tenant(auth, async (q) => {
      const items: NotificationItem[] = [];
      const me = await q.one<{ mfa_enabled: boolean; must_change_password: boolean }>(
        'SELECT mfa_enabled, must_change_password FROM users WHERE id = $1',
        [auth.userId],
      );
      if (!me.mfa_enabled) {
        items.push({
          id: 'account-mfa', severity: 'warning', title: 'Multi-factor authentication is not enabled',
          detail: 'Protect your account with an authenticator app.', occurredAt: null, href: '/settings/security', isSynthetic: false,
        });
      }
      if (auth.permissions.has('health.read')) {
        const rows = await q.query<Record<string, unknown>>(
          `SELECT d.id, d.code, d.health_state, d.health_reason, d.last_heartbeat_at, d.updated_at, c.display_name, d.is_synthetic
           FROM deployments d JOIN clients c ON c.id = d.client_id
           WHERE d.health_state IN ('critical', 'offline', 'degraded')
           ORDER BY CASE d.health_state WHEN 'critical' THEN 0 WHEN 'offline' THEN 1 ELSE 2 END, d.updated_at DESC
           LIMIT 50`,
        );
        for (const r of rows) {
          const state = r.health_state as string;
          items.push({
            id: `deployment-${r.id as string}`,
            severity: state === 'degraded' ? 'warning' : 'critical',
            title: `${r.code as string} is ${state}`,
            detail: `${r.display_name as string}${r.health_reason ? ` — ${r.health_reason as string}` : ''}`,
            occurredAt: ((r.last_heartbeat_at ?? r.updated_at) as Date).toISOString(),
            href: `/deployments/${r.id as string}`,
            isSynthetic: r.is_synthetic as boolean,
          });
        }
      }
      return {
        items,
        counts: {
          critical: items.filter((i) => i.severity === 'critical').length,
          warning: items.filter((i) => i.severity === 'warning').length,
          info: items.filter((i) => i.severity === 'info').length,
        },
      };
    });
  }
}

/** Pivots (day, state, count) rows into one record per day with every state present (zero-filled). */
export function buildDays(rows: { day: string; state: HealthState | null; count: number }[]): DashboardSummary['statusOverTime'] {
  const byDay = new Map<string, Record<HealthState, number>>();
  for (const r of rows) {
    const rec = byDay.get(r.day) ?? { healthy: 0, degraded: 0, critical: 0, offline: 0, unknown: 0 };
    if (r.state) rec[r.state] = r.count;
    byDay.set(r.day, rec);
  }
  return [...byDay.keys()].sort().map((date) => ({ date, ...byDay.get(date)! }));
}
