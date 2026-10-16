'use client';

import {
  COMMAND_STATUS_LABELS,
  COMMAND_TYPE_INFO,
  type CommandType,
  OPERATOR_COMMAND_TYPES,
  RESTARTABLE_SERVICES,
  type RemoteCommandDto,
  type RemoteOperationsDto,
  type RestartableService,
} from '@psacc/contracts';
import { Ban, KeyRound, RefreshCw, Repeat, Rocket, SendHorizontal, ShieldCheck, Wrench } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiMutate } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

const ICONS: Partial<Record<CommandType, ReactNode>> = {
  refresh_health: <RefreshCw />,
  test_psa_connection: <ShieldCheck />,
  run_sync: <Repeat />,
  restart_service: <Wrench />,
  rotate_certificate: <KeyRound />,
  upgrade: <Rocket />,
};

const STATUS_TONE: Record<RemoteCommandDto['status'], 'neutral' | 'blue' | 'amber' | 'emerald' | 'red'> = {
  pending: 'blue',
  delivered: 'blue',
  staged: 'amber',
  succeeded: 'emerald',
  failed: 'red',
  expired: 'neutral',
  cancelled: 'neutral',
};

export function CommandStatusBadge({ status }: { status: RemoteCommandDto['status'] }) {
  return <Badge tone={STATUS_TONE[status]} data-testid="command-status">{COMMAND_STATUS_LABELS[status]}</Badge>;
}

/**
 * Remote operations (Module 13): issue signed commands that the appliance's agent pulls with its
 * heartbeat, and follow their status. Confirmation is inline (no modal): choose a command, review
 * what it does and its expiry, then issue it.
 */
