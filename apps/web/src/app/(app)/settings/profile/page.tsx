import type { Metadata } from 'next';
import { ProfileForm } from '@/components/account/profile-form';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';
import { timeZones } from '@/lib/reference';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const me = await requireActiveSession();
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Profile' }]}
        title="Profile"
        description="How you appear in audit logs, and the time zone used for every timestamp."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Personal details" />
          <CardBody>
            <ProfileForm displayName={me.user.displayName} timezone={me.user.timezone} timezones={timeZones()} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Account" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-slate-500">Email</dt>
                <dd className="font-medium text-slate-800">{me.user.email}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Organization</dt>
                <dd className="font-medium text-slate-800">{me.organization.name}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Roles</dt>
                <dd className="font-medium text-slate-800">{me.roles.map((r) => r.name).join(', ') || 'None'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Client access</dt>
                <dd className="font-medium text-slate-800">{me.clientScope === 'all_clients' ? 'All clients' : 'Assigned clients only'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Last sign-in</dt>
                <dd className="font-medium text-slate-800">{formatDateTime(me.user.lastLoginAt, me.user.timezone)}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
