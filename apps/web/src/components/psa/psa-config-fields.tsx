'use client';

import { isFieldVisible, type PsaConfigField, type PsaProviderDescriptor } from '@psacc/contracts';
import { CircleCheck, CircleDashed, KeyRound, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { apiMutate } from '@/lib/api-client';
import type { ConfigValues } from '@/lib/psa-config';

function FieldControl({ f, value, onChange, p }: { f: PsaConfigField; value: string | boolean; onChange: (v: string | boolean) => void; p: { id: string; 'aria-describedby'?: string; invalid: boolean } }) {
  if (f.type === 'select') {
    return (
      <Select {...p} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    );
  }
  if (f.type === 'boolean') {
    return <input id={p.id} type="checkbox" className="size-4 accent-blue-600" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  }
  return (
    <Input
      {...p}
      type={f.type === 'url' ? 'url' : f.type === 'number' ? 'number' : 'text'}
      inputMode={f.type === 'number' ? 'numeric' : undefined}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={f.placeholder}
      className={f.type === 'url' || f.type === 'host' ? 'font-mono' : undefined}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

/**
 * Provider-specific configuration form, rendered entirely from the provider descriptor.
 * Validation and endpoint derivation are done by the provider adapter on the server (live preview).
 */
export function PsaConfigFields({
  descriptor,
  authMethod,
  onAuthMethod,
  config,
  onConfig,
  errors,
}: {
  descriptor: PsaProviderDescriptor;
  authMethod: string;
  onAuthMethod: (v: string) => void;
  config: ConfigValues;
  onConfig: (v: ConfigValues) => void;
  errors: Record<string, string>;
}) {
  const [preview, setPreview] = useState<{ ok: boolean; endpoint: string | null; issues: { path: string; message: string }[] } | null>(null);
  const visible = descriptor.configFields.filter((f) => isFieldVisible(f, config as Record<string, unknown>));
  const method = descriptor.authMethods.find((m) => m.key === authMethod);

  useEffect(() => {
    if (!authMethod) return setPreview(null);
    const t = setTimeout(async () => {
      const r = await apiMutate<{ ok: boolean; endpoint: string | null; issues: { path: string; message: string }[] }>(
        'POST',
        `/psa-providers/${descriptor.key}/validate`,
        { authMethod, config },
      );
      if (r.ok) setPreview(r.data);
    }, 450);
    return () => clearTimeout(t);
  }, [descriptor.key, authMethod, config]);

  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">Authentication method</legend>
        {errors.authMethod ? <p className="mt-1 text-xs font-medium text-red-700" role="alert">{errors.authMethod}</p> : null}
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {descriptor.authMethods.map((m) => (
            <label key={m.key} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm ${authMethod === m.key ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 hover:border-slate-300'}`}>
              <input type="radio" name="authMethod" className="accent-blue-600" checked={authMethod === m.key} onChange={() => onAuthMethod(m.key)} />
              <span className="font-medium text-slate-800">{m.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-slate-900">{descriptor.name} settings</legend>
        <p className="mt-0.5 text-[13px] text-slate-500">{descriptor.description}</p>
        {errors.config ? <p className="mt-2 text-xs font-medium text-red-700" role="alert">{errors.config}</p> : null}
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          {visible.map((f) => (
            <Field key={f.key} label={f.label} required={f.required} hint={f.hint} error={errors[`config.${f.key}`]}>
              {(p) => <FieldControl f={f} p={p} value={config[f.key] ?? ''} onChange={(v) => onConfig({ ...config, [f.key]: v })} />}
            </Field>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4" aria-labelledby="endpoint-heading" aria-live="polite">
          <h3 id="endpoint-heading" className="flex items-center gap-2 text-[13px] font-semibold text-slate-800"><Link2 className="size-4 text-slate-500" aria-hidden="true" /> API endpoint</h3>
          {preview?.ok ? (
            <p className="mt-2 break-all font-mono text-[12.5px] text-slate-800" data-testid="endpoint-preview">{preview.endpoint}</p>
          ) : (
            <p className="mt-2 text-[13px] text-slate-500">Derived by the {descriptor.name} adapter once the settings are complete.</p>
          )}
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-slate-500">
            {preview?.ok ? <CircleCheck className="size-3.5 text-emerald-600" aria-hidden="true" /> : <CircleDashed className="size-3.5" aria-hidden="true" />}
            {preview?.ok ? 'Configuration is valid. The connection itself is untested.' : 'Validated by the server as you type.'}
          </p>
        </section>
        <section className="rounded-xl border border-amber-200/80 bg-amber-50/50 p-4" aria-labelledby="creds-heading">
          <h3 id="creds-heading" className="flex items-center gap-2 text-[13px] font-semibold text-slate-800"><KeyRound className="size-4 text-amber-600" aria-hidden="true" /> Credentials — entered on the appliance</h3>
          {method ? (
            <ul className="mt-2 space-y-1 text-[13px] text-slate-700">
              {method.credentialFields.map((c) => (
                <li key={c.key}>{c.label}{c.secret ? <span className="ml-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">secret</span> : null}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] text-slate-500">Choose an authentication method to see what is needed.</p>
          )}
          <p className="mt-2 text-[12px] leading-5 text-slate-600">These values are never entered in or stored by the control plane.</p>
        </section>
      </div>
    </div>
  );
}
