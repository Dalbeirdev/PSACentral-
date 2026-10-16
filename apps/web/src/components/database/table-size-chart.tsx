'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatBytesLong } from '@/lib/database';

type Row = { name: string; sizeBytes: number };

/** On-disk size of the largest tables, from the agent's latest inventory (real catalog sizes). */
export function TableSizeChart({ tables }: { tables: Row[] }) {
  const data = [...tables].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 10);
  if (!data.length) return <p className="text-sm text-slate-500">No tables reported.</p>;
  const height = 28 * data.length + 24;
  return (
    <div>
      <div style={{ height }} role="img" aria-label="Largest tables by size">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }} barSize={12}>
            <CartesianGrid stroke="#E2E8F0" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11, fill: '#64748B' }} tickFormatter={(v: number) => formatBytesLong(v)} />
            <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11.5, fill: '#334155', fontFamily: 'ui-monospace, monospace' }} />
            <Tooltip formatter={(v: unknown) => formatBytesLong(Number(v))} contentStyle={{ fontSize: 12, borderRadius: 8 }} cursor={{ fill: '#F1F5F9' }} />
            <Bar dataKey="sizeBytes" name="Size" fill="#2563EB" radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-[13px] font-medium text-blue-700">View data table</summary>
        <table className="mt-2 w-full text-left text-[12.5px]">
          <thead><tr className="text-slate-500"><th className="py-1 pr-3 font-medium">Table</th><th className="py-1 pr-3 font-medium">Size</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.name}><td className="py-1 pr-3 font-mono">{d.name}</td><td className="py-1 pr-3 tabular-nums">{formatBytesLong(d.sizeBytes)}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}
