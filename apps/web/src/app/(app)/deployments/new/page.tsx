import type { ClientDetail } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DeploymentForm } from '@/components/deployments/deployment-form';
import { PageHeader } from '@/components/ui/page-header';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'New deployment' };

export default async function NewDeploymentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'deployments.write')) notFound();
  const { clientId } = await searchParams;
  const client = clientId && /^[0-9a-f-]{36}$/i.test(clientId) ? await apiGet<ClientDetail>(`/clients/${clientId}`) : null;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Deployments', href: '/deployments' }, { label: 'New deployment' }]}
        title="New deployment"
        description="Create the record for one more PSA Edge appliance for a client. It starts as a draft; the package with its single-use enrollment token is generated next, on the deployment’s Installation page."
      />
      <div className="max-w-5xl">
        <DeploymentForm preset={client?.ok ? { id: client.data.id, code: client.data.code, displayName: client.data.displayName } : null} />
      </div>
    </>
  );
}
