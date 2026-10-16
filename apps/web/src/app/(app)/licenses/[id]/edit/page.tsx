import type { LicenseDetail } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LicenseForm } from '@/components/licenses/license-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Edit license' };

export default async function EditLicensePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'licenses.manage')) notFound();
  const { id } = await params;
  const r = await apiGet<LicenseDetail>(`/licenses/${id}`);
  if (!r.ok) notFound();
  const l = r.data;
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Licenses', href: '/licenses' }, { label: l.code, href: `/licenses/${id}` }, { label: 'Edit' }]} title={<>Edit <span className="font-mono">{l.code}</span></>} description={`${l.displayName} · ${l.client.displayName}`} />
      {l.isSynthetic ? (
        <Alert variant="synthetic" title="Synthetic sample record">Development sample data cannot be changed.</Alert>
      ) : l.status === 'revoked' ? (
        <Alert variant="info" title="A revoked license cannot be edited" />
      ) : (
        <Card className="max-w-4xl">
          <CardBody className="sm:p-8">
            <LicenseForm clients={[{ id: l.client.id, code: l.client.code, displayName: l.client.displayName, status: 'active' }]} license={l} />
          </CardBody>
        </Card>
      )}
    </>
  );
}
