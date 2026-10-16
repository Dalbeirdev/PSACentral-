import type { DeploymentDetail } from '@psacc/contracts';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { apiGet } from './api-server';

/** Deployment detail for this request, shared by the deployment layout and its pages (one API call). */
export const getDeployment = cache(async (id: string): Promise<DeploymentDetail> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const r = await apiGet<DeploymentDetail>(`/deployments/${id}`);
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) notFound();
    throw new Error(r.problem.detail ?? 'Deployment could not be loaded');
  }
  return r.data;
});

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
