import type { HealthPolicy } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { HealthPolicyForm } from './health-policy-form';

export const metadata: Metadata = { title: 'Health policy' };

export default async function HealthPolicyPage() {
  const me = await requireActiveSession();
  if (!can(me, 'settings.manage')) notFound();
  const r = await apiGet<HealthPolicy>('/monitoring/policy');
  return (
    <>
      <PageHeader title="Health policy" description="Heartbeat interval, offline threshold and resource thresholds for every deployment in this organization. Changes apply immediately and are audited." />
      <Card>{r.ok ? <CardBody><HealthPolicyForm initial={r.data} /></CardBody> : <ErrorState problem={r.problem} />}</Card>
    </>
  );
}
