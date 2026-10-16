import { ShieldCheck, ShieldOff } from 'lucide-react';
import type { Metadata } from 'next';
import { MfaDisable } from '@/components/account/mfa-disable';
import { MfaEnrollment } from '@/components/account/mfa-enrollment';
import { PasswordChangeForm } from '@/components/account/password-change-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Security' };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  const { mfa } = await searchParams;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Security' }]}
        title="Security"
        description={`Session expires after inactivity at ${formatDateTime(me.session.idleExpiresAt, me.user.timezone)} (sliding) and no later than ${formatDateTime(me.session.absoluteExpiresAt, me.user.timezone)}.`}
      />
      {mfa === 'enabled' ? <Alert variant="success" className="mb-4">Two-step verification is enabled. Other sessions were signed out.</Alert> : null}
      {mfa === 'disabled' ? <Alert variant="warning" className="mb-4">Two-step verification is turned off.</Alert> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Two-step verification"
            description="Authenticator-app codes (TOTP) protect your account if your password is exposed."
            actions={
              me.user.mfaEnabled ? (
                <Badge tone="emerald">
                  <ShieldCheck /> On
                </Badge>
              ) : (
                <Badge tone="amber">
                  <ShieldOff /> Off
                </Badge>
              )
            }
          />
          <CardBody>
            {me.user.mfaEnabled ? (
              me.flags.mfaRequired ? (
                <p className="text-sm leading-6 text-slate-600">Two-step verification is required by policy in this environment and cannot be turned off.</p>
              ) : (
                <MfaDisable />
              )
            ) : (
              <MfaEnrollment mode="settings" />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Password" description="Changing your password signs out all of your other sessions." />
          <CardBody>
            <PasswordChangeForm email={me.user.email} mode="settings" />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
