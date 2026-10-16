import type { ClientPsaInstanceDto } from '@psacc/contracts';
import { CircleQuestionMark, Plug, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';
import { AUTH_METHOD_LABEL, CREDENTIAL_STATUS_LABEL } from '@/lib/reference';

export const metadata: Metadata = { title: 'Client PSA instances' };

export default async function ClientPsaPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'psa.read')) notFound();
  const { id } = await params;
  const list = await apiGet<ClientPsaInstanceDto[]>(`/clients/${id}/psa-instances`);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="PSA instances"
        description="Configuration recorded for this client. Credentials are never stored or shown here; the connection is tested from the client's appliance."
        actions={can(me, 'psa.write') ? <ButtonLink href={`/psa/new?clientId=${id}`} variant="primary" size="sm"><Plus /> Add PSA instance</ButtonLink> : null}
        className="pb-4"
      />
      {!list.ok ? (
        <ErrorState problem={list.problem} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={<Plug />} title="No PSA instance" />
      ) : (
        <Table>
          <thead>
            <tr><Th>Instance</Th><Th>Provider</Th><Th>API endpoint</Th><Th>Credentials</Th><Th>Connection</Th></tr>
          </thead>
          <tbody>
            {list.data.map((p) => (
              <Tr key={p.id}>
                <Td>
                  <Link href={`/psa/${p.id}`} className="font-semibold text-slate-900 hover:text-blue-700">{p.displayName}</Link>
                  <span className="flex items-center gap-2 text-[12.5px] text-slate-500"><span className="font-mono">{p.code}</span>{p.isSynthetic ? <SyntheticBadge /> : null}</span>
                </Td>
                <Td className="text-[13px]">{p.providerName}<span className="block text-[12px] text-slate-500">{AUTH_METHOD_LABEL[p.authMethod ?? ''] ?? p.authMethod ?? ''}</span></Td>
                <Td className="max-w-64 truncate font-mono text-[12px] text-slate-600" title={p.apiEndpoint ?? undefined}>{p.apiEndpoint ?? '—'}</Td>
                <Td className="text-[13px]">{CREDENTIAL_STATUS_LABEL[p.credentialStatus] ?? p.credentialStatus}</Td>
                <Td>
                  {p.connectionStatus === 'succeeded' ? (
                    <Badge tone="emerald">Verified {p.lastSuccessfulTestAt ? formatDateTime(p.lastSuccessfulTestAt, me.user.timezone) : ''}</Badge>
                  ) : p.connectionStatus === 'failed' ? (
                    <Badge tone="red">Failed</Badge>
                  ) : (
                    <Badge><CircleQuestionMark /> Untested</Badge>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
