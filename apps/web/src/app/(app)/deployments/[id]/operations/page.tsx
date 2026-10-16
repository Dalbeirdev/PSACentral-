import type { RemoteOperationsDto } from '@psacc/contracts';
import { Radio, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { RemoteOperations } from '@/components/deployments/remote-operations';
import { RefreshButton } from '@/components/refresh-button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { getDeployment } from '@/lib/deployments';

export const metadata: Metadata = { title: 'Remote operations' };

/**
 * Remote management (Module 13). Commands are signed by the Control Plane, pulled by the appliance's
 * agent over its outbound mTLS channel, verified there and answered. The list of possible commands is
 * fixed and non-destructive; suspension, revocation, decommissioning and uninstall are later modules.
 */
export default async function DeploymentOperationsPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const d = await getDeployment(id);
  const tz = me.user.timezone;
  if (d.isSynthetic) {
    return <Alert variant="synthetic" title="Synthetic sample record">No appliance exists for this sample deployment, so no command can be issued to it.</Alert>;
  }
  const r = await apiGet<RemoteOperationsDto>(`/deployments/${id}/operations?limit=100`);
  if (!r.ok) return <ErrorState problem={r.problem} title="Remote operations could not be loaded" />;
  const ops = r.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Remote operations"
          icon={<Radio />}
          description="Signed, time-limited commands that the appliance’s agent pulls with its heartbeat over its outbound connection. The Control Plane never connects into the client network, and nothing here is destructive."
          actions={<RefreshButton />}
        />
        <CardBody className="pt-1">
          <dl className="mb-4 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-slate-500">Appliance image</dt><dd className="font-medium text-slate-800" data-testid="running-version">{ops.runningVersion ?? 'Not reported yet'}{ops.upToDate ? <Badge tone="emerald" className="ml-2">up to date</Badge> : ops.runningVersion ? <Badge tone="amber" className="ml-2">upgrade available</Badge> : null}</dd></div>
            <div><dt className="text-slate-500">Standard image</dt><dd className="font-mono text-[12.5px] text-slate-800">{ops.upgradeTarget.repository}:{ops.upgradeTarget.version}</dd></div>
            <div><dt className="text-slate-500">Command signing key</dt><dd className="font-mono text-[12.5px] text-slate-800" data-testid="signing-key">{ops.signingKeyId}</dd></div>
            <div><dt className="text-slate-500">Open commands</dt><dd className="font-medium text-slate-800">{Object.keys(ops.open).length}</dd></div>
          </dl>
          <RemoteOperations ops={ops} canIssue={can(me, 'deployments.commands.issue')} timezone={tz} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="How commands are protected" icon={<ShieldCheck />} />
        <CardBody className="pt-1">
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-slate-700">
            <li>Each command is signed with this Control Plane’s Ed25519 command key; the agent pinned the public key at enrollment over the gateway certificate it already pins.</li>
            <li>The signature covers the command ID, type, parameters, this deployment and installation, the issue time and the expiry. A command for another appliance, an unknown type, a changed parameter or a past expiry is refused by the agent and reported as failed.</li>
            <li>Commands expire rather than run late (edge autonomy), are executed once, and are audited when issued, delivered, completed, expired or cancelled.</li>
            <li>Deliberately not commands today: suspend / resume are lifecycle actions on the Overview page (Module 14); decommissioning is a Control Plane decision that reaches the appliance only as the refusal of its retired identity (Module 15); uninstall and wipe run solely on the host, by its operator.</li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
