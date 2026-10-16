import type { EnrollmentTokenStatus, PackageStatus } from '@psacc/contracts';
import { Ban, CircleCheck, Clock, KeyRound, Replace, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const PACKAGE: Record<PackageStatus, { tone: 'emerald' | 'neutral' | 'amber' | 'red' | 'blue'; label: string; icon: React.ReactNode }> = {
  active: { tone: 'emerald', label: 'Ready to download', icon: <CircleCheck aria-hidden="true" /> },
  expired: { tone: 'amber', label: 'Expired', icon: <Clock aria-hidden="true" /> },
  superseded: { tone: 'neutral', label: 'Replaced', icon: <Replace aria-hidden="true" /> },
  revoked: { tone: 'red', label: 'Revoked', icon: <Ban aria-hidden="true" /> },
  consumed: { tone: 'blue', label: 'Used for enrollment', icon: <ShieldCheck aria-hidden="true" /> },
};

export function PackageStatusBadge({ status }: { status: PackageStatus }) {
  const p = PACKAGE[status];
  return <Badge tone={p.tone}>{p.icon}{p.label}</Badge>;
}

const TOKEN: Record<EnrollmentTokenStatus, { tone: 'emerald' | 'neutral' | 'amber' | 'red' | 'blue'; label: string }> = {
  active: { tone: 'emerald', label: 'Token valid' },
  expired: { tone: 'amber', label: 'Token expired' },
  revoked: { tone: 'red', label: 'Token revoked' },
  consumed: { tone: 'blue', label: 'Token used' },
};

export function TokenStatusBadge({ status }: { status: EnrollmentTokenStatus }) {
  const t = TOKEN[status];
  return <Badge tone={t.tone}><KeyRound aria-hidden="true" />{t.label}</Badge>;
}
