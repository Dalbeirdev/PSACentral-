/**
 * Permission & role catalog. At runtime the database is the source of truth
 * (roles / role_permissions). This catalog defines the permission keys the code checks
 * and the immutable *system* roles, which the migrator syncs idempotently as reference
 * data after every migration run. Organizations can add custom roles (is_system = false)
 * with any combination of these permissions.
 */

export const PERMISSIONS = {
  'dashboard.read': { category: 'Overview', description: 'View the operations dashboard' },
  'clients.read': { category: 'Clients', description: 'View clients (within client scope)' },
  'clients.write': { category: 'Clients', description: 'Create and edit clients and contacts' },
  'psa.read': { category: 'PSA', description: 'View PSA instances and configuration (no secrets)' },
  'psa.write': { category: 'PSA', description: 'Create and configure PSA instances' },
  'psa.credentials.manage': { category: 'PSA', description: 'Set or rotate PSA credentials' },
  'services.read': { category: 'Services', description: 'View the service catalog' },
  'services.write': { category: 'Services', description: 'Manage the service catalog and assignments' },
  'deployments.read': { category: 'Deployments', description: 'View deployments, packages and images' },
  'deployments.write': { category: 'Deployments', description: 'Create and modify deployments' },
  'deployments.package.generate': { category: 'Deployments', description: 'Generate deployment packages and enrollment tokens' },
  'deployments.commands.issue': { category: 'Deployments', description: 'Issue remote commands to edge agents' },
  'deployments.decommission': { category: 'Deployments', description: 'Decommission deployments (retire their identity) and remove decommissioned records' },
  'database.metadata.read': { category: 'Infrastructure', description: 'View client database metadata (no records)' },
  'health.read': { category: 'Infrastructure', description: 'View health monitoring' },
  'integrations.read': { category: 'Platform', description: 'View integrations' },
  'integrations.manage': { category: 'Platform', description: 'Manage integrations' },
  'licenses.read': { category: 'Platform', description: 'View licenses' },
  'licenses.manage': { category: 'Platform', description: 'Manage licenses' },
  'audit.read': { category: 'Security', description: 'View activity and audit logs' },
  'users.read': { category: 'Security', description: 'View users' },
  'users.manage': { category: 'Security', description: 'Create, edit and disable users' },
  'roles.read': { category: 'Security', description: 'View roles and permissions' },
  'roles.manage': { category: 'Security', description: 'Manage roles; grant privileged roles' },
  'settings.read': { category: 'Platform', description: 'View platform settings' },
  'settings.manage': { category: 'Platform', description: 'Change platform settings' },
  'security.manage': { category: 'Security', description: 'Manage security policies (MFA, sessions)' },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export type ClientScope = 'all_clients' | 'assigned_clients';

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  scope: ClientScope;
  permissions: readonly PermissionKey[];
}

export const SYSTEM_ROLE_KEYS = [
  'super_admin',
  'ops_admin',
  'tech_admin',
  'technician',
  'service_manager',
  'security_admin',
  'auditor',
  'read_only',
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

const ALL = PERMISSION_KEYS;
const READ_CORE = ['dashboard.read', 'clients.read', 'psa.read', 'services.read', 'deployments.read', 'health.read'] as const;

export const SYSTEM_ROLES: Record<SystemRoleKey, SystemRoleDefinition> = {
  super_admin: {
    key: 'super_admin',
    name: 'Super Administrator',
    description: 'Full access to every client and every platform function.',
    scope: 'all_clients',
    permissions: ALL,
  },
  ops_admin: {
    key: 'ops_admin',
    name: 'Operations Administrator',
    description: 'Runs day-to-day onboarding, deployments and user administration.',
    scope: 'all_clients',
    permissions: [
      ...READ_CORE, 'clients.write', 'psa.write', 'services.write', 'deployments.write',
      'deployments.package.generate', 'deployments.decommission', 'database.metadata.read', 'integrations.read', 'integrations.manage',
      'licenses.read', 'licenses.manage', 'audit.read', 'users.read', 'users.manage', 'roles.read',
      'settings.read', 'settings.manage',
    ],
  },
  tech_admin: {
    key: 'tech_admin',
    name: 'Technical Administrator',
    description: 'Owns PSA configuration, deployments, appliances and remote operations.',
    scope: 'all_clients',
    permissions: [
      ...READ_CORE, 'psa.write', 'psa.credentials.manage', 'deployments.write', 'deployments.package.generate',
      'deployments.commands.issue', 'database.metadata.read', 'integrations.read', 'integrations.manage',
      'licenses.read', 'settings.read',
    ],
  },
  technician: {
    key: 'technician',
    name: 'Technician',
    description: 'Works on assigned clients only: views status and generates packages.',
    scope: 'assigned_clients',
    permissions: [...READ_CORE, 'deployments.package.generate', 'database.metadata.read', 'integrations.read'],
  },
  service_manager: {
    key: 'service_manager',
    name: 'Service Manager',
    description: 'Manages client records and the service catalog.',
    scope: 'all_clients',
    permissions: [...READ_CORE, 'clients.write', 'services.write', 'integrations.read', 'licenses.read'],
  },
  security_admin: {
    key: 'security_admin',
    name: 'Security Administrator',
    description: 'Manages security policy and reviews audit activity.',
    scope: 'all_clients',
    permissions: [
      'dashboard.read', 'clients.read', 'deployments.read', 'health.read', 'database.metadata.read',
      'integrations.read', 'audit.read', 'users.read', 'roles.read', 'settings.read', 'security.manage',
    ],
  },
  auditor: {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to everything including audit logs.',
    scope: 'all_clients',
    permissions: [
      ...READ_CORE, 'database.metadata.read', 'integrations.read', 'licenses.read', 'audit.read',
      'users.read', 'roles.read', 'settings.read',
    ],
  },
  read_only: {
    key: 'read_only',
    name: 'Read Only',
    description: 'Views operational status. Cannot change anything.',
    scope: 'all_clients',
    permissions: [...READ_CORE, 'integrations.read', 'licenses.read'],
  },
};
