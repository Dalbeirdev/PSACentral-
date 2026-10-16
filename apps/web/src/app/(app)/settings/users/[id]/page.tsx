import type { ClientSummary, Paged, RoleSummary, UserDetail } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Badge, SyntheticBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';
import { ClientAssignments } from './client-assignments';
import { UserEditForm } from './user-edit-form';

export const metadata: Metadata = { title: 'User' };

export default async function UserDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'users.read')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { saved } = await searchParams;
  const [user, roles, clients] = await Promise.all([
    apiGet<UserDetail>(`/users/${id}`),
    can(me, 'roles.read') ? apiGet<RoleSummary[]>('/roles') : Promise.resolve(null),
    can(me, 'clients.read') ? apiGet<Paged<ClientSummary>>('/clients?pageSize=100&sort=displayName:asc') : Promise.resolve(null),
  ]);
  if (!user.ok && user.status === 404) notFound();

  const crumbs = [{ label: 'Settings', href: '/settings' }, { label: 'Users', href: '/settings/users' }, { label: user.ok ? user.data.displayName : 'User' }];
  if (!user.ok) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title="User" />
        <Card><ErrorState problem={user.problem} /></Card>
      </>
    );
  }
  const u = user.data;
  const tz = me.user.timezone;
  const isSelf = u.id === me.user.id;
  const canManage = can(me, 'users.manage') && !isSelf;

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {u.displayName}
            {u.isSynthetic ? <SyntheticBadge /> : null}
          </span>
        }
        description={u.email}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Access" description={isSelf ? 'You cannot change your own roles or status. Ask another administrator.' : 'Changes take effect immediately and sign the user out of existing sessions.'} />
          <CardBody>
            <UserEditForm
              user={{ id: u.id, displayName: u.displayName, status: u.status === 'locked' ? 'active' : u.status, roleKeys: u.roles.map((r) => r.key) }}
              roles={roles?.ok ? roles.data.map((r) => ({ key: r.key, name: r.name, description: r.description, scope: r.scope })) : u.roles.map((r) => ({ ...r, description: '', scope: 'all_clients' as const }))}
              canManage={canManage}
              canGrantPrivileged={can(me, 'roles.manage')}
              saved={saved === '1'}
            />
          </CardBody>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Account" />
            <CardBody>
              <dl className="space-y-3 text-sm">
                <div><dt className="text-slate-500">Status</dt><dd className="mt-0.5">{u.status === 'active' ? <Badge tone="emerald">Active</Badge> : u.status === 'locked' ? <Badge tone="amber">Temporarily locked</Badge> : <Badge>Disabled</Badge>}</dd></div>
                <div><dt className="text-slate-500">Two-step verification</dt><dd className="font-medium text-slate-800">{u.mfaEnabled ? 'Enabled' : 'Not enabled'}</dd></div>
                <div><dt className="text-slate-500">Sign-in method</dt><dd className="font-medium text-slate-800">{u.authProvider === 'local' ? 'Password' : 'Single sign-on (OIDC)'}</dd></div>
                <div><dt className="text-slate-500">Time zone</dt><dd className="font-medium text-slate-800">{u.timezone}</dd></div>
                <div><dt className="text-slate-500">Last sign-in</dt><dd className="font-medium text-slate-800">{formatDateTime(u.lastLoginAt, tz)}</dd></div>
                <div><dt className="text-slate-500">Created</dt><dd className="font-medium text-slate-800">{formatDateTime(u.createdAt, tz)}</dd></div>
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Client access" description={u.clientScope === 'all_clients' ? 'Has an all-clients role.' : 'Limited to assigned clients.'} />
            <CardBody>
              {clients?.ok ? (
                <ClientAssignments
                  userId={u.id}
                  clients={clients.data.items.map((c) => ({ id: c.id, code: c.code, displayName: c.displayName }))}
                  assigned={u.assignedClients.map((c) => c.id)}
                  canManage={can(me, 'users.manage')}
                  scopeAll={u.clientScope === 'all_clients'}
                />
              ) : u.assignedClients.length ? (
                <ul className="space-y-1.5 text-sm text-slate-700">{u.assignedClients.map((c) => <li key={c.id}>{c.displayName} <span className="font-mono text-slate-500">{c.code}</span></li>)}</ul>
              ) : (
                <p className="text-sm text-slate-500">{u.clientScope === 'all_clients' ? 'All clients in the organization.' : 'No clients assigned.'}</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