export function RemoteOperations({ ops, canIssue, timezone }: { ops: RemoteOperationsDto; canIssue: boolean; timezone: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<CommandType | null>(null);
  const [service, setService] = useState<RestartableService>('edge-api');
  const [expires, setExpires] = useState<15 | 60 | 240 | 1440>(60);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string | null>(null);

  async function issue() {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    const body: Record<string, unknown> = { type: selected, expiresInMinutes: expires };
    if (selected === 'restart_service') body.params = { service };
    if (note.trim()) body.note = note.trim();
    const r = await apiMutate<RemoteCommandDto>('POST', `/deployments/${ops.deploymentId}/commands`, body);
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The command was not issued.');
    setSelected(null);
    setNote('');
    setNotice(`${COMMAND_TYPE_INFO[r.data.type].label} issued (ID ${r.data.id.slice(0, 8)}…). The agent fetches it with its next heartbeat; the row below updates when it answers.`);
    router.refresh();
  }

  async function cancel(id: string) {
    setBusy(true);
    const r = await apiMutate<RemoteCommandDto>('POST', `/deployments/${ops.deploymentId}/commands/${id}/cancel`);
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The command was not cancelled.');
    setNotice('Command cancelled before the agent fetched it.');
    router.refresh();
  }

  const upgradeBlocked = ops.upToDate ? `The appliance already runs image ${ops.upgradeTarget.version}.` : null;

  return (
    <div className="space-y-4">
      {notice ? <Alert variant="success" title={notice} /> : null}
      {!canIssue ? (
        <p className="text-sm text-slate-600">You can follow remote operations here. Issuing commands needs the <span className="font-mono text-[12.5px]">deployments.commands.issue</span> permission (Technical Administrator or Super Administrator).</p>
      ) : !ops.canIssue ? (
        <Alert variant="info" title="Commands cannot be issued yet">{ops.reason}</Alert>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Available commands">
            {OPERATOR_COMMAND_TYPES.map((t) => {
              const open = ops.open[t];
              const blocked = t === 'upgrade' ? upgradeBlocked : null;
              const active = selected === t;
              return (
                <li key={t}>
                  <button
                    type="button"
                    onClick={() => { setSelected(active ? null : t); setError(undefined); }}
                    disabled={Boolean(open) || Boolean(blocked) || busy}
                    aria-pressed={active}
                    data-testid={`command-${t}`}
                    className={`flex h-full w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${active ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-200' : 'border-slate-200 bg-white hover:border-slate-300'} disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    <span className="mt-0.5 text-blue-600 [&_svg]:size-5" aria-hidden="true">{ICONS[t]}</span>
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">{COMMAND_TYPE_INFO[t].label}</span>
                      <span className="mt-0.5 block text-[12.5px] leading-5 text-slate-600">{COMMAND_TYPE_INFO[t].description}</span>
                      {open ? <span className="mt-1 block text-[12px] font-medium text-blue-700">Already waiting for the appliance</span> : null}
                      {blocked ? <span className="mt-1 block text-[12px] font-medium text-slate-500">{blocked}</span> : null}
                      {t === 'upgrade' && !blocked ? <span className="mt-1 block font-mono text-[12px] text-slate-700">target {ops.upgradeTarget.repository}:{ops.upgradeTarget.version}{ops.upgradeTarget.digest ? ` @${ops.upgradeTarget.digest.slice(0, 19)}…` : ' (not digest-pinned: development image)'}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4" data-testid="issue-panel">
              <p className="text-sm font-semibold text-slate-900">Issue “{COMMAND_TYPE_INFO[selected].label}” to this appliance</p>
              <p className="mt-1 text-[13px] text-slate-700">{COMMAND_TYPE_INFO[selected].description} Runs on: {COMMAND_TYPE_INFO[selected].runsOn}. The command is signed by this Control Plane, carries this deployment and installation as its target, and expires if the agent does not complete it in time.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {selected === 'restart_service' ? (
                  <Field label="Service">
                    {(p) => (
                      <Select {...p} value={service} onChange={(e) => setService(e.target.value as RestartableService)} data-testid="command-service">
                        {RESTARTABLE_SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </Select>
                    )}
                  </Field>
                ) : null}
                <Field label="Expires if not completed within">
                  {(p) => (
                    <Select {...p} value={expires} onChange={(e) => setExpires(Number(e.target.value) as 15 | 60 | 240 | 1440)}>
                      <option value={15}>15 minutes</option>
                      <option value={60}>1 hour</option>
                      <option value={240}>4 hours</option>
                      <option value={1440}>24 hours</option>
                    </Select>
                  )}
                </Field>
                <Field label="Note (kept with the audit record)" hint="Optional">
                  {(p) => <Input {...p} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why this is being done" />}
                </Field>
              </div>
              {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={issue} loading={busy} data-testid="issue-command"><SendHorizontal /> Issue command</Button>
                <Button variant="secondary" onClick={() => setSelected(null)} disabled={busy}>Back</Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      {error && !selected ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}

      <div>
        <h3 className="text-sm font-semibold text-slate-900">Command history</h3>
        <p className="mt-0.5 text-[12.5px] text-slate-500">Every command keeps its ID, issuer, target, status, timestamps, expiry and the appliance’s answer; issue, delivery, completion, expiry and cancellation are in the activity log.</p>
        {ops.commands.length ? (
          <div className="mt-3 overflow-x-auto">
            <Table data-testid="command-history">
              <thead>
                <tr><Th>Command</Th><Th>Status</Th><Th>Issued</Th><Th>Expires</Th><Th>Answer</Th><Th className="text-right">Actions</Th></tr>
              </thead>
              <tbody>
                {ops.commands.map((c) => (
                  <Tr key={c.id} data-testid="command-row">
                    <Td>
                      <span className="font-medium text-slate-900">{COMMAND_TYPE_INFO[c.type].label}</span>
                      {c.type === 'restart_service' ? <span className="ml-1 font-mono text-[12px] text-slate-600">{String(c.params.service ?? '')}</span> : null}
                      {c.type === 'upgrade' ? <span className="ml-1 font-mono text-[12px] text-slate-600">{String(c.params.repository ?? '')}:{String(c.params.version ?? '')}</span> : null}
                      <span className="block font-mono text-[11.5px] text-slate-500" title={c.id}>{c.id.slice(0, 8)}… · key {c.keyId}</span>
                      {c.note ? <span className="block text-[12px] text-slate-600">“{c.note}”</span> : null}
                    </Td>
                    <Td><CommandStatusBadge status={c.status} />{c.deliveredAt ? <span className="block text-[11.5px] text-slate-500">fetched {formatDateTime(c.deliveredAt, timezone, { seconds: true })}</span> : null}</Td>
                    <Td><span className="block text-slate-800">{formatDateTime(c.issuedAt, timezone, { seconds: true })}</span><span className="block text-[11.5px] text-slate-500">by {c.issuedBy ?? 'unknown user'}</span></Td>
                    <Td className="text-slate-700">{formatDateTime(c.expiresAt, timezone)}</Td>
                    <Td>
                      {c.result ? (
                        <>
                          <span className="font-mono text-[12px] text-slate-800">{c.result.code}</span>
                          <span className="block text-[12.5px] text-slate-700" data-testid="command-message">{c.result.message}</span>
                          {c.finishedAt ? <span className="block text-[11.5px] text-slate-500">{formatDateTime(c.finishedAt, timezone, { seconds: true })} · agent {c.result.agentVersion}</span> : null}
                        </>
                      ) : c.status === 'cancelled' ? (
                        <span className="text-[12.5px] text-slate-600">Cancelled {c.cancelledAt ? formatDateTime(c.cancelledAt, timezone, { seconds: true }) : ''} by {c.cancelledBy ?? 'unknown user'}</span>
                      ) : c.status === 'expired' ? (
                        <span className="text-[12.5px] text-slate-600">No answer before the expiry</span>
                      ) : (
                        <span className="text-[12.5px] text-slate-500">Waiting…</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      {canIssue && c.status === 'pending' ? <Button variant="subtle" size="sm" onClick={() => cancel(c.id)} disabled={busy} data-testid="cancel-command"><Ban /> Cancel</Button> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500" data-testid="no-commands">No command has been issued to this appliance.</p>
        )}
      </div>
    </div>
  );
}
