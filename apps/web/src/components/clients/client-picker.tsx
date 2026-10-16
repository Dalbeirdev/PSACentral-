'use client';

import type { ClientSummary, Paged } from '@psacc/contracts';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { apiQuery } from '@/lib/api-client';

export interface ClientRef {
  id: string;
  code: string;
  displayName: string;
}

/** Inline client search (results render in the page, not in a pop-up). */
export function ClientPicker({ value, onChange, error }: { value: ClientRef | null; onChange: (c: ClientRef | null) => void; error?: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ClientRef[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) return setResults([]);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const r = await apiQuery<Paged<ClientSummary>>(`/clients?pageSize=8&q=${encodeURIComponent(q.trim())}`, ctrl.signal);
      if (r.ok) setResults(r.data.items.map((c) => ({ id: c.id, code: c.code, displayName: c.displayName })));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-blue-300 bg-blue-50/50 px-4 py-3">
        <span className="text-sm"><span className="font-semibold text-slate-900">{value.displayName}</span> <span className="font-mono text-slate-500">{value.code}</span></span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}><X /> Change</Button>
      </div>
    );
  }
  return (
    <div>
      <label htmlFor="client-search" className="block text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">Client</label>
      <div className="relative mt-1.5">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <Input id="client-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, reference or code" className="pl-9" invalid={!!error} aria-describedby={error ? 'client-error' : undefined} />
      </div>
      {error ? <p id="client-error" className="mt-1.5 text-xs font-medium text-red-700" role="alert">{error}</p> : null}
      {results.length ? (
        <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200" aria-label="Matching clients">
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onChange(c)} className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-slate-50">
                <span className="font-medium text-slate-800">{c.displayName}</span>
                <span className="font-mono text-[12px] text-slate-500">{c.code}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : q.trim().length >= 2 ? (
        <p className="mt-2 text-[13px] text-slate-500">No matching clients.</p>
      ) : null}
    </div>
  );
}
