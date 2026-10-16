import { CircleCheck, CircleQuestionMark, CircleX, KeyRound, Pause } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/** Connectivity is only "verified" when a real test succeeded — never assumed. */
export function ConnectionBadge({ status }: { status: 'untested' | 'succeeded' | 'failed' }) {
  if (status === 'succeeded') return <Badge tone="emerald"><CircleCheck /> Verified</Badge>;
  if (status === 'failed') return <Badge tone="red"><CircleX /> Test failed</Badge>;
  return <Badge><CircleQuestionMark /> Untested</Badge>;
}

const CRED: Record<string, { tone: 'neutral' | 'amber' | 'emerald' | 'red'; label: string }> = {
  not_configured: { tone: 'neutral', label: 'Not configured' },
  pending_appliance: { tone: 'amber', label: 'Pending on appliance' },
  configured: { tone: 'emerald', label: 'Configured' },
  invalid: { tone: 'red', label: 'Invalid' },
  expired: { tone: 'red', label: 'Expired' },
};

export function CredentialBadge({ status }: { status: string }) {
  const c = CRED[status] ?? { tone: 'neutral' as const, label: status };
  return <Badge tone={c.tone}><KeyRound /> {c.label}</Badge>;
}

export function InstanceStatusBadge({ status }: { status: 'active' | 'disabled' }) {
  return status === 'active' ? <Badge tone="blue">Active</Badge> : <Badge><Pause /> Disabled</Badge>;
}
