import type { ReactNode } from 'react';
import { can, requireActiveSession } from '@/lib/api-server';
import { SettingsNav } from './settings-nav';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const me = await requireActiveSession();
  const items = [
    { href: '/settings', label: 'Overview' },
    { href: '/settings/profile', label: 'Profile' },
    { href: '/settings/security', label: 'Security' },
    ...(can(me, 'users.read') ? [{ href: '/settings/users', label: 'Users' }] : []),
    ...(can(me, 'roles.read') ? [{ href: '/settings/roles', label: 'Roles & permissions' }] : []),
    ...(can(me, 'settings.manage') ? [{ href: '/settings/health', label: 'Health policy' }, { href: '/settings/retention', label: 'Data retention' }] : []),
  ];
  return (
    <>
      <SettingsNav items={items} />
      {children}
    </>
  );
}
