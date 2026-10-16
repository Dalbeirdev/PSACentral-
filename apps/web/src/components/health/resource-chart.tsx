'use client';

import type { HealthPolicy } from '@psacc/contracts';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type Sample = { observedAt: string; cpuPercent: number | null; memoryPercent: number | null; diskPercent: number | null };

const SERIES: { key: keyof Omit<Sample, 'observedAt'>; label: string; color: string; warn: keyof HealthPolicy }[] = [
  { key: 'cpuPercent', label: 'CPU', color: '#2563EB', warn: 'cpuWarnPercent' },
  { key: 'memoryPercent', label: 'Memory', color: '#8B5CF6', warn: 'memoryWarnPercent' },
  { key: 'diskPercent', label: 'Disk', color: '#06B6D4', warn: 'diskWarnPercent' },
];

/** Resource utilisation over the last 24 h from real host_resources reports, with the warning threshold. */
export function ResourceChart({ samples, policy, timezone }: { samples: Sample[]; policy: HealthPolicy; timezone: string }) {
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
  const data = samples.map((s) => ({ ...s, t: fmt.format(new Date(s.observedAt)) }));
  const measured = SERIES.filter((s) => samples.some((x) => x[s.key] !== null));
  if (!measured.length) return <p className="text-sm text-slate-500">No measured resource samples in the last 24 hours.</p>;
  return (
    <div>
      <div className="h-56" role="img" aria-label="Resource utilisation chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid stroke="#E2E8F0" vertical={false} />
            <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#64748B' }} minTickGap={32} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748B' }} unit="%" />
            <Tooltip formatter={(v: unknown) => `${String(v)}%`} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <ReferenceLine y={policy.cpuWarnPercent} stroke="#F59E0B" strokeDasharray="4 4" label={{ value: 'warn', fontSize: 10, fill: '#92400E', position: 'insideTopRight' }} />
            {measured.map((s) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-4 text-[12.5px] text-slate-600" aria-label="Legend">
        {measured.map((s) => <li key={s.key} className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />{s.label}</li>)}
      </ul>
      <details className="mt-3">
        <summary className="cursor-pointer text-[13px] font-medium text-blue-700">View data table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead><tr className="text-slate-500"><th className="py-1 pr-3 font-medium">Time</th>{measured.map((s) => <th key={s.key} className="py-1 pr-3 font-medium">{s.label}</th>)}</tr></thead>
            <tbody>{data.map((d) => <tr key={d.observedAt}><td className="py-1 pr-3">{d.t}</td>{measured.map((s) => <td key={s.key} className="py-1 pr-3 tabular-nums">{d[s.key] ?? '—'}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
