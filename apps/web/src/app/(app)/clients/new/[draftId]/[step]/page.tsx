import type { DeploymentDetail, OnboardingDraftDto, ServiceDto, UserRef } from '@psacc/contracts';
import { ONBOARDING_STEPS } from '@psacc/contracts';
import { ArchiveX } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ClientStep, DeploymentStep, PsaConfigStep, ProviderStep, type ProviderOption, ServicesStep } from '@/components/onboarding/data-steps';
import { CreateStep } from '@/components/onboarding/create-step';
import { CompleteStep, DownloadStep, ReviewStep, VerifyStep } from '@/components/onboarding/summary-steps';
import { WizardFrame } from '@/components/onboarding/wizard-frame';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { referenceLists } from '@/lib/reference';
import { availability, firstIncomplete, isStepKey, stepHref } from '@/lib/wizard';

export const metadata: Metadata = { title: 'Onboard client' };

const COMPLETE_PERMISSIONS = ['clients.write', 'psa.write', 'deployments.write'];

export default async function WizardStepPage({ params }: { params: Promise<{ draftId: string; step: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'clients.write')) notFound();
  const { draftId, step } = await params;
  if (!isStepKey(step) || !/^[0-9a-f-]{36}$/i.test(draftId)) notFound();

  const res = await apiGet<OnboardingDraftDto>(`/onboarding/drafts/${draftId}`);
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) {
    return (
      <>
        <PageHeader breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Onboard client', href: '/clients/new' }]} title="Onboarding" />
        <Card><ErrorState problem={res.problem} /></Card>
      </>
    );
  }
  const draft = res.data;

  if (draft.status === 'abandoned') {
    return (
      <>
        <PageHeader breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Onboard client', href: '/clients/new' }]} title="Onboarding abandoned" />
        <Card>
          <EmptyState icon={<ArchiveX />} title="This onboarding was abandoned" description="It is kept for the audit trail and can no longer be edited." action={<ButtonLink href="/clients/new" variant="primary">Start a new onboarding</ButtonLink>} />
        </Card>
      </>
    );
  }

  const a = availability(draft, step, step);
  if (a === 'locked' || (draft.status === 'completed' && a === 'done')) {
    redirect(stepHref(draftId, draft.status === 'completed' ? 'download' : firstIncomplete(draft)));
  }

  const needsProviders = ['psa-provider', 'psa-config', 'review', 'create'].includes(step);
  const needsServices = ['services', 'review'].includes(step);
  const needsUsers = ['client', 'review'].includes(step);
  const [providers, services, users, deployments] = await Promise.all([
    needsProviders ? apiGet<ProviderOption[]>('/psa-providers') : null,
    needsServices ? apiGet<ServiceDto[]>('/services?status=active') : null,
    needsUsers ? apiGet<UserRef[]>('/directory/users') : null,
    draft.result && can(me, 'deployments.read') ? apiGet<DeploymentDetail>(`/deployments/${draft.result.deploymentId}`) : null,
  ]);
  for (const r of [providers, services, users]) {
    if (r && !r.ok) return <Card><ErrorState problem={r.problem} /></Card>;
  }
  const providerList = providers?.ok ? providers.data : [];
  const deployment = deployments?.ok ? deployments.data : null;
  const common = { draftId: draft.id, version: draft.version };
  const providerKey = draft.data['psa-provider']?.providerKey;
  const provider = providerList.find((p) => p.key === providerKey);

  let body;
  switch (step) {
    case 'client':
      body = <ClientStep {...common} initial={draft.data.client} users={users?.ok ? users.data : []} lists={referenceLists()} />;
      break;
    case 'psa-provider':
      body = <ProviderStep {...common} initial={draft.data['psa-provider']} providers={providerList} configured={draft.completedSteps.includes('psa-config')} />;
      break;
    case 'psa-config':
      if (!provider) redirect(stepHref(draftId, 'psa-provider'));
      body = <PsaConfigStep {...common} initial={draft.data['psa-config']} provider={provider} clientName={draft.data.client?.company.displayName ?? 'Client'} />;
      break;
    case 'services':
      body = <ServicesStep {...common} initial={draft.data.services} services={services?.ok ? services.data : []} />;
      break;
    case 'deployment':
      body = <DeploymentStep {...common} initial={draft.data.deployment} />;
      break;
    case 'review':
      body = <ReviewStep draft={draft} providers={providerList} services={services?.ok ? services.data : []} users={users?.ok ? users.data : []} />;
      break;
    case 'create':
      body = (
        <CreateStep
          {...common}
          clientName={draft.data.client?.company.displayName ?? 'the client'}
          contactCount={draft.data.client?.contacts.length ?? 0}
          serviceCount={draft.data.services?.serviceIds.length ?? 0}
          providerName={provider?.name ?? 'PSA'}
          missingPermissions={COMPLETE_PERMISSIONS.filter((p) => !can(me, p))}
        />
      );
      break;
    case 'download':
      body = <DownloadStep draft={draft} deployment={deployment} canGenerate={can(me, 'deployments.package.generate')} timezone={me.user.timezone} />;
      break;
    case 'verify':
      body = <VerifyStep draft={draft} deployment={deployment} timezone={me.user.timezone} />;
      break;
    case 'complete':
      body = <CompleteStep draft={draft} deployment={deployment} />;
      break;
  }

  return (
    <WizardFrame draft={draft} step={step} timezone={me.user.timezone}>
      <h2 className="sr-only">{ONBOARDING_STEPS.find((s) => s.key === step)!.title}</h2>
      {body}
    </WizardFrame>
  );
}
