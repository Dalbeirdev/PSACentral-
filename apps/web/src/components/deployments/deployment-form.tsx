'use client';

import { type DeploymentDetail, type PsaInstanceSummary, type Paged, TARGET_ENVIRONMENTS } from '@psacc/contracts';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { ClientPicker, type ClientRef } from '@/components/clients/client-picker';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { apiMutate, apiQuery, fieldErrors } from '@/lib/api-client';
import { cn } from '@/lib/cn';

interface PsaOption {
  id: string;
  code: string;
  displayName: string;
  providerName: string;
}

/** Create a deployment for a client, or change a draft deployment's settings. Full page, inline validation. */
export function DeploymentForm({ deployment, preset }: { deployment?: DeploymentDetail; preset?: ClientRef | null }) {
  const router = useRouter();
  const editing = !!deployment;
  const [client, setClient] = useState<ClientRef | null>(deployment ? deployment.client : (preset ?? null));
  const [psaOptions, setPsaOptions] = useState<PsaOption[]>(deployment?.psaOptions ?? []);
  const [psaInstanceId, setPsaInstanceId] = useState(deployment?.psaInstance?.id ?? '');
  const [targetEnvironment, setEnv] = useState<string>(deployment?.targetEnvironment ?? '');
  const [targetOs, setOs] = useState(deployment?.targetOs ?? '');
  const [targetArch, setArch] = useState(deployment?.targetArch ?? 'amd64');
  const [hostLabel, setHostLabel] = useState(deployment?.hostLabel ?? '');
  const [licenseId, setLicenseId] = useState(deployment?.licenseDetail?.id ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ title: string; detail?: string; stale?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing || !client) return;
    const ctrl = new AbortController();
    apiQuery<Paged<PsaInstanceSummary>>(`/psa-instances?clientId=${client.id}&status=active&pageSize=50`, ctrl.signal).then((r) => {
      if (!r.ok) return;
      const opts = r.data.items.map((i) => ({ id: i.id, code: i.code, displayName: i.displayName, providerName: i.providerName }));
      setPsaOptions(opts);
      setPsaInstanceId((cur) => (opts.some((o) => o.id === cur) ? cur : (opts[0]?.id ?? '')));
    });
    return () => ctrl.abort();
  }, [client, editing]);

  function pickEnv(key: string) {
    setEnv(key);
    const fixed = TARGET_ENVIRONMENTS.find((t) => t.key === key)?.os;
    if (fixed) setOs(fixed);
    setErrors((e) => ({ ...e, targetEnvironment: '', targetOs: '' }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    const body = { psaInstanceId, targetEnvironment, targetOs, targetArch, hostLabel };
    const r = editing
      ? await apiMutate<DeploymentDetail>('PATCH', `/deployments/${deployment.id}`, { ...body, version: deployment.version, ...(licenseId ? { licenseId } : {}) })
      : await apiMutate<DeploymentDetail>('POST', '/deployments', { ...body, clientId: client?.id });
    setBusy(false);
    if (r.ok) {
      router.push(`/deployments/${r.data.id}?saved=${editing ? 'updated' : 'created'}`);
      router.refresh();
      return;
    }
    const fe = fieldErrors(r.problem);
    setErrors(fe);
    setProblem({
      title: r.status === 409 && r.problem.type?.endsWith('stale-version') ? 'This deployment was changed by someone else.' : Object.keys(fe).length ? 'Some fields need attention.' : 'The deployment was not saved.',
      detail: Object.keys(fe).length ? undefined : r.problem.detail,
      stale: r.problem.type?.endsWith('stale-version'),
    });
  }

  const fixedOs = TARGET_ENVIRONMENTS.find((t) => t.key === targetEnvironment)?.os ?? null;

  return (
    <form onSubmit={submit} noValidate className="space-y-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-7">
      {problem ? (
        <Alert variant="error" title={problem.title} actions={problem.stale ? <Button type="button" variant="secondary" size="sm" onClick={() => router.refresh()}>Reload</Button> : undefined}>
          {problem.detail}
        </Alert>
      ) : null}

      {editing ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 text-sm">
          <span className="font-semibold text-slate-900">{deployment.client.displayName}</span> <span className="font-mono text-slate-500">{deployment.client.code}</span>
          <span className="block text-[12.5px] text-slate-500">The client of a deployment cannot change.</span>
        </div>
      ) : (
        <ClientPicker value={client} onChange={(c) => { setClient(c); setErrors((e) => ({ ...e, clientId: '' })); }} error={errors.clientId} />
      )}

      <fieldset>
        <legend className="text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">PSA instance</legend>
        <p className="mt-0.5 text-xs text-slate-500">The appliance runs this client PSA integration and calls its API directly from the client’s host.</p>
        {client ? (
          psaOptions.length ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {psaOptions.map((o) => (
                <label key={o.id} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3', psaInstanceId === o.id ? 'border-blue-400 bg-blue-50/50 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300')}>
                  <input type="radio" name="psaInstanceId" value={o.id} checked={psaInstanceId === o.id} onChange={() => setPsaInstanceId(o.id)} className="mt-1 accent-blue-600" />
                  <span className="text-sm">
                    <span className="block font-semibold text-slate-900">{o.displayName}</span>
                    <span className="text-[12.5px] text-slate-500"><span className="font-mono">{o.code}</span> · {o.providerName}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-slate-600">This client has no active PSA instance. <a className="font-medium text-blue-700 hover:underline" href={`/psa/new?clientId=${client.id}`}>Add one first.</a></p>
          )
        ) : (
          <p className="mt-2 text-[13px] text-slate-500">Choose a client first.</p>
        )}
        {errors.psaInstanceId ? <p className="mt-1.5 text-xs font-medium text-red-700" role="alert">{errors.psaInstanceId}</p> : null}
      </fieldset>

      <fieldset>
        <legend className="text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">Where will the appliance run?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TARGET_ENVIRONMENTS.map((t) => (
            <label key={t.key} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm', targetEnvironment === t.key ? 'border-blue-400 bg-blue-50/50 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300')}>
              <input type="radio" name="targetEnvironment" value={t.key} checked={targetEnvironment === t.key} onChange={() => pickEnv(t.key)} className="accent-blue-600" />
              <span className="font-medium text-slate-900">{t.label}</span>
            </label>
          ))}
        </div>
        {errors.targetEnvironment ? <p className="mt-1.5 text-xs font-medium text-red-700" role="alert">{errors.targetEnvironment}</p> : null}
      </fieldset>

      {editing ? (
        <Field label="License" hint="The entitlement this deployment runs under. Only active licenses of the client with free capacity can be chosen." error={errors.licenseId}>
          {(p) => (
            <Select {...p} value={licenseId} onChange={(e) => setLicenseId(e.target.value)} data-testid="deployment-license">
              <option value="">{deployment?.licenseDetail ? `Keep ${deployment.licenseDetail.code}` : 'No license'}</option>
              {(deployment?.licenseOptions ?? []).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.displayName} · {l.deploymentsUsed}/{l.maxDeployments} used{l.endsAt ? ` · until ${l.endsAt}` : ''}</option>)}
            </Select>
          )}
        </Field>
      ) : (
        <p className="text-[12.5px] text-slate-500">The client's active license with free capacity is assigned automatically; change it in the deployment's settings before generating a package.</p>
      )}

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Host operating system" required error={errors.targetOs} hint={fixedOs ? 'Set by the environment.' : undefined}>
          {(p) => (
            <Select {...p} value={targetOs} disabled={!!fixedOs} onChange={(e) => { setOs(e.target.value); setErrors((x) => ({ ...x, targetOs: '' })); }}>
              <option value="">Choose…</option>
              <option value="linux">Linux</option>
              <option value="windows">Windows</option>
            </Select>
          )}
        </Field>
        <Field label="CPU architecture" required error={errors.targetArch}>
          {(p) => (
            <Select {...p} value={targetArch} onChange={(e) => setArch(e.target.value)}>
              <option value="amd64">amd64 (x86-64)</option>
              <option value="arm64">arm64</option>
            </Select>
          )}
        </Field>
        <Field label="Host label" error={errors.hostLabel} hint="Optional. How the client names the machine.">
          {(p) => <Input {...p} value={hostLabel} maxLength={100} onChange={(e) => setHostLabel(e.target.value)} placeholder="e.g. hq-edge-01" />}
        </Field>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-5">
        <ButtonLink href={editing ? `/deployments/${deployment.id}` : '/deployments'} variant="secondary"><ArrowLeft /> Cancel</ButtonLink>
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>{editing ? 'Save settings' : 'Create deployment'}</Button>
      </div>
    </form>
  );
}
