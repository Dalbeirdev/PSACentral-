import { LIFECYCLE_LABELS } from '@psacc/contracts';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { HealthPill, LifecycleStage, SyntheticBadge } from '@/components/ui/badge';
import { Breadcrumbs } from '@/components/ui/page-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import { can, requireActiveSession } from '@/lib/api-server';
import { getDeployment } from '@/lib/deployments';
import { ENVIRONMENT_LABEL } from '@/lib/reference';

export default async function DeploymentLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'deployments.read')) notFound();
  const { id } = await params;
  const d = await getDeployment(id);
  const base = `/deployments/${id}`;
  const tabs = [
    { href: base, label: 'Overview', exact: true },
    { href: `${base}/installation`, label: 'Installation' },
    ...(can(me, 'health.read') ? [{ href: `${base}/health`, label: 'Health' }] : []),
    ...(can(me, 'database.metadata.read') ? [{ href: `${base}/database`, label: 'Database' }] : []),
    { href: `${base}/logs`, label: 'Logs' },
    { href: `${base}/operations`, label: 'Operations' },
    ...(can(me, 'deployments.write') ? [{ href: `${base}/settings`, label: 'Settings' }] : []),
  ];
  return (
    <>
      <Breadcrumbs items={[{ label: 'Deployments', href: '/deployments' }, { label: d.client.displayName, href: `/clients/${d.client.id}/deployments` }, { label: d.code }]} className="mb-3" />
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] sm:leading-9">{d.code}</h1>
            {d.isSynthetic ? <SyntheticBadge /> : null}
          </div>
          <p className="mt-1.5 text-sm text-slate-500">
            {d.client.displayName} ({d.client.code}) · {d.psaInstance ? `${d.psaInstance.providerName} ${d.psaInstance.code}` : 'No PSA instance'} · {ENVIRONMENT_LABEL[d.targetEnvironment] ?? d.targetEnvironment}
            {d.hostLabel ? ` · ${d.hostLabel}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-lg bg-white px-2.5 py-1 ring-1 ring-slate-200" aria-label={`Lifecycle: ${LIFECYCLE_LABELS[d.lifecycleState]}`}>
              <LifecycleStage state={d.lifecycleState} />
            </span>
            <HealthPill state={d.healthState} />
          </div>
        </div>
      </div>
      <SectionTabs tabs={tabs} label="Deployment sections" />
      {children}
    </>
  );
}
