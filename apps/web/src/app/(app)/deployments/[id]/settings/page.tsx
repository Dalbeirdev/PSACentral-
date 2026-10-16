import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DeploymentForm } from '@/components/deployments/deployment-form';
import { Alert } from '@/components/ui/alert';
import { can, requireActiveSession } from '@/lib/api-server';
import { getDeployment } from '@/lib/deployments';

export const metadata: Metadata = { title: 'Deployment settings' };

export default async function DeploymentSettings({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'deployments.write')) notFound();
  const { id } = await params;
  const d = await getDeployment(id);

  if (d.isSynthetic) return <Alert variant="synthetic" title="Synthetic sample record">Development sample data cannot be changed.</Alert>;
  if (d.lifecycleState !== 'draft') {
    return (
      <Alert variant="info" title="Settings are locked" className="max-w-3xl">
        {['enrolled', 'verified', 'suspended', 'decommissioned'].includes(d.lifecycleState)
          ? 'The appliance has enrolled, so its PSA instance and platform are fixed for this deployment.'
          : <>A package exists, and it was built from the current settings. To change them, <Link href={`/deployments/${id}/installation`} className="font-semibold underline">revoke the package</Link> first; then generate a new one.</>}
      </Alert>
    );
  }
  return (
    <div className="max-w-5xl">
      <DeploymentForm deployment={d} />
    </div>
  );
}
