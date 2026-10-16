import type { RetentionPolicyDto } from '@psacc/contracts';
import { Archive } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';
import { RetentionForm } from './retention-form';

export const metadata: Metadata = { title: 'Data retention' };

export default async function RetentionPage() {
  const me = await requireActiveSession();
  if (!can(me, 'settings.manage')) notFound();
  const r = await apiGet<RetentionPolicyDto>('/settings/retention');
  const tz = me.user.timezone;
  return (
    <>
      <PageHeader title="Data retention" description="How long the Control Plane keeps the operational metadata of decommissioned deployments (Module 15). Nothing here touches a client’s host: appliance data is removed only by the host operator with the uninstall script." />
      {r.ok ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3" data-testid="retention-stats">
            {[
              ['Decommissioned deployments', r.data.stats.decommissioned, 'records kept with their identity history and audit trail'],
              ['Awaiting purge', r.data.stats.awaitingPurge, r.data.stats.nextPurgeAt ? `next purge due ${formatDateTime(r.data.stats.nextPurgeAt, tz)}` : 'nothing scheduled'],
              ['Purged', r.data.stats.purged, 'metadata deleted; records and audit trail retained'],
            ].map(([label, n, hint]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <p className="text-[12.5px] font-medium text-slate-500">{label}</p>
                <p className="text-2xl font-semibold tabular-nums text-slate-900">{n}</p>
                <p className="text-[12px] text-slate-500">{hint}</p>
              </div>
            ))}
          </div>
          <Card>
            <CardHeader title="Retention policy" icon={<Archive />} description={r.data.updatedAt ? `Last changed ${formatDateTime(r.data.updatedAt, tz)}${r.data.updatedBy ? ` by ${r.data.updatedBy}` : ''}.` : 'Default policy; not changed yet.'} />
            <CardBody className="pt-1"><RetentionForm initial={r.data} /></CardBody>
          </Card>
        </div>
      ) : <ErrorState problem={r.problem} />}
    </>
  );
}
