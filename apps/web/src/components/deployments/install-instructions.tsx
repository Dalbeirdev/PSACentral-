import type { DeploymentDetail } from '@psacc/contracts';
import { Terminal } from 'lucide-react';

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre aria-label={label} className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-[12.5px] leading-6 text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

/** Installation commands and verification steps for the deployment's current (or next) package. */
export function InstallInstructions({ d }: { d: DeploymentDetail }) {
  const slug = d.code.toLowerCase();
  const folder = `psacc-${slug}`;
  const zip = d.currentPackage?.fileName ?? `psacc-${slug}-package-<n>.zip`;
  const windows = d.targetOs === 'windows';
  const linux = [`unzip ${zip} && cd ${folder}`, 'sha256sum -c CHECKSUMS.sha256', 'scripts/install.sh            # add --production on production hosts', 'scripts/verify.sh'].join('\n');
  const win = [
    `Expand-Archive ${zip} .; Set-Location ${folder}`,
    'powershell -ExecutionPolicy Bypass -File scripts\\install.ps1   # add -Production on production hosts',
    'powershell -ExecutionPolicy Bypass -File scripts\\verify.ps1',
  ].join('\n');
  const blocks = [
    { key: 'linux', title: 'Linux Docker host', code: linux },
    { key: 'windows', title: 'Windows Docker host (Docker Desktop, Linux containers)', code: win },
  ];
  if (windows) blocks.reverse();

  return (
    <div className="space-y-5 text-[13.5px] leading-6 text-slate-700">
      <ol className="list-decimal space-y-1 pl-5">
        <li>Copy the ZIP to the client’s {d.targetOs === 'windows' ? 'Windows' : 'Linux'} host ({d.targetArch}). It needs Docker Engine 24+ with Compose v2, an encrypted disk, and outbound HTTPS only — no inbound ports.</li>
        <li>Check the SHA-256 against the value shown above, then run the install script. It generates the database passwords and data key <strong>on that host</strong>; they are never part of the package.</li>
        <li>Enter the PSA credentials in the appliance’s local admin UI (this host only). They are never sent to the Control Plane.</li>
        <li>Run the verify script. It checks containers, the database, migrations and tables on that host.</li>
        <li>This page shows <strong>Enrolled</strong> only after the agent has connected with the single-use token, and <strong>Verified</strong> after its health reports pass.</li>
      </ol>
      {blocks.map((b) => (
        <div key={b.key}>
          <p className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-slate-900"><Terminal className="size-4 text-slate-500" aria-hidden="true" />{b.title}</p>
          <Code label={`${b.title} commands`}>{b.code}</Code>
        </div>
      ))}
      <p className="text-[12.5px] text-slate-500">
        The ZIP is a deployment package (configuration, Compose files, scripts and documentation). It is not a Docker image: the standard PSA Edge image{' '}
        <span className="font-mono">{d.edgeImage.repository}:{d.edgeImage.version}</span> is pulled from the registry, or built from source in development.
        {d.edgeImage.digest ? null : ' No signed image digest is published yet (Module 6), so production installs cannot be pinned until then.'}
      </p>
    </div>
  );
}
