import type { AuditEventDto, DeploymentHealthDto, Paged } from '@psacc/contracts';
import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import { PendingReports } from '@/components/deployments/pending-reports';
import { RefreshButton } from '@/components/refresh-button';
import { Badge, HealthPill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { getDeployment } from '@/lib/deployments';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Deployment logs' };

/**
 * Installation and agent events known to the Control Plane. Raw integration logs stay on the
 * appliance; only sanitized errors (codes, redacted messages) and counts are reported.
 */
export default async function DeploymentLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const d = await getDeployment(id);
  const tz = me.user.timezone;
  if (d.isSynthetic) {
    return <PendingReports title="Logs" icon={<ScrollText />} module={8} reason="This is a synthetic sample record; no appliance reports for it exist." items={['Agent and installation events', 'Sanitized integration errors reported by the agent', 'Health state changes']} />;
  }
  const [activity, health] = await Promise.all([
    apiGet<Paged<AuditEventDto>>(`/deployments/${id}/activity?pageSize=50`),
    can(me, 'health.read') ? apiGet<DeploymentHealthDto>(`/deployments/${id}/health`) : Promise.resolve(null),
  ]);
  const errors = health?.ok ? (health.data.latest.synchronization?.payload.recentErrors ?? []) : [];
  const sync = health?.ok ? health.data.latest.synchronization : undefined;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Agent errors" icon={<ScrollText />} description={sync ? `Reported ${formatDateTime(sync.observedAt, tz, { seconds: true })} · ${sync.payload.errorsLast24h} error(s) in the last 24 h on the appliance. Raw logs stay on the client's host.` : 'No synchronization report received yet; raw logs stay on the client’s host.'} actions={<RefreshButton />} />
        <CardBody className="pt-1">
          {errors.length ? (
            <ul className="divide-y divide-slate-100 text-[13px]">
              {errors.map((e, i) => (
                <li key={`${e.at}-${i}`} className="py-2">
                  <span className="text-slate-500">{formatDateTime(e.at, tz, { seconds: true })} · <span className="font-mono">{e.component}</span>{e.code ? ` · ${e.code}` : ''}{e.httpStatus ? ` · HTTP ${e.httpStatus}` : ''}</span>
                  <span className="block text-slate-800">{e.message}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-500">No errors reported by the agent.</p>}
        </CardBody>
      </Card>

      {health?.ok ? (
        <Card>
          <CardHeader title="Health state changes" description="Newest first, last 30 days." />
          <CardBody className="pt-1">
            {health.data.events.length ? (
              <ul className="divide-y divide-slate-100 text-[13px]">
                {health.data.events.map((e, i) => (
                  <li key={`${e.observedAt}-${i}`} className="flex flex-wrap items-center gap-2 py-2"><HealthPill state={e.healthState} /><span className="text-slate-500">{formatDateTime(e.observedAt, tz, { seconds: true })} · {e.source}</span>{e.reason ? <span className="text-slate-700">{e.reason}</span> : null}</li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No state changes yet.</p>}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Installation and agent events" description="Audit events for this deployment: packages, enrollment, certificates, rejected reports." />
        <CardBody className="pt-1">
          {activity.ok ? (
            activity.data.items.length ? (
              <ul className="divide-y divide-slate-100 text-[13px]">
                {activity.data.items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                    <span><span className="font-mono text-[12.5px] text-slate-900">{e.action}</span> <Badge tone={e.outcome === 'success' ? 'emerald' : e.outcome === 'denied' ? 'red' : 'amber'}>{e.outcome}</Badge>{typeof e.metadata.reason === 'string' ? <span className="ml-2 text-slate-500">{e.metadata.reason}</span> : null}</span>
                    <span className="text-slate-500">{e.actorDisplay} · {formatDateTime(e.occurredAt, tz, { seconds: true })}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No events yet.</p>
          ) : <ErrorState problem={activity.problem} />}
        </CardBody>
      </Card>
    </div>
  );
}
