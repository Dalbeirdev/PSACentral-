import { CircleCheck, CircleX, ListChecks, PackageOpen, Terminal } from 'lucide-react';
import type { Metadata } from 'next';
import { PackageStatusBadge, TokenStatusBadge } from '@/components/deployments/badges';
import { InstallInstructions } from '@/components/deployments/install-instructions';
import { PackagePanel } from '@/components/deployments/package-panel';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { can, requireActiveSession } from '@/lib/api-server';
import { formatBytes, getDeployment } from '@/lib/deployments';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Deployment installation' };

export default async function InstallationPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const d = await getDeployment(id);
  const tz = me.user.timezone;
  const ready = d.readiness.every((c) => c.ok);

  return (
    <div className="space-y-4">
      {d.isSynthetic ? (
        <Alert variant="synthetic" title="Synthetic sample record">No real package can be generated for development sample data.</Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Readiness"
          icon={<ListChecks />}
          description="Checked by the server before a package is generated: client, PSA instance and configuration, services and target platform."
          actions={<span className={ready ? 'text-sm font-semibold text-emerald-700' : 'text-sm font-semibold text-amber-700'}>{ready ? 'Ready' : `${d.readiness.filter((c) => !c.ok).length} to resolve`}</span>}
        />
        <CardBody className="pt-1">
          <ul className="divide-y divide-slate-100" aria-label="Readiness checks">
            {d.readiness.map((c) => (
              <li key={c.key} className="flex items-start gap-3 py-2.5 text-sm">
                {c.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="Passed" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-red-600" aria-label="Not met" />}
                <span className="min-w-0">
                  <span className="font-medium text-slate-900">{c.label}</span>
                  <span className="block text-[13px] text-slate-600 [overflow-wrap:anywhere]">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Deployment package" icon={<PackageOpen />} description="Compose configuration, appliance configuration, single-use enrollment token, install and verify scripts, and documentation for this one installation." />
        <CardBody className="pt-1">
          <PackagePanel d={d} canGenerate={can(me, 'deployments.package.generate')} timezone={tz} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Install and verify" icon={<Terminal />} />
        <CardBody className="pt-1">
          <InstallInstructions d={d} />
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Package history" description="Every package generated for this deployment. Archives are kept, encrypted, only while their token can still be used." className="pb-4" />
        {d.packages.length ? (
          <Table>
            <thead>
              <tr><Th>Package</Th><Th>Status</Th><Th>Token</Th><Th>Generated</Th><Th>Downloads</Th><Th>SHA-256</Th></tr>
            </thead>
            <tbody>
              {d.packages.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-semibold">#{p.number}<span className="block font-normal text-[12px] text-slate-500">{formatBytes(p.sizeBytes)}</span></Td>
                  <Td><PackageStatusBadge status={p.status} />{p.revokeReason ? <span className="mt-1 block max-w-60 text-[12px] text-slate-500">{p.revokeReason}</span> : null}</Td>
                  <Td><TokenStatusBadge status={p.token.status} /><span className="mt-1 block font-mono text-[12px] text-slate-500">{p.token.prefix}</span></Td>
                  <Td className="whitespace-nowrap text-[13px]">{formatDateTime(p.generatedAt, tz)}<span className="block text-[12px] text-slate-500">{p.generatedBy}</span></Td>
                  <Td className="text-[13px]">{p.downloadCount}</Td>
                  <Td className="font-mono text-[11.5px] text-slate-500">{p.sha256.slice(0, 16)}…</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500 sm:px-6">No package has been generated yet.</p>
        )}
      </Card>
    </div>
  );
}
