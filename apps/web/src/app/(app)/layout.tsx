import type { NotificationsResponse } from '@psacc/contracts';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { apiFetch, getSystemInfo, requireActiveSession } from '@/lib/api-server';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await requireActiveSession();
  const [info, notifications] = await Promise.all([getSystemInfo(), apiFetch<NotificationsResponse>('/notifications')]);
  const count = notifications.ok ? notifications.data.counts.critical + notifications.data.counts.warning : 0;
  return (
    <AppShell
      user={{
        displayName: me.user.displayName,
        email: me.user.email,
        organizationName: me.organization.name,
        roleNames: me.roles.map((r) => r.name),
        permissions: me.permissions,
        clientScope: me.clientScope,
      }}
      env={info?.environment ?? null}
      version={info?.version ?? null}
      notificationCount={count}
    >
      {children}
    </AppShell>
  );
}
