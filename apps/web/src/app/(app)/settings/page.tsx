import { CircleCheck, CircleDashed, Database, KeyRound, ShieldCheck, UserRound, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, humanize } from '@/lib/format';

export const metadata: Metadata = { title: 'Settings' };

interface SystemStatus {
  environment: string;
  version: string;
  database: { status: string; latencyMs: number; serverVersion: string | null; name: string | null; size: string | null };
  migrations: { version: string; name: string; appliedAt: string | null; state: string }[];
  security: { mfaRequired: boolean; sessionIdleMinutes: number; sessionAbsoluteHours: number; secureCookies: boolean; loginMaxFailures: number; loginLockMinutes: number };
}

function Shortcut({ href, icon, title, text }: { href: string; icon: ReactNode; title: string; text: string }) {
  return (
    <Link href={href} className="group flex gap-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card transition-shadow hover:shadow-card-hover">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 ring-1 ring-blue-100 [&_svg]:size-5">{icon}</span>
      <span>
        <span className="block text-sm font-semibold text-slate-900 group-hover:text-blue-700">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-5 text-slate-500">{text}</span>
      </span>
    </Link>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{children}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  const me = await requireActiveSession();
  const status = can(me, 'settings.read') ? await apiGet<SystemStatus>('/system/status') : null;

  return (
    <>
      <PageHeader title="Settings" description="Your account, platform users and roles, and control plane status." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Shortcut href="/settings/profile" icon={<UserRound />} title="Profile" text="Display name and preferred time zone." />
        <Shortcut href="/settings/security" icon={<ShieldCheck />} title="Security" text="Password and two-step verification." />
        {can(me, 'users.read') ? <Shortcut href="/settings/users" icon={<Users />} title="Users" text="Create users, assign roles, disable access." /> : null}
        {can(me, 'roles.read') ? <Shortcut href="/settings/roles" icon={<KeyRound />} title="Roles & permissions" text="What each role is allowed to do." /> : null}
      </div>

      {status?.ok ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader icon={<Database />} title="Control plane database" description="Live check from the API at page load" />
            <CardBody>
              <dl className="divide-y divide-slate-100">
                <Row label="Connection">
                  <Badge tone={status.data.database.status === 'up' ? 'emerald' : 'red'}>
                    {status.data.database.status === 'up' ? <CircleCheck /> : null}
                    {status.data.database.status === 'up' ? `Up · ${status.data.database.latencyMs} ms` : 'Down'}
                  </Badge>
                </Row>
                <Row label="Database">{status.data.database.name ?? '—'}</Row>
                <Row label="PostgreSQL">{status.data.database.serverVersion ?? '—'}</Row>
                <Row label="Size">{status.data.database.size ?? '—'}</Row>
                <Row label="Environment">{humanize(status.data.environment)} · v{status.data.version}</Row>
              </dl>
              <p className="mb-2 mt-5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">Schema migrations</p>
              <ul className="space-y-2">
                {status.data.migrations.map((m) => (
                  <li key={m.version} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-[13px] ring-1 ring-slate-200/70">
                    <span className="flex items-center gap-2">
                      {m.state === 'applied' ? <CircleCheck className="size-4 text-emerald-600" aria-hidden="true" /> : <CircleDashed className="size-4 text-amber-600" aria-hidden="true" />}
                      <span className="font-mono text-slate-800">
                        {m.version}_{m.name}
                      </span>
                    </span>
                    <span className="text-slate-500">{m.appliedAt ? formatDateTime(m.appliedAt, me.user.timezone) : humanize(m.state)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader icon={<ShieldCheck />} title="Security policy" description="Effective configuration (set per environment)" />
            <CardBody>
              <dl className="divide-y divide-slate-100">
                <Row label="Two-step verification">{status.data.security.mfaRequired ? <Badge tone="emerald">Required</Badge> : <Badge tone="amber">Optional (development)</Badge>}</Row>
                <Row label="Idle session timeout">{status.data.security.sessionIdleMinutes} minutes</Row>
                <Row label="Absolute session lifetime">{status.data.security.sessionAbsoluteHours} hours</Row>
                <Row label="Account lockout">
                  {status.data.security.loginMaxFailures} failures → {status.data.security.loginLockMinutes} min
                </Row>
                <Row label="Secure cookies">{status.data.security.secureCookies ? 'Yes (HTTPS, __Host- prefix)' : 'No (local HTTP development)'}</Row>
              </dl>
            </CardBody>
          </Card>
        </div>
      ) : null}
    </>
  );
}
