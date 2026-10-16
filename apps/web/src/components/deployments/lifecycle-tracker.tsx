import type { DeploymentDetail } from '@psacc/contracts';
import { CircleCheck, CircleDashed } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';

/**
 * Generated → downloaded → installed & enrolled → verified, each with the evidence behind it.
 * A download never reads as an installation: installation is known only when the agent enrolls.
 */
export function LifecycleTracker({ d, timezone }: { d: DeploymentDetail; timezone: string }) {
  const usable = d.currentPackage;
  // Suspension (Module 14) keeps the appliance installed: the stages reflect the state it returns to on resume.
  const effective = d.lifecycleState === 'suspended' && d.suspension ? d.suspension.fromState
    : d.lifecycleState === 'decommissioned' && d.decommission ? d.decommission.fromState // Module 15: history of the retired appliance
    : d.lifecycleState;
  const enrolled = ['enrolled', 'verified'].includes(effective);
  const steps = [
    {
      label: 'Package generated',
      done: !!usable || enrolled,
      at: usable?.generatedAt ?? d.packageGeneratedAt,
      pending: d.packageGeneratedAt && !usable ? 'No usable package: generate a new one.' : 'Generate the package on the Installation page.',
    },
    {
      label: 'Package downloaded',
      done: !!d.packageDownloadedAt || enrolled,
      at: d.packageDownloadedAt,
      pending: 'Download the package from the Installation page.',
    },
    {
      label: 'Installed & enrolled',
      // Current state, not history: a revoked identity is no longer enrolled; a suspended appliance still is.
      done: enrolled,
      at: d.enrolledAt,
      pending: 'Known only when the installed agent connects and enrolls with its single-use token. A download is not an installation.',
    },
    {
      label: 'Verified',
      done: !!d.verifiedAt,
      at: d.verifiedAt,
      pending: 'Set after the agent’s health reports pass (Module 8).',
    },
  ];
  return (
    <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Deployment lifecycle">
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={cn('rounded-xl border px-4 py-3', s.done ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-white')}
          aria-label={`${s.label}: ${s.done ? 'done' : 'not yet'}`}
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            {s.done ? <CircleCheck className="size-4 text-emerald-600" aria-hidden="true" /> : <CircleDashed className="size-4 text-slate-400" aria-hidden="true" />}
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{i + 1}</span>
            {s.label}
          </p>
          <p className="mt-1 text-[12.5px] leading-5 text-slate-600">{s.done && s.at ? formatDateTime(s.at, timezone) : s.done ? 'Done' : s.pending}</p>
        </li>
      ))}
    </ol>
  );
}
