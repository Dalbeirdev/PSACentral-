import type { OnboardingDraftSummary } from '@psacc/contracts';
import { ONBOARDING_STEPS } from '@psacc/contracts';
import { ClipboardList } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, relativeTime } from '@/lib/format';
import { AbandonDraft, StartOnboarding } from './draft-actions';

export const metadata: Metadata = { title: 'Onboard a client' };

const STEPS_INCLUDED = [
  'Client and contact details',
  'PSA provider and instance details',
  'Services (Help Desk selected by default)',
  'Deployment environment and architecture',
  'Review, then create the client and its deployment record',
];

export default async function NewClientPage() {
  const me = await requireActiveSession();
  if (!can(me, 'clients.write')) notFound();
  const drafts = await apiGet<OnboardingDraftSummary[]>('/onboarding/drafts');
  const stepTitle = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.key, `${s.number}. ${s.title}`]));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Onboard client' }]}
        title="Onboard a client"
        description="A guided, full-page wizard. Progress is saved on the server after every step, so you or a colleague can resume at any time."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Card>
          <CardHeader title="Start a new onboarding" description="About 10 minutes. Nothing is created until you confirm in step 7." />
          <CardBody>
            <ol className="space-y-2.5 text-sm text-slate-700">
              {STEPS_INCLUDED.map((s, i) => (
                <li key={s} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700 ring-1 ring-blue-100">{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[13px] leading-5 text-slate-500">
              PSA credentials are never entered here. They are configured on the client’s appliance later.
            </p>
            <div className="mt-6">
              <StartOnboarding />
            </div>
          </CardBody>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="In progress" description="Drafts are shared with everyone in your organization who can manage clients." className="pb-4" />
          {!drafts.ok ? (
            <ErrorState problem={drafts.problem} />
          ) : drafts.data.length === 0 ? (
            <EmptyState icon={<ClipboardList />} title="No onboardings in progress" description="Drafts you start appear here until they are completed or abandoned." />
          ) : (
            <Table className="min-w-[560px]">
              <thead>
                <tr>
                  <Th>Client</Th>
                  <Th>Next step</Th>
                  <Th>Last saved</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {drafts.data.map((d) => (
                  <Tr key={d.id}>
                    <Td>
                      <Link href={`/clients/new/${d.id}/${d.currentStep}`} className="font-semibold text-slate-900 hover:text-blue-700">
                        {d.clientName ?? 'Untitled draft'}
                      </Link>
                      <span className="block text-[12.5px] text-slate-500">Started by {d.createdBy} · {d.completedSteps.length} of 5 sections saved</span>
                    </Td>
                    <Td className="text-[13px]">{stepTitle[d.currentStep]}</Td>
                    <Td className="text-[13px] text-slate-600" title={formatDateTime(d.updatedAt, me.user.timezone)}>{relativeTime(d.updatedAt)}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-2">
                        <Link href={`/clients/new/${d.id}/${d.currentStep}`} className="inline-flex h-8 items-center rounded-lg bg-blue-50 px-3 text-[13px] font-medium text-blue-700 hover:bg-blue-100">
                          Resume
                        </Link>
                        <AbandonDraft id={d.id} name={d.clientName ?? 'this draft'} />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
