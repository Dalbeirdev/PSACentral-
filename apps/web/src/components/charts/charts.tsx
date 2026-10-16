'use client';

import type { HealthState } from '@psacc/contracts';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { HEALTH_COLORS, HEALTH_LABELS, HEALTH_ORDER } from '@/lib/health';

const AXIS = { stroke: '#CBD5E1', tick: { fill: '#64748B', fontSize: 11.5 }, tickLine: false } as const;
const GRID = '#EEF2F7';

function TooltipBox({ title, rows }: { title: string; rows: { label: string; value: number | string; color?: string }[] }) {
  return (
    <div className="min-w-40 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 text-xs shadow-pop backdrop-blur">
      <p className="mb-1.5 font-semibold text-slate-900">{title}</p>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-slate-600">
              {r.color ? <span className="size-2 rounded-full" style={{ background: r.color }} aria-hidden="true" /> : null}
              {r.label}
            </span>
            <span className="tnum font-semibold text-slate-900">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortMonth = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

export function StatusOverTimeChart({ data }: { data: ({ date: string } & Record<HealthState, number>)[] }) {
  const states = HEALTH_ORDER.filter((s) => data.some((d) => d[s] > 0));
  return (
    <div className="h-[280px] w-full" role="img" aria-label="Stacked area chart of deployment health states per day for the last 30 days. A data table follows.">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" {...AXIS} tickFormatter={shortDate} minTickGap={28} />
          <YAxis {...AXIS} axisLine={false} allowDecimals={false} width={44} />
          <Tooltip
            cursor={{ stroke: '#94A3B8', strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={shortDate(String(label))}
                  rows={[...payload].reverse().map((p) => ({ label: HEALTH_LABELS[p.dataKey as HealthState], value: Number(p.value), color: HEALTH_COLORS[p.dataKey as HealthState] }))}
                />
              ) : null
            }
          />
          {states.map((s) => (
            <Area
              key={s}
              type="monotone"
              dataKey={s}
              stackId="health"
              stroke={HEALTH_COLORS[s]}
              strokeWidth={2}
              fill={HEALTH_COLORS[s]}
              fillOpacity={0.16}
              activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HealthDonut({ data, total }: { data: { state: HealthState; count: number }[]; total: number }) {
  const slices = data.filter((d) => d.count > 0);
  return (
    <div className="relative h-[200px] w-[200px] shrink-0" role="img" aria-label={`Donut chart of ${total} deployments by health state. Values are listed beside the chart.`}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={slices} dataKey="count" nameKey="state" innerRadius={66} outerRadius={92} stroke="#ffffff" strokeWidth={2} startAngle={90} endAngle={-270} isAnimationActive={false}>
            {slices.map((s) => (
              <Cell key={s.state} fill={HEALTH_COLORS[s.state]} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) =>
              active && payload?.[0] ? (
                <TooltipBox
                  title={HEALTH_LABELS[payload[0].payload.state as HealthState]}
                  rows={[{ label: 'Deployments', value: Number(payload[0].value), color: HEALTH_COLORS[payload[0].payload.state as HealthState] }]}
                />
              ) : null
            }
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tracking-tight text-slate-900">{total}</span>
        <span className="text-xs font-medium text-slate-500">deployments</span>
      </div>
    </div>
  );
}

export function OnboardingChart({ data }: { data: { month: string; count: number }[] }) {
  return (
    <div className="h-[220px] w-full" role="img" aria-label="Column chart of clients onboarded per month for the last 12 months. A data table follows.">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -22 }} barCategoryGap="28%">
          <defs>
            <linearGradient id="onboard" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563EB" />
              <stop offset="100%" stopColor="#3B76F6" stopOpacity={0.85} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="month" {...AXIS} tickFormatter={shortMonth} interval={0} fontSize={11} />
          <YAxis {...AXIS} axisLine={false} allowDecimals={false} width={40} />
          <Tooltip
            cursor={{ fill: 'rgba(37,99,235,0.06)' }}
            content={({ active, payload, label }) =>
              active && payload?.[0] ? (
                <TooltipBox
                  title={new Date(`${String(label)}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
                  rows={[{ label: 'Clients onboarded', value: Number(payload[0].value), color: '#2563EB' }]}
                />
              ) : null
            }
          />
          <Bar dataKey="count" fill="url(#onboard)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
