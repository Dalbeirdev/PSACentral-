import type { ClientDetail } from '@psacc/contracts';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { apiGet } from './api-server';

/** Client detail for this request, shared by the client layout and its pages (one API call). */
export const getClient = cache(async (id: string): Promise<ClientDetail> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const r = await apiGet<ClientDetail>(`/clients/${id}`);
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) notFound();
    throw new Error(r.problem.detail ?? 'Client could not be loaded');
  }
  return r.data;
});
