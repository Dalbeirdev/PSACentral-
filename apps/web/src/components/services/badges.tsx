import type { IntegrationDependencyDefinition } from '@psacc/contracts';
import { integrationDependency } from '@psacc/contracts';
import { Check, CircleDashed, Minus, Plug, Star, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { DependencySupport } from '@/lib/services';

export function ServiceStatusBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge tone="emerald"><Check aria-hidden="true" /> Active</Badge>
  ) : (
    <Badge tone="neutral"><CircleDashed aria-hidden="true" /> Inactive</Badge>
  );
}

export function DefaultBadge({ compact }: { compact?: boolean }) {
  return <Badge tone="blue" className={compact ? 'h-5 px-1.5 text-[11px]' : undefined} title="Pre-selected for new clients"><Star aria-hidden="true" /> Default</Badge>;
}

export function UsesPsaBadge({ compact }: { compact?: boolean }) {
  return <Badge tone="violet" className={compact ? 'h-5 px-1.5 text-[11px]' : undefined} title="Runs through the client’s PSA"><Plug aria-hidden="true" /> Uses PSA</Badge>;
}

export function IncompleteBadge({ compact }: { compact?: boolean }) {
  return <Badge tone="amber" className={compact ? 'h-5 px-1.5 text-[11px]' : undefined}><TriangleAlert aria-hidden="true" /> Settings incomplete</Badge>;
}

/** Dependency chip; `support` (from the client's PSA provider) decides the tone — never color alone. */
export function DependencyChip({ dep, support }: { dep: IntegrationDependencyDefinition | string; support?: DependencySupport }) {
  const d = typeof dep === 'string' ? integrationDependency(dep) : dep;
  const label = d?.label ?? String(dep);
  if (support === 'supported') return <Badge tone="emerald" title={`${label}: supported by the provider adapter`}><Check aria-hidden="true" /> {label}</Badge>;
  if (support === 'unsupported') return <Badge tone="red" title={`${label}: not supported by the provider adapter`}><Minus aria-hidden="true" /> {label}</Badge>;
  if (support === 'not_modelled') return <Badge tone="neutral" title={`${label}: adapter support decided per provider later`}><CircleDashed aria-hidden="true" /> {label}</Badge>;
  return <Badge tone={d?.kind === 'psa' ? 'violet' : 'cyan'} title={d?.description}>{label}</Badge>;
}
