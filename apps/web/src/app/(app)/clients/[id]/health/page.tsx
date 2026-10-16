import type { ClientHealthDto } from '@psacc/contracts';
import { HeartPulse } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RefreshButton } from '@/components/refresh-button';
import { Alert } from '@/components/ui/alert';
import { HealthPill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';
import { HEALTH_ORDER } from '@/lib/health';

export const metadata: Metadata = { title: 'Client health' };

export default async function ClientHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'health.read')) notFound();
  const { id } = await params;
  const h = await apiGet<ClientHealthDto>(`/clients/${id}/health`);
  if (!h.ok) return <Card><ErrorState problem={h.problem} /></Card>;
  const tz = me.user.timezone;
  const synthetic = h.data.deployments.some((d) => d.isSynthetic) || h.data.events.some((e) => e.source === 'synthetic');
  return (
    <div className="space-y-4">
      {synthetic ? <Alert variant="synthetic" title="Synthetic health data">Health states and events below come from development sample data, not from installed agents.</Alert> : null}
      <Card>
        <CardHeader title="Health summary" description="Current evaluated state of each deployment. Live deployments are evaluated from agent reports; open a deployment for its health page." actions={<RefreshButton />} />
        <CardBody>
          {h.data.deployments.length === 0 ? (
            <EmptyState icon={<HeartPulse />} title="No deployments to report on" />
          ) : (
            <>
              <ul className="flex flex-wrap gap-3" aria-label="Deployments by health state">
                {HEALTH_ORDER.filter((s) => h.data.summary[s] > 0).map((s) => (
                  <li key={s} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
                    <HealthPill state={s} /><span className="tnum text-sm font-semibold text-slate-900">{h.data.summary[s]}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {h.data.deployments.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <span className="font-mono text-sm font-semibold text-slate-900">{d.code}</span>
                    <span className="flex flex-wrap items-center gap-3 text-[13px] text-slate-500">{d.healthReason}<HealthPill state={d.healthState} /></span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Health events" description={`Last 30 days · ${tz}`} />
        <CardBody>
          {h.data.events.length === 0 ? (
            <p className="text-sm text-slate-500">No health events recorded in the last 30 days.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-slate-200 pl-5">
              {h.data.events.map((e, i) => (
                <li key={`${e.deploymentCode}-${e.observedAt}-${i}`} className="relative">
                  <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full bg-white ring-2 ring-slate-300" aria-hidden="true" />
                  <div className="flex flex-wrap items-center gap-2">
                    <HealthPill state={e.healthState} />
                    <span className="font-mono text-[13px] font-semibold text-slate-800">{e.deploymentCode}</span>
                    <span className="text-[12.5px] text-slate-500">{formatDateTime(e.observedAt, tz)} · source: {e.source}</span>
                  </div>
                  {e.reason ? <p className="mt-1 text-[13px] text-slate-600">{e.reason}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
