import type { EdgeImageInfo } from '@psacc/contracts';
import { Boxes, HardDrive, ShieldCheck, Terminal } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Docker Images' };

const mono = (v: string) => <span className="break-all font-mono text-[12.5px]">{v}</span>;

export default async function DockerImagesPage() {
  const me = await requireActiveSession();
  if (!can(me, 'deployments.read')) notFound();
  const r = await apiGet<EdgeImageInfo>('/deployments/edge-image');
  if (!r.ok) return <Card><ErrorState problem={r.problem} /></Card>;
  const img = r.data;
  const ref = `${img.repository}:${img.version}`;

  return (
    <>
      <PageHeader
        title="Docker Images"
        description="One standard, versioned PSA Edge image for every client. Each client’s deployment package configures it; no image is ever built per client."
      />
      {!img.digest ? (
        <Alert variant="info" title="No signed registry image is published yet" className="mb-4">
          Packages reference <span className="font-mono">{ref}</span> by tag. In development the image is built from source on the host that installs it. Signed images in a private registry, pinned by digest, are backlog item OPS-REGISTRY; until then production packages refuse to start without a pinned digest.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Current image" icon={<Boxes />} description="The image the next generated package references." />
          <CardBody className="pt-1">
            <DetailRows rows={[
              ['Repository', mono(img.repository)],
              ['Version', mono(img.version)],
              ['Digest', img.digest ? mono(img.digest) : <span key="d" className="font-normal text-slate-500">Not published (built from source)</span>],
              ['Base', 'Distroless static (no shell, no package manager)'],
              ['User', mono('10001:10001 (non-root)')],
              ['Size', 'About 6 MB (static Go binary on distroless)'],
            ]} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Security properties" icon={<ShieldCheck />} />
          <CardBody className="pt-1">
            <ul className="list-disc space-y-1.5 pl-5 text-[13.5px] text-slate-700">
              <li>Static binary on a distroless base; the build runs <span className="font-mono">go vet</span> and the unit tests.</li>
              <li>Runs as an unprivileged user with a read-only root file system, all capabilities dropped and <span className="font-mono">no-new-privileges</span>.</li>
              <li>No secret in the image: database passwords and the data key are generated on the client’s host; PSA credentials are encrypted in the client’s own database.</li>
              <li>Images are separate from data: everything persistent lives in the deployment’s named volumes.</li>
              <li>Outbound-only management traffic; the local admin UI is published on 127.0.0.1 only.</li>
            </ul>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4 overflow-hidden">
        <CardHeader title="Entrypoints" description="One binary, four roles, each started by the deployment’s Compose file." className="pb-4" />
        <Table>
          <thead><tr><Th>Entrypoint</Th><Th>Purpose</Th></tr></thead>
          <tbody>
            {img.entrypoints.map((e) => (
              <Tr key={e.name}><Td className="font-mono text-[13px] font-semibold text-slate-900">{e.name}</Td><Td className="text-[13.5px]">{e.purpose}</Td></Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Versions in use" icon={<HardDrive />} description="Image versions recorded on deployments when their package was generated. This is not proof that a host is running it — that comes from agent reports (Module 8)." className="pb-4" />
          <Table>
            <thead><tr><Th>Version</Th><Th>Deployments</Th><Th>Of which synthetic</Th></tr></thead>
            <tbody>
              {img.usage.map((u) => (
                <Tr key={u.version ?? 'none'}>
                  <Td className="font-mono text-[13px]">{u.version ?? <span className="font-sans text-slate-500">No package yet</span>}</Td>
                  <Td className="tabular-nums">{u.deployments}</Td>
                  <Td className="tabular-nums text-slate-500">{u.synthetic}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader title="Build from source (development)" icon={<Terminal />} />
          <CardBody className="space-y-3 pt-1 text-[13.5px] text-slate-700">
            <p>Go does not need to be installed: the build runs in the official Go image and produces the distroless runtime image.</p>
            <pre aria-label="Build commands" className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-[12.5px] leading-6 text-slate-100"><code>{`pnpm edge:test     # go vet + unit tests
pnpm edge:build    # docker build -t ${ref}`}</code></pre>
            <p className="text-[12.5px] text-slate-500">A ZIP deployment package is not an image. Air-gapped hosts will get a separate <span className="font-mono">docker save</span> / OCI export (backlog OPS-IMGEXPORT).</p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
