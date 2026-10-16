'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiMutate } from '@/lib/api-client';

interface ClientOption {
  id: string;
  code: string;
  displayName: string;
}

/** Edits which clients a scoped user may access. Enforced by row-level security on every query. */
export function ClientAssignments({ userId, clients, assigned, canManage, scopeAll }: { userId: string; clients: ClientOption[]; assigned: string[]; canManage: boolean; scopeAll: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState(assigned);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? clients.filter((c) => c.displayName.toLowerCase().includes(f) || c.code.toLowerCase().includes(f)) : clients;
  }, [clients, filter]);
  const dirty = [...selected].sort().join() !== [...assigned].sort().join();

  async function save() {
    setBusy(true);
    setMessage(null);
    const r = await apiMutate('PUT', `/users/${userId}/client-assignments`, { clientIds: selected });
    setBusy(false);
    if (!r.ok) return setMessage({ ok: false, text: r.problem.detail ?? 'Assignments could not be saved.' });
    setMessage({ ok: true, text: `Saved. ${selected.length} client${selected.length === 1 ? '' : 's'} assigned.` });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {scopeAll ? <Alert variant="info">This user has an all-clients role, so assignments have no effect until that role is removed.</Alert> : null}
      {message ? <Alert variant={message.ok ? 'success' : 'error'}>{message.text}</Alert> : null}
      <label htmlFor="client-filter" className="sr-only">Filter clients</label>
      <input
        id="client-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter clients…"
        className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10"
      />
      <ul className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2" aria-label="Clients">
        {shown.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
              <input
                type="checkbox"
                className="size-4 accent-blue-600"
                disabled={!canManage}
                checked={selected.includes(c.id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id)))}
              />
              <span className="flex-1 truncate text-slate-800">{c.displayName}</span>
              <span className="font-mono text-[12px] text-slate-500">{c.code}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 ? <li className="px-2 py-1.5 text-sm text-slate-500">No clients match.</li> : null}
      </ul>
      {canManage ? (
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} loading={busy} disabled={!dirty}>Save assignments</Button>
          <span className="text-[12.5px] text-slate-500">{selected.length} selected</span>
        </div>
      ) : null}
    </div>
  );
}
