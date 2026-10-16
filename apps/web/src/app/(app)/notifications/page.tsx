import type { NotificationsResponse } from '@psacc/contracts';
import { BellOff, OctagonAlert, TriangleAlert, Info } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RefreshButton } from '@/components/refresh-button';
import { Badge, SyntheticBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { apiGet, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Notifications' };

const SEV = {
  critical: { icon: OctagonAlert, cls: 'bg-red-50 text-red-600 ring-red-100', label: 'Critical', tone: 'red' as const },
  warning: { icon: TriangleAlert, cls: 'bg-amber-50 text-amber-600 ring-amber-100', label: 'Warning', tone: 'amber' as const },
  info: { icon: Info, cls: 'bg-blue-50 text-blue-600 ring-blue-100', label: 'Info', tone: 'blue' as const },
};

export default async function NotificationsPage() {
  const me = await requireActiveSession();
  const result = await apiGet<NotificationsResponse>('/notifications');
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Notifications' }]}
        title="Notifications"
        description="Deployments that need attention and notices about your own account. Derived live from current records, so nothing is pushed or dismissed."
        actions={<RefreshButton />}
      />
      {!result.ok ? (
        <Card><ErrorState problem={result.problem} /></Card>
      ) : result.data.items.length === 0 ? (
        <Card><EmptyState icon={<BellOff />} title="All clear" description="No deployment needs attention right now." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap gap-2 border-b border-slate-100 px-5 py-3 sm:px-6">
            <Badge tone="red">{result.data.counts.critical} critical</Badge>
            <Badge tone="amber">{result.data.counts.warning} warning</Badge>
          </div>
          <ul className="divide-y divide-slate-100">
            {result.data.items.map((n) => {
              const s = SEV[n.severity];
              return (
                <li key={n.id}>
                  <Link href={n.href} className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-slate-50 sm:px-6">
                    <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${s.cls}`}>
                      <s.icon className="size-[18px]" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{n.title}</span>
                        <span className="sr-only">Severity: {s.label}</span>
                        {n.isSynthetic ? <SyntheticBadge /> : null}
                      </span>
                      <span className="mt-0.5 block text-[13px] leading-5 text-slate-500">{n.detail}</span>
                    </span>
                    {n.occurredAt ? (
                      <span className="hidden shrink-0 text-xs text-slate-500 sm:block">{n.isSynthetic ? 'synthetic' : formatDateTime(n.occurredAt, me.user.timezone)}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
