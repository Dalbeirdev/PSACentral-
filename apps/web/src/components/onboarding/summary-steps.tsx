import type { DeploymentDetail, OnboardingDraftDto, ServiceDto, UserRef } from '@psacc/contracts';
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, Clock, Pencil } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { InstallInstructions } from '@/components/deployments/install-instructions';
import { PackagePanel } from '@/components/deployments/package-panel';
import { HealthPill, LifecycleStage } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { RefreshButton } from '@/components/refresh-button';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { CONTACT_ROLE_LABEL, countryName, ENVIRONMENT_LABEL } from '@/lib/reference';
import { stepHref } from '@/lib/wizard';
import type { ProviderOption } from './data-steps';
import { StepCard } from './wizard-frame';

function Block({ title, edit, children }: { title: string; edit?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {edit ? (
          <Link href={edit} className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-700 hover:underline">
            <Pencil className="size-3.5" aria-hidden="true" /> Edit <span className="sr-only">{title}</span>
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[minmax(120px,auto)_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="font-medium text-slate-800">{v || <span className="font-normal text-slate-500">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ReviewStep({ draft, providers, services, users }: { draft: OnboardingDraftDto; providers: ProviderOption[]; services: ServiceDto[]; users: UserRef[] }) {
  const d = draft.data;
  const c = d.client!;
  const provider = providers.find((p) => p.key === d['psa-provider']?.providerKey);
  const userName = (id?: string) => users.find((u) => u.id === id)?.displayName ?? '';
  const chosen = services.filter((s) => d.services?.serviceIds.includes(s.id));
  return (
    <StepCard
      title="Review"
      description="Check every section. Use Edit to change a section; your other answers are kept."
      footer={
        <>
          <ButtonLink href={stepHref(draft.id, 'deployment')} variant="ghost"><ArrowLeft /> Back</ButtonLink>
          <ButtonLink href={stepHref(draft.id, 'create')} variant="primary">Continue to create <ArrowRight /></ButtonLink>
        </>
      }
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <Block title="Company" edit={stepHref(draft.id, 'client')}>
          <Rows rows={[
            ['Legal name', c.company.legalName], ['Display name', c.company.displayName],
            ['Reference', <span key="r" className="font-mono">{c.company.clientReference}</span>], ['Business type', c.company.businessType],
            ['Location', [c.company.city, c.company.stateRegion, countryName(c.company.countryCode)].filter(Boolean).join(', ')],
            ['Time zone', c.company.timezone], ['Website', c.company.website ?? ''],
          ]} />
        </Block>
        <Block title="Management" edit={stepHref(draft.id, 'client')}>
          <Rows rows={[
            ['Account manager', userName(c.management.accountManagerUserId)], ['Technical owner', userName(c.management.technicalOwnerUserId)],
            ['Onboarding date', c.management.onboardingDate ? formatCalendarDate(c.management.onboardingDate) : 'Today (on creation)'],
            ['Contract', c.management.contractStartDate || c.management.contractEndDate ? `${formatCalendarDate(c.management.contractStartDate)} → ${formatCalendarDate(c.management.contractEndDate)}` : ''],
            ['Internal notes', c.management.internalNotes ? 'Provided' : ''],
          ]} />
        </Block>
        <Block title={`Contacts (${c.contacts.length})`} edit={stepHref(draft.id, 'client')}>
          <ul className="space-y-2 text-[13px]">
            {c.contacts.map((p) => (
              <li key={p.email} className="flex flex-wrap items-baseline justify-between gap-2">
                <span><span className="font-medium text-slate-800">{p.fullName}</span> <span className="text-slate-500">· {p.email}</span></span>
                <span className="text-slate-500">{p.roles.map((r) => CONTACT_ROLE_LABEL[r]).join(', ')}</span>
              </li>
            ))}
          </ul>
        </Block>
        <Block title="PSA" edit={stepHref(draft.id, 'psa-provider')}>
          <Rows rows={[
            ['Provider', provider?.name ?? ''], ['Instance name', d['psa-config']?.displayName ?? ''],
            ['Authentication', provider?.authMethods.find((m) => m.key === d['psa-config']?.authMethod)?.label ?? d['psa-config']?.authMethod ?? ''],
            ...(provider?.configFields ?? [])
              .filter((f) => d['psa-config']?.config?.[f.key] !== undefined)
              .map((f): [string, ReactNode] => [
                f.label,
                <span key={f.key} className="break-all font-mono text-[12px]">
                  {f.options?.find((o) => o.value === d['psa-config']?.config?.[f.key])?.label ?? String(d['psa-config']?.config?.[f.key])}
                </span>,
              ]),
            ['Credentials', 'Entered on the appliance later'],
          ]} />
        </Block>
        <Block title={`Services (${chosen.length})`} edit={stepHref(draft.id, 'services')}>
          <p className="text-[13px] leading-6 text-slate-800">{chosen.map((s) => s.name).join(' · ')}</p>
        </Block>
        <Block title="Deployment" edit={stepHref(draft.id, 'deployment')}>
          <Rows rows={[
            ['Environment', ENVIRONMENT_LABEL[d.deployment?.targetEnvironment ?? ''] ?? ''],
            ['Host OS', d.deployment?.targetOs === 'windows' ? 'Windows' : 'Linux'],
            ['Architecture', <span key="a" className="font-mono">{d.deployment?.targetArch}</span>],
            ['Host label', d.deployment?.hostLabel ?? ''],
          ]} />
        </Block>
      </div>
    </StepCard>
  );
}

function IdTable({ draft, deployment }: { draft: OnboardingDraftDto; deployment: DeploymentDetail | null }) {
  const r = draft.result!;
  const pkg = deployment?.currentPackage ?? null;
  const rows: [string, ReactNode, boolean][] = [
    ['Client ID', r.clientCode, true],
    ['PSA Instance ID', r.psaInstanceCode, true],
    ['License ID', r.licenseCode, true],
    ['Deployment ID', r.deploymentCode, true],
    ['Installation ID', deployment?.installationId ?? pkg?.installationId ?? 'Created with the deployment package (step 8)', !!(deployment?.installationId ?? pkg)],
    ['Enrollment token', pkg ? `${pkg.token.prefix} · single use` : 'Issued with the deployment package (step 8)', !!pkg],
    ['Deployment configuration', pkg ? `In package #${pkg.number} (config/edge.json)` : 'Rendered into the deployment package (step 8)', !!pkg],
  ];
  return (
    <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200">
      {rows.map(([k, v, ok]) => (
        <div key={k} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <dt className="flex items-center gap-2 text-slate-600">
            {ok ? <CircleCheck className="size-4 text-emerald-600" aria-hidden="true" /> : <Clock className="size-4 text-slate-400" aria-hidden="true" />}
            {k}
          </dt>
          <dd className={ok ? 'break-all font-mono text-[13px] font-semibold text-slate-900' : 'text-[13px] text-slate-500'}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DownloadStep({ draft, deployment, canGenerate, timezone }: { draft: OnboardingDraftDto; deployment: DeploymentDetail | null; canGenerate: boolean; timezone: string }) {
  return (
    <StepCard
      title="Deployment package"
      description="Generate the client-specific package (Compose files, configuration, single-use enrollment token, install and verify scripts, instructions) and download it. It is not a Docker image."
      footer={
        <>
          {deployment ? <ButtonLink href={`/deployments/${deployment.id}/installation`} variant="ghost">Open the deployment’s Installation page</ButtonLink> : <span />}
          <ButtonLink href={stepHref(draft.id, 'verify')} variant="primary">Continue <ArrowRight /></ButtonLink>
        </>
      }
    >
      {deployment ? (
        <>
          {deployment.readiness.some((c) => !c.ok) ? (
            <ul className="mb-4 space-y-1 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[13px] text-amber-950" aria-label="Readiness checks not met">
              {deployment.readiness.filter((c) => !c.ok).map((c) => <li key={c.key}><span className="font-semibold">{c.label}:</span> {c.detail}</li>)}
            </ul>
          ) : null}
          <PackagePanel d={deployment} canGenerate={canGenerate} timezone={timezone} />
          {deployment.currentPackage ? (
            <details className="mt-5 rounded-xl border border-slate-200 px-4 py-3">
              <summary className="cursor-pointer text-[13px] font-medium text-blue-700">Installation instructions</summary>
              <div className="mt-3"><InstallInstructions d={deployment} /></div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-slate-500">The deployment record is not visible to you.</p>
      )}
      <h3 className="mb-3 mt-6 text-sm font-semibold text-slate-900">Identifiers</h3>
      <IdTable draft={draft} deployment={deployment} />
    </StepCard>
  );
}

export function VerifyStep({ draft, deployment, timezone }: { draft: OnboardingDraftDto; deployment: DeploymentDetail | null; timezone: string }) {
  const downloaded = !!deployment && (!!deployment.packageDownloadedAt || ['enrolled', 'verified'].includes(deployment.lifecycleState));
  const checks: [string, boolean, string][] = [
    ['Package generated', !!deployment?.currentPackage || !!deployment?.enrolledAt, 'Generate it in step 8'],
    ['Package downloaded', downloaded, 'Download it in step 8 (a download is not an installation)'],
    ['Agent enrolled', !!deployment?.enrolledAt, 'Waiting for the installed agent to connect'],
    ['First heartbeat', !!deployment?.lastHeartbeatAt, 'No heartbeat received'],
    ['Database initialized and schema verified', false, 'Reported by the agent (Modules 6 & 9)'],
  ];
  return (
    <StepCard
      title="Verify installation"
      description="Live status from the control plane. Nothing here is assumed — each item turns green only when there is evidence for it."
      footer={
        <>
          <RefreshButton label="Refresh status" />
          <ButtonLink href={stepHref(draft.id, 'complete')} variant="primary">Continue <ArrowRight /></ButtonLink>
        </>
      }
    >
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {checks.map(([label, ok, waiting]) => (
          <li key={label} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="flex items-center gap-2.5 text-sm text-slate-800">
              {ok ? <CircleCheck className="size-4 text-emerald-600" aria-hidden="true" /> : <CircleDashed className="size-4 text-slate-400" aria-hidden="true" />}
              {label}
            </span>
            <span className="text-[13px] text-slate-500">{ok ? 'Done' : waiting}</span>
          </li>
        ))}
      </ul>
      {deployment ? (
        <dl className="mt-6 grid gap-3 text-[13px] sm:grid-cols-3">
          <div><dt className="text-slate-500">Health</dt><dd className="mt-1"><HealthPill state={deployment.healthState} /></dd></div>
          <div><dt className="text-slate-500">Last heartbeat</dt><dd className="mt-1 font-medium text-slate-800">{deployment.lastHeartbeatAt ? formatDateTime(deployment.lastHeartbeatAt, timezone) : 'Never'}</dd></div>
          <div><dt className="text-slate-500">Lifecycle</dt><dd className="mt-1"><LifecycleStage state={deployment.lifecycleState} /></dd></div>
        </dl>
      ) : null}
    </StepCard>
  );
}

export function CompleteStep({ draft, deployment }: { draft: OnboardingDraftDto; deployment: DeploymentDetail | null }) {
  const r = draft.result!;
  const done: [string, boolean][] = [
    [`Client ${r.clientCode} created with ${r.contactCount} contact${r.contactCount === 1 ? '' : 's'}`, true],
    [`PSA instance ${r.psaInstanceCode} recorded (connection untested)`, true],
    [`${r.serviceCount} service${r.serviceCount === 1 ? '' : 's'} assigned`, true],
    [`Deployment ${r.deploymentCode} recorded`, true],
    ['Deployment package generated', !!deployment?.currentPackage || !!deployment?.enrolledAt],
    ['Deployment package downloaded', !!deployment?.packageDownloadedAt || !!deployment?.enrolledAt],
    ['Appliance installed, enrolled and healthy', !!deployment?.enrolledAt && deployment.healthState === 'healthy'],
  ];
  return (
    <StepCard
      title="Onboarding record complete"
      description="The client exists in the platform. The installation completes on the client’s host; its real status is always shown on the deployment’s pages."
      footer={
        <>
          <ButtonLink href="/clients/new" variant="ghost">Onboard another client</ButtonLink>
          <ButtonLink href={deployment ? `/deployments/${deployment.id}` : `/clients/${r.clientId}`} variant="primary">{deployment ? 'Open deployment' : 'Open client'} <ArrowRight /></ButtonLink>
        </>
      }
    >
      <ul className="space-y-2.5">
        {done.map(([label, ok]) => (
          <li key={label} className="flex gap-2.5 text-sm">
            {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />}
            <span className={ok ? 'text-slate-800' : 'text-slate-500'}>{label}{ok ? '' : ' — pending'}</span>
          </li>
        ))}
      </ul>
      {deployment ? (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
          <span className="text-[13px] text-slate-600">Current status of {deployment.code}:</span>
          <HealthPill state={deployment.healthState} />
          <LifecycleStage state={deployment.lifecycleState} />
        </div>
      ) : null}
      <h3 className="mb-3 mt-6 text-sm font-semibold text-slate-900">Identifiers</h3>
      <IdTable draft={draft} deployment={deployment} />
    </StepCard>
  );
}
