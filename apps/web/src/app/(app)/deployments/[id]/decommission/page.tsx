import { Archive } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DecommissionForm } from '@/components/deployments/decommission';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { can, requireActiveSession } from '@/lib/api-server';
import { getDeployment } from '@/lib/deployments';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Decommission deployment' };

/** Module 15 — a full page (no dialog) for the final lifecycle step of a deployment. */
export default async function DecommissionPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'deployments.decommission')) notFound();
  const { id } = await params;
  const d = await getDeployment(id);
  const tz = me.user.timezone;

  if (d.isSynthetic) return <Alert variant="synthetic" title="Synthetic sample record">Development sample data cannot be decommissioned.</Alert>;
  if (d.lifecycleState === 'decommissioned' && d.decommission) {
    return (
      <Alert variant="info" title={`${d.code} is already decommissioned`}>
        Since {formatDateTime(d.decommission.at, tz)}{d.decommission.by ? ` by ${d.decommission.by}` : ''}: {d.decommission.reason}. The removal instructions and the removal of this record are on the Overview page.
      </Alert>
    );
  }
  const mono = (v: string | null | undefined) => (v ? <span className="break-all font-mono text-[12.5px]">{v}</span> : '—');
  return (
    <div className="max-w-5xl space-y-4">
      <Card>
        <CardHeader title={`Decommission ${d.code}`} icon={<Archive />} description="Final. Retires this deployment’s management identity on the Control Plane and tells the appliance; nothing on the client’s host is deleted remotely. Suspension (reversible) is on the Overview page if the deployment may come back." />
        <CardBody className="pt-1">
          <DetailRows rows={[
            ['Client', `${d.client.displayName} (${d.client.code})`],
            ['Current lifecycle', d.lifecycleState === 'suspended' && d.suspension ? `Suspended (was ${d.suspension.fromState.replace(/_/g, ' ')})` : d.lifecycleState.replace(/_/g, ' ')],
            ['Installation ID', mono(d.installationId)],
            ['License', d.licenseDetail ? `${d.licenseDetail.code} · ${d.licenseDetail.displayName} (its slot is freed)` : 'none'],
            ['Last heartbeat', d.lastHeartbeatAt ? formatDateTime(d.lastHeartbeatAt, tz) : 'never'],
            ['Active certificate', mono(d.agentCertificates.find((c) => c.status === 'active')?.serial ?? null)],
            ['Usable package', d.currentPackage ? `#${d.currentPackage.number} (will be revoked)` : 'none'],
          ]} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Confirm" description="Give the reason for the audit log and type the deployment ID. There is no undo: a decommissioned deployment cannot be resumed; a new deployment with a new identity would be needed." />
        <CardBody className="pt-1">
          <DecommissionForm d={d} />
        </CardBody>
      </Card>
    </div>
  );
}
