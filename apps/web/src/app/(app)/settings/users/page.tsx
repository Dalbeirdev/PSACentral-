import type { Paged, RoleSummary, UserSummary } from '@psacc/contracts';
import { Funnel, Lock, ShieldCheck, ShieldOff, UserPlus, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, SyntheticBadge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Pagination, SortTh, Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, initials, relativeTime } from '@/lib/format';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'Users' };

const KEYS = ['q', 'status', 'role', 'page', 'sort'] as const;

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'users.read')) notFound();
  const params = pickParams(await searchParams, KEYS);
  const [result, roles] = await Promise.all([
    apiGet<Paged<UserSummary>>(hrefWith('/users', params, { pageSize: 20 })),
    can(me, 'roles.read') ? apiGet<RoleSummary[]>('/roles') : Promise.resolve(null),
  ]);
  const href = (changes: Record<string, string | number | undefined>) => hrefWith('/settings/users', params, changes);
  const filtered = !!(params.q || params.status || params.role);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Users' }]}
        title="Users"
        description="People who can sign in to the control plane. Roles decide what they can do; technicians only see assigned clients."
        actions={
          can(me, 'users.manage') ? (
            <ButtonLink href="/settings/users/new" variant="primary">
              <UserPlus /> New user
            </ButtonLink>
          ) : null
        }
      />

      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter users">
          <div className="min-w-56 flex-1">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Name or email" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          <div>
            <label htmlFor="status" className="mb-1.5 block text-xs font-medium text-slate-500">Status</label>
            <select id="status" name="status" defaultValue={params.status ?? ''} className="h-9 rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm">
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          {roles?.ok ? (
            <div>
              <label htmlFor="role" className="mb-1.5 block text-xs font-medium text-slate-500">Role</label>
              <select id="role" name="role" defaultValue={params.role ?? ''} className="h-9 rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm">
                <option value="">Any role</option>
                {roles.data.map((r) => (
                  <option key={r.key} value={r.key}>{r.name}</option>
                ))}
              </select>
            </div>
          ) : null}
          {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
          <Button type="submit" variant="secondary">
            <Funnel /> Apply
          </Button>
          {filtered ? (
            <Link href="/settings/users" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">
              Clear
            </Link>
          ) : null}
        </form>

        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : result.data.items.length === 0 ? (
          <EmptyState icon={<Users />} title={filtered ? 'No users match these filters' : 'No users yet'} description={filtered ? 'Try a different search or clear the filters.' : undefined} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <SortTh field="displayName" label="User" current={params.sort ?? 'displayName:asc'} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <Th>Roles</Th>
                  <Th>Status</Th>
                  <Th>MFA</Th>
                  <SortTh field="lastLoginAt" label="Last sign-in" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((u) => (
                  <Tr key={u.id}>
                    <Td>
                      <Link href={`/settings/users/${u.id}`} className="group flex items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">{initials(u.displayName)}</span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium text-slate-900 group-hover:text-blue-700">{u.displayName}</span>
                            {u.id === me.user.id ? <Badge tone="blue" className="h-5 px-1.5 text-[11px]">You</Badge> : null}
                            {u.isSynthetic ? <SyntheticBadge /> : null}
                          </span>
                          <span className="block truncate text-[12.5px] text-slate-500">{u.email}</span>
                        </span>
                      </Link>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <Badge key={r.key} tone={r.key === 'super_admin' ? 'violet' : 'neutral'}>{r.name}</Badge>
                        ))}
                      </div>
                    </Td>
                    <Td>
                      {u.status === 'active' ? <Badge tone="emerald">Active</Badge> : u.status === 'locked' ? <Badge tone="amber"><Lock /> Locked</Badge> : <Badge>Disabled</Badge>}
                    </Td>
                    <Td>
                      {u.mfaEnabled ? (
                        <span className="inline-flex items-center gap-1 text-[13px] text-emerald-700"><ShieldCheck className="size-4" aria-hidden="true" /> On</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[13px] text-slate-500"><ShieldOff className="size-4" aria-hidden="true" /> Off</span>
                      )}
                    </Td>
                    <Td className="text-[13px] text-slate-500">
                      {u.lastLoginAt ? <span title={formatDateTime(u.lastLoginAt, me.user.timezone)}>{relativeTime(u.lastLoginAt)}</span> : 'Never'}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} hrefFor={(p) => href({ page: p })} label="users" />
          </>
        )}
      </Card>
    </>
  );
}
