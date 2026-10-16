import { APPLIANCE_LICENSE_STATE_LABELS, type AuditEventDto, type Paged } from '@psacc/contracts';
import { Archive, ArrowRight, Cpu, Database, Fingerprint, KeyRound, Plug, Radio } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AgentIdentity } from '@/components/deployments/agent-identity';
import { RemoveDeployment } from '@/components/deployments/decommission';
import { RemovalInstructions } from '@/components/deployments/removal-instructions';
import { LifecycleActions } from '@/components/deployments/lifecycle-actions';
import { LifecycleTracker } from '@/components/deployments/lifecycle-tracker';
import { ConnectionBadge, CredentialBadge } from '@/components/psa/badges';
import { Alert } from '@/components/ui/alert';
import { Badge, HealthPill } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { getDeployment } from '@/lib/deployments';
import { formatDateTime, relativeTime } from '@/lib/format';
import { ENVIRONMENT_LABEL } from '@/lib/reference';

export const metadata: Metadata = { title: 'Deployment' };

const mono = (v: string | null | undefined) => (v ? <span className="break-all font-mono text-[12.5px]">{v}</span> : null);

export default async function DeploymentOverview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const { saved } = await searchParams;
  const [d, activity] = await Promise.all([getDeployment(id), apiGet<Paged<AuditEventDto>>(`/deployments/${id}/activity?pageSize=8`)]);
  const tz = me.user.timezone;
  const pkg = d.currentPackage;

  return (
    <div className="space-y-4">
      {saved === 'created' ? (
        <Alert variant="success" title={`Deployment ${d.code} created.`}>
          It is a draft: no package and no enrollment token exist yet.{' '}
          {can(me, 'deployments.package.generate') ? <Link href={`/deployments/${id}/installation`} className="font-semibold underline">Generate the package next.</Link> : null}
        </Alert>
      ) : null}
      {saved === 'updated' ? <Alert variant="success" title="Settings saved and recorded in the activity history." /> : null}
      {saved === 'decommissioned' ? <Alert variant="success" title={`${d.code} decommissioned.`}>Its identity is retired on the Control Plane; the appliance is told at its next heartbeat. Nothing on the client’s host was deleted — the removal instructions are below.</Alert> : null}
      {d.isSynthetic ? (
        <Alert variant="synthetic" title="Synthetic sample record">
          Its lifecycle and health come from development sample data, not from a real appliance. No package exists for it.
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="Lifecycle" description="Each stage needs evidence. Downloading a package is recorded, but only the agent’s enrollment shows that it was installed." />
        <CardBody className="pt-1">
          <LifecycleTracker d={d} timezone={tz} />
          {!d.isSynthetic && can(me, 'deployments.write') ? <div className="mt-4"><LifecycleActions d={d} timezone={tz} /></div> : null}
          {!d.isSynthetic && d.lifecycleState !== 'decommissioned' && can(me, 'deployments.decommission') ? (
            <div className="mt-3">
              <ButtonLink href={`/deployments/${id}/decommission`} variant="ghost" data-testid="decommission-link"><Archive /> Decommission (final)…</ButtonLink>
            </div>
          ) : null}
          {!d.isSynthetic && ['draft', 'package_generated', 'package_downloaded'].includes(d.lifecycleState) ? (
            <div className="mt-4">
              <ButtonLink href={`/deployments/${id}/installation`} variant={pkg ? 'secondary' : 'primary'}>
                {pkg ? 'Installation and package' : 'Generate the deployment package'} <ArrowRight />
              </ButtonLink>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Identity" icon={<Fingerprint />} description="Separate identifiers; no shared key is used for every customer." />
          <CardBody className="pt-1">
            <DetailRows rows={[
              ['Deployment ID', mono(d.id)],
              ['License ID', d.licenseDetail ? <span key="l"><Link href={`/licenses/${d.licenseDetail.id}`} className="text-blue-700 hover:underline">{d.licenseDetail.code}</Link> {mono(d.licenseDetail.id)} <span className="block text-[12px] font-normal text-slate-500">{d.licenseDetail.displayName} · {d.licenseDetail.status}{d.licenseDetail.endsAt ? ` · until ${d.licenseDetail.endsAt}` : ' · perpetual'}</span></span> : <span key="l" className="text-amber-700">No license assigned{d.lifecycleState === 'draft' ? ' — choose one in Settings' : ''}</span>],
              ['Client ID', <span key="c"><Link href={`/clients/${d.client.id}`} className="text-blue-700 hover:underline">{d.client.code}</Link> {mono(d.client.id)}</span>],
              ['PSA instance ID', d.psaInstance ? <span key="p"><Link href={`/psa/${d.psaInstance.id}`} className="text-blue-700 hover:underline">{d.psaInstance.code}</Link> {mono(d.psaInstance.id)}</span> : null],
              ['Installation ID', d.installationId ? mono(d.installationId) : pkg ? <span key="i">{mono(pkg.installationId)} <span className="block text-[12px] font-normal text-slate-500">From package #{pkg.number}; registered when the agent enrolls</span></span> : <span key="i" className="font-normal text-slate-500">Created with the package</span>],
              ['Enrollment token', pkg ? <span key="t"><span className="font-mono">{pkg.token.prefix}</span> <span className="block text-[12px] font-normal text-slate-500">Single use · expires {formatDateTime(pkg.token.expiresAt, tz)}</span></span> : <span key="t" className="font-normal text-slate-500">Issued with the package</span>],
              ['Agent certificate', d.agentCertificates.find((c) => c.status === 'active') ? <span key="a" className="font-mono text-[12.5px]">{d.agentCertificates.find((c) => c.status === 'active')!.serial.slice(0, 16)}…</span> : <span key="a" className="font-normal text-slate-500">Issued when the agent enrolls</span>],
            ]} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Platform and image" icon={<Cpu />} />
          <CardBody className="pt-1">
            <DetailRows rows={[
              ['Environment', ENVIRONMENT_LABEL[d.targetEnvironment] ?? d.targetEnvironment],
              ['OS / architecture', [d.targetOs, d.targetArch].filter(Boolean).join(' / ') || null],
              ['Host label', d.hostLabel],
              ['Docker image version', d.imageVersion ? mono(`${d.edgeImage.repository}:${d.imageVersion}`) : <span key="v" className="font-normal text-slate-500">Set when the package is generated</span>],
              ['Image digest', d.imageDigest ? mono(d.imageDigest) : <span key="g" className="font-normal text-slate-500">Not published yet (signed images: Module 6)</span>],
              ['Created', `${formatDateTime(d.createdAt, tz)}${d.createdBy ? ` by ${d.createdBy}` : ''}`],
            ]} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="PSA integration" icon={<Plug />} description="Runs on the client’s appliance and calls the PSA API from there." />
          <CardBody className="pt-1">
            {d.psaInstanceDetail ? (
              <DetailRows rows={[
                ['Instance', <Link key="i" href={`/psa/${d.psaInstanceDetail.id}`} className="text-blue-700 hover:underline">{d.psaInstanceDetail.displayName}</Link>],
                ['Provider', d.psaInstanceDetail.providerName],
                ['API endpoint', mono(d.psaInstanceDetail.apiEndpoint)],
                ['Connection', <ConnectionBadge key="c" status={d.psaInstanceDetail.connectionStatus as 'untested' | 'succeeded' | 'failed'} />],
                ['Credentials', <CredentialBadge key="k" status={d.psaInstanceDetail.credentialStatus} />],
              ]} />
            ) : <p className="text-sm text-slate-500">No PSA instance assigned.</p>}
            <div className="mt-4">
              <p className="text-[13px] font-medium text-slate-700">Services on this appliance</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {d.services.filter((s) => !s.requiresPsa || s.enabledOnPsa).map((s) => (
                  <li key={s.id}><Badge tone={s.configComplete ? 'blue' : 'amber'} title={s.configComplete ? undefined : 'Required settings are missing on the client’s Services page'}>{s.name}{s.requiresPsa ? ' · via PSA' : ''}{s.configComplete ? '' : ' · settings incomplete'}</Badge></li>
                ))}
              </ul>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Agent and database" icon={<Radio />} description="Reported by the agent over its outbound connection." />
          <CardBody className="pt-1">
            <DetailRows rows={[
              ['Agent status', d.isSynthetic ? <span key="s" className="italic text-slate-500">Synthetic — not live</span> : d.lifecycleState === 'enrolled' || d.lifecycleState === 'verified' ? 'Enrolled (mutual TLS)' : d.lifecycleState === 'suspended' && d.enrolledAt && d.agentCertificates.some((c) => c.status === 'active') ? 'Enrolled (mutual TLS) — suspended' : d.lifecycleState === 'decommissioned' ? <span key="s" className="font-normal text-slate-700">Identity retired — decommissioned{d.enrolledAt ? '; the appliance no longer reports' : ''}</span> : d.agentCertificates.some((c) => c.status === 'revoked') ? <span key="s" className="font-normal text-red-700">Certificate revoked — re-enroll with a new package</span> : <span key="s" className="font-normal text-slate-500">Not enrolled — no agent has connected</span>],
              ['Last heartbeat', d.isSynthetic ? <span key="h" className="italic text-slate-500">Synthetic — not live</span> : d.lastHeartbeatAt ? <span key="h" title={formatDateTime(d.lastHeartbeatAt, tz)}>{relativeTime(d.lastHeartbeatAt)}</span> : 'Never'],
              ['Agent version', d.agentVersion],
              ['Appliance license token', d.isSynthetic ? null : d.applianceLicense
                ? <span key="lt" className={d.applianceLicense.psaWorkAllowed ? 'text-slate-800' : 'font-normal text-red-700'} data-testid="appliance-license">{APPLIANCE_LICENSE_STATE_LABELS[d.applianceLicense.state]}{d.applianceLicense.tokenExpiresAt ? ` · renewed until ${formatDateTime(d.applianceLicense.tokenExpiresAt, tz)}` : ''} · key {d.applianceLicense.keyId ?? 'none'} ({d.applianceLicense.keySource}){d.applianceLicense.psaWorkAllowed ? '' : ' · PSA work stopped on the appliance'}</span>
                : <span key="lt" className="font-normal text-slate-500">Not reported yet — the appliance verifies its token and reports the result</span>],
              ['Health', <span key="db" className="inline-flex items-center gap-1.5"><Database className="size-3.5 text-slate-400" aria-hidden="true" /><HealthPill state={d.healthState} />{d.healthReason ? <span className="text-[12px] font-normal text-slate-500">{d.healthReason}</span> : null}</span>],
              ['Details', <Link key="hl" href={`/deployments/${id}/health`} className="text-blue-700 hover:underline">Health page: reports, resources, timeline</Link>],
            ]} />
          </CardBody>
        </Card>
      </div>

      {!d.isSynthetic ? (
        <Card>
          <CardHeader title="Machine identity" icon={<KeyRound />} description="The agent authenticates to the Control Plane with this certificate over mutual TLS. Issued from the platform CA at enrollment; renewed automatically." />
          <CardBody className="pt-1">
            <AgentIdentity d={d} canRevoke={can(me, 'deployments.write')} timezone={tz} />
          </CardBody>
        </Card>
      ) : null}

      {d.lifecycleState === 'decommissioned' && d.decommission ? (
        <Card>
          <CardHeader title="Decommissioned" icon={<Archive />} description="Final. The management identity is retired; the Control Plane keeps metadata only, and only for the retention period." />
          <CardBody className="space-y-4 pt-1">
            <Alert variant="warning" title={`Decommissioned ${formatDateTime(d.decommission.at, tz)}${d.decommission.by ? ` by ${d.decommission.by}` : ''}`}>
              Reason: {d.decommission.reason}. It was <em>{d.decommission.fromState.replace(/_/g, ' ')}</em> before.
              {' '}Retired: {d.decommission.identity.certificatesRevoked} certificate(s), {d.decommission.identity.tokensRevoked} enrollment token(s), {d.decommission.identity.packagesRevoked} package(s); {d.decommission.identity.commandsCancelled} open command(s) cancelled.
              {' '}{d.decommission.metadataPurgedAt
                ? `Retained metadata purged ${formatDateTime(d.decommission.metadataPurgedAt, tz)}.`
                : `Reports, heartbeats, inventory and command history are kept until ${formatDateTime(d.decommission.retainedUntil, tz)}, then purged by the retention policy.`}
            </Alert>
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-900">Removal on the client’s host</p>
              <RemovalInstructions d={d} />
            </div>
            {can(me, 'deployments.decommission') ? (
              <div className="border-t border-slate-100 pt-4">
                <p className="mb-2 text-sm font-semibold text-slate-900">Remove the record</p>
                <p className="mb-3 text-[12.5px] text-slate-600">Once the appliance has been removed on the host (or its data is no longer needed), the record can be deleted from the Control Plane. The audit trail stays.</p>
                <RemoveDeployment d={d} />
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Recent activity" />
        <CardBody className="pt-1">
          {activity.ok && activity.data.items.length ? (
            <ul className="divide-y divide-slate-100">
              {activity.data.items.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-[13px]">
                  <span className="font-mono text-[12.5px] text-slate-900">{e.action}{typeof e.metadata.packageNumber === 'number' ? ` · package #${e.metadata.packageNumber}` : ''}</span>
                  <span className="text-slate-500" title={formatDateTime(e.occurredAt, tz)}>{e.actorDisplay} · {relativeTime(e.occurredAt)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-500">No activity recorded yet.</p>}
        </CardBody>
      </Card>
    </div>
  );
}
