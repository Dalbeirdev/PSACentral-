import { describe, expect, it } from 'vitest';
import {
  deploymentCreateSchema,
  deploymentListQuerySchema,
  deploymentUpdateSchema,
  EDGE_REPORT_TYPES,
  LIFECYCLE_LABELS,
  DEPLOYMENT_LIFECYCLE_STATES,
  packageGenerateSchema,
  packageRevokeSchema,
} from './index.js';

const base = {
  clientId: '7d3b0c8e-4b69-4d0f-9a3f-6c0d5d2c1a11',
  psaInstanceId: '8e4c1d9f-5c7a-4e1f-8b4a-7d1e6e3d2b22',
  targetEnvironment: 'linux_docker',
  targetOs: 'linux',
  targetArch: 'amd64',
};

describe('deployment schemas', () => {
  it('create: OS must match fixed-OS environments; host labels are restricted; unknown fields rejected', () => {
    expect(deploymentCreateSchema.safeParse(base).success).toBe(true);
    expect(deploymentCreateSchema.safeParse({ ...base, targetOs: 'windows' }).error?.issues[0]?.path).toEqual(['targetOs']);
    expect(deploymentCreateSchema.safeParse({ ...base, targetEnvironment: 'cloud_vm', targetOs: 'windows' }).success).toBe(true);
    expect(deploymentCreateSchema.parse({ ...base, hostLabel: '' }).hostLabel).toBeUndefined();
    expect(deploymentCreateSchema.safeParse({ ...base, hostLabel: 'edge; rm -rf /' }).success).toBe(false);
    expect(deploymentCreateSchema.safeParse({ ...base, installationId: base.clientId }).success).toBe(false);
  });

  it('update requires the version token', () => {
    const { clientId: _c, ...rest } = base;
    expect(deploymentUpdateSchema.safeParse(rest).success).toBe(false);
    expect(deploymentUpdateSchema.safeParse({ ...rest, version: '1760443200000000' }).success).toBe(true);
  });

  it('package generation: short-lived tokens only (1, 4, 24 or 72 hours), 24 by default; no replacement unless asked', () => {
    expect(packageGenerateSchema.parse({})).toEqual({ tokenValidityHours: 24, replaceExisting: false });
    for (const h of [1, 4, 24, 72]) expect(packageGenerateSchema.safeParse({ tokenValidityHours: h }).success).toBe(true);
    for (const h of [0, 2, 48, 73, 168, '24']) expect(packageGenerateSchema.safeParse({ tokenValidityHours: h }).success, String(h)).toBe(false);
    expect(packageGenerateSchema.safeParse({ token: 'x' }).success).toBe(false);
  });

  it('revoke needs a reason of 3–200 characters', () => {
    expect(packageRevokeSchema.safeParse({ reason: 'ok' }).success).toBe(false);
    expect(packageRevokeSchema.safeParse({ reason: '  leaked  ' }).data?.reason).toBe('leaked');
    expect(packageRevokeSchema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
  });

  it('list query: known lifecycle/health/environment values and safe sort keys only', () => {
    expect(deploymentListQuerySchema.parse({ page: '2' }).page).toBe(2);
    expect(deploymentListQuerySchema.safeParse({ lifecycle: 'installed' }).success).toBe(false);
    expect(deploymentListQuerySchema.safeParse({ sort: 'code;drop:asc' }).success).toBe(false);
    expect(deploymentListQuerySchema.safeParse({ sort: 'lifecycle:desc' }).success).toBe(true);
  });

  it('every lifecycle state has a label, and the allowed edge report types match the data boundary', () => {
    expect(Object.keys(LIFECYCLE_LABELS).sort()).toEqual([...DEPLOYMENT_LIFECYCLE_STATES].sort());
    expect(LIFECYCLE_LABELS.package_downloaded).not.toMatch(/install/i);
    expect(EDGE_REPORT_TYPES).toHaveLength(10);
    expect(EDGE_REPORT_TYPES).toContain('database_schema');
    expect(EDGE_REPORT_TYPES.join(' ')).not.toMatch(/ticket_content|credential_value/);
  });
});
