import type { ClientPsaInstanceDto, ClientServiceDto, PsaProviderDescriptor, ServiceDto } from '@psacc/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { ServicesEditor } from './services-editor';

export const metadata: Metadata = { title: 'Client services' };

export default async function ClientServicesPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const [catalog, assigned, instances, providers] = await Promise.all([
    apiGet<ServiceDto[]>('/services?status=active'),
    apiGet<ClientServiceDto[]>(`/clients/${id}/services`),
    apiGet<ClientPsaInstanceDto[]>(`/clients/${id}/psa-instances`),
    apiGet<PsaProviderDescriptor[]>('/psa-providers'),
  ]);
  if (!catalog.ok) return <Card><ErrorState problem={catalog.problem} /></Card>;
  if (!assigned.ok) return <Card><ErrorState problem={assigned.problem} /></Card>;
  const canEdit = can(me, 'clients.write');
  const providerKeys = new Set((instances.ok ? instances.data : []).map((i) => i.providerKey));
  const clientProviders = (providers.ok ? providers.data : []).filter((p) => providerKeys.has(p.key));
  const incomplete = assigned.data.filter((s) => s.configIssues.length).length;
  return (
    <Card>
      <CardHeader
        title="Services"
        description={
          <>
            {assigned.data.length} of {catalog.data.length} active catalog services are provided to this client{incomplete ? `; ${incomplete} with incomplete settings` : ''}. The selection and its settings are included in the deployment configuration.{' '}
            {can(me, 'services.read') ? <Link href="/services" className="text-blue-700 underline hover:no-underline">Manage the catalog</Link> : null}
          </>
        }
      />
      <CardBody>
        <ServicesEditor clientId={id} catalog={catalog.data} assigned={assigned.data} providers={clientProviders} canEdit={canEdit} />
      </CardBody>
    </Card>
  );
}
