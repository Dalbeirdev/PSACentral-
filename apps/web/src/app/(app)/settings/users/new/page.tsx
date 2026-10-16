import type { RoleSummary } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { CreateUserForm } from './create-user-form';

export const metadata: Metadata = { title: 'New user' };

export default async function NewUserPage() {
  const me = await requireActiveSession();
  if (!can(me, 'users.manage')) notFound();
  const roles = await apiGet<RoleSummary[]>('/roles');
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Users', href: '/settings/users' }, { label: 'New user' }]}
        title="New user"
        description="The user signs in with a temporary password and must replace it at first sign-in."
      />
      <Card className="max-w-3xl">
        <CardBody className="sm:p-8">
          {roles.ok ? (
            <CreateUserForm
              roles={roles.data.map((r) => ({ key: r.key, name: r.name, description: r.description, scope: r.scope }))}
              canGrantPrivileged={can(me, 'roles.manage')}
              defaultTimezone={me.user.timezone}
            />
          ) : (
            <ErrorState problem={roles.problem} title="Roles could not be loaded" />
          )}
        </CardBody>
      </Card>
    </>
  );
}
