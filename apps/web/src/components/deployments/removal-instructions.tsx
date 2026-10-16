import type { DeploymentDetail } from '@psacc/contracts';
import { Terminal } from 'lucide-react';

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre aria-label={label} className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-[12.5px] leading-6 text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

/**
 * Module 15 — host-side removal of a decommissioned appliance. The Control Plane never removes anything on
 * the client's host; these are the commands the host operator runs from the package folder.
 */
export function RemovalInstructions({ d }: { d: DeploymentDetail }) {
  const folder = `psacc-${d.code.toLowerCase()}`;
  const windows = d.targetOs === 'windows';
  const linux = [`cd ${folder}`, 'scripts/uninstall.sh                      # stop; keep the data volumes, ./secrets and .env', `scripts/uninstall.sh --wipe --confirm ${d.code}   # delete everything (irreversible)`].join('\n');
  const win = [
    `Set-Location ${folder}`,
    'powershell -ExecutionPolicy Bypass -File scripts\\uninstall.ps1                      # stop; keep the data',
    `powershell -ExecutionPolicy Bypass -File scripts\\uninstall.ps1 -Wipe -Confirm ${d.code}   # delete everything (irreversible)`,
  ].join('\n');
  const blocks = [
    { key: 'linux', title: 'Linux Docker host', code: linux },
    { key: 'windows', title: 'Windows Docker host (Docker Desktop, Linux containers)', code: win },
  ];
  if (windows) blocks.reverse();
  return (
    <div className="space-y-4 text-[13.5px] leading-6 text-slate-700" data-testid="removal-instructions">
      <ol className="list-decimal space-y-1 pl-5">
        <li>The appliance learns at its next heartbeat that its identity was retired, stops PSA work and shows <em>Decommissioned by the provider</em> in its local admin (where these instructions appear too).</li>
        <li>On the client’s host, run the uninstall script from the package folder as the user who installed the appliance. Without options it stops the appliance and keeps the data; with <code className="font-mono text-[12px]">--wipe</code> it deletes the database, logs, backups, agent state, <code className="font-mono text-[12px]">./secrets</code> and <code className="font-mono text-[12px]">.env</code>. The deployment ID must be typed on the command line.</li>
        <li>The script refuses to wipe while the agent still reports an active identity, so the Control Plane step cannot be skipped by accident. Make and check a backup first if the data may still be needed.</li>
        <li>Afterwards delete the package folder; the PSA Edge image can be removed once no other deployment on that host uses it.</li>
      </ol>
      {blocks.map((b) => (
        <div key={b.key}>
          <p className="mb-1 flex items-center gap-2 text-[12.5px] font-semibold uppercase tracking-wide text-slate-500"><Terminal className="size-3.5" aria-hidden="true" /> {b.title}</p>
          <Code label={`${b.title} removal commands`}>{b.code}</Code>
        </div>
      ))}
    </div>
  );
}
