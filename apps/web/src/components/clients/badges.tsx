import type { ClientStatus, HealthState, ServiceStatus } from '@psacc/contracts';
import { Badge } from '@/components/ui/badge';
import { CLIENT_STATUS_LABEL, SERVICE_STATUS_LABEL } from '@/lib/reference';
import { HEALTH_COLORS, HEALTH_LABELS, HEALTH_ORDER } from '@/lib/health';

const CLIENT_TONE: Record<ClientStatus, 'neutral' | 'blue' | 'emerald' | 'amber' | 'red' | 'violet'> = {
  prospect: 'violet',
  onboarding: 'blue',
  active: 'emerald',
  suspended: 'amber',
  offboarded: 'neutral',
};
const SERVICE_TONE: Record<ServiceStatus, 'neutral' | 'blue' | 'emerald' | 'amber' | 'red'> = {
  not_started: 'neutral',
  in_progress: 'blue',
  live: 'emerald',
  paused: 'amber',
  terminated: 'red',
};

export function ClientStatusBadge({ status }: { status: ClientStatus }) {
  return <Badge tone={CLIENT_TONE[status]}>{CLIENT_STATUS_LABEL[status]}</Badge>;
}

export function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  return (
    <Badge tone={SERVICE_TONE[status]} className="bg-white">
      Service: {SERVICE_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Segmented health bar for a client's deployments (labels are in the title + sr text). */
export function HealthBar({ health, total }: { health: Record<HealthState, number>; total: number }) {
  if (!total) return <span className="text-[13px] text-slate-500">No deployments</span>;
  const parts = HEALTH_ORDER.filter((s) => health[s] > 0);
  const label = parts.map((s) => `${health[s]} ${HEALTH_LABELS[s].toLowerCase()}`).join(', ');
  return (
    <span className="inline-flex min-w-28 items-center gap-2" title={label}>
      <span className="flex h-2 w-20 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        {parts.map((s) => (
          <span key={s} className="h-full border-r-2 border-white last:border-r-0" style={{ width: `${(health[s] / total) * 100}%`, background: HEALTH_COLORS[s] }} />
        ))}
      </span>
      <span className="tnum text-[12.5px] text-slate-600">{total}</span>
      <span className="sr-only">deployments: {label}</span>
    </span>
  );
}
