import type { PermissionKey } from '@psacc/contracts';

export type NavIconName =
  | 'overview' | 'clients' | 'psa' | 'services' | 'deployments' | 'images' | 'database'
  | 'health' | 'integrations' | 'licenses' | 'audit' | 'settings';

export interface NavItem {
  label: string;
  href: string;
  icon: NavIconName;
  /** Hidden when the user lacks it (the API enforces independently). null = any signed-in user. */
  permission: PermissionKey | null;
  /** Module that delivers the page. Items for modules not yet built show a "planned" marker. */
  module: number;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

/** Modules whose pages are implemented in this build. */
export const DELIVERED_MODULES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

export const NAV: NavGroup[] = [
  { label: null, items: [{ label: 'Overview', href: '/dashboard', icon: 'overview', permission: 'dashboard.read', module: 1 }] },
  {
    label: 'Operate',
    items: [
      { label: 'Clients', href: '/clients', icon: 'clients', permission: 'clients.read', module: 2 },
      { label: 'PSA Management', href: '/psa', icon: 'psa', permission: 'psa.read', module: 3 },
      { label: 'Service Catalog', href: '/services', icon: 'services', permission: 'services.read', module: 4 },
      { label: 'Deployments', href: '/deployments', icon: 'deployments', permission: 'deployments.read', module: 5 },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Docker Images', href: '/docker-images', icon: 'images', permission: 'deployments.read', module: 6 },
      { label: 'Database Explorer', href: '/database-explorer', icon: 'database', permission: 'database.metadata.read', module: 9 },
      { label: 'Health Monitoring', href: '/monitoring', icon: 'health', permission: 'health.read', module: 8 },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Integrations', href: '/integrations', icon: 'integrations', permission: 'integrations.read', module: 11 },
      { label: 'Licenses', href: '/licenses', icon: 'licenses', permission: 'licenses.read', module: 14 },
      { label: 'Activity & Audit Logs', href: '/audit', icon: 'audit', permission: 'audit.read', module: 1 },
      { label: 'Settings', href: '/settings', icon: 'settings', permission: null, module: 1 },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV.flatMap((g) => g.items);

/** Title shown in the top bar for a pathname: the owning nav item, else a known extra page. */
export function sectionFor(pathname: string): string {
  const item = ALL_NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  if (item) return item.label;
  if (pathname.startsWith('/search')) return 'Search';
  if (pathname.startsWith('/notifications')) return 'Notifications';
  return 'PSA Control Center';
}

export interface PlannedModuleInfo {
  module: number;
  title: string;
  summary: string;
  capabilities: string[];
}

export const PLANNED: Record<string, PlannedModuleInfo> = {};
