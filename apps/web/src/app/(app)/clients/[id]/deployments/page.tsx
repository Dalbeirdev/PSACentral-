import type { ClientDeploymentDto } from '@psacc/contracts';
import { Plus, Rocket } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HealthPill, LifecycleStage, SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, relativeTime } from '@/lib/format';
import { ENVIRONMENT_LABEL } from '@/lib/reference';

export const metadata: Metadata = { title: 'Client deployments' };

export default async function ClientDeploymentsPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'deployments.read')) notFound();
  const { id } = await params;
  const list = await apiGet<ClientDeploymentDto[]>(`/clients/${id}/deployments`);
  const tz = me.user.timezone;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Deployments"
        description="One PSA Edge appliance per deployment, each in the client’s own Docker environment with its own database."
        className="pb-4"
        actions={can(me, 'deployments.write') ? <ButtonLink href={`/deployments/new?clientId=${id}`} variant="secondary" size="sm"><Plus /> New deployment</ButtonLink> : null}
      />
      {!list.ok ? (
        <ErrorState problem={list.problem} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={<Rocket />} title="No deployments" />
      ) : (
        <Table>
          <thead>
            <tr><Th>Deployment</Th><Th>Target</Th><Th>Lifecycle</Th><Th>Health</Th><Th>Image</Th><Th>Last heartbeat</Th></tr>
          </thead>
          <tbody>
            {list.data.map((d) => (
              <Tr key={d.id}>
                <Td>
                  <Link href={`/deployments/${d.id}`} className="font-mono text-[13px] font-semibold text-blue-700 hover:underline">{d.code}</Link>
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-500">{d.hostLabel ?? (d.psaInstanceCode ? `PSA ${d.psaInstanceCode}` : '')}{d.isSynthetic ? <SyntheticBadge /> : null}</span>
                </Td>
                <Td className="text-[13px]">{ENVIRONMENT_LABEL[d.targetEnvironment] ?? d.targetEnvironment}<span className="block font-mono text-[12px] text-slate-500">{[d.targetOs, d.targetArch].filter(Boolean).join(' / ')}</span></Td>
                <Td><LifecycleStage state={d.lifecycleState} /></Td>
                <Td><HealthPill state={d.healthState} />{d.healthReason ? <span className="mt-1 block max-w-56 text-[12px] text-slate-500">{d.healthReason}</span> : null}</Td>
                <Td className="font-mono text-[12.5px]">{d.imageVersion ?? '—'}</Td>
                <Td className="text-[13px] text-slate-600">
                  {d.isSynthetic ? <span className="italic text-slate-500">Synthetic — not live</span> : d.lastHeartbeatAt ? <span title={formatDateTime(d.lastHeartbeatAt, tz)}>{relativeTime(d.lastHeartbeatAt)}</span> : 'Never'}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
