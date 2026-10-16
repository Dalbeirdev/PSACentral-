'use client';

import type { ConfigRequirement } from '@psacc/contracts';
import { Field, Input, Select } from '@/components/ui/field';

/**
 * Inputs for a service's configuration requirements (client assignment and the onboarding wizard).
 * Values are kept as strings while editing; `configValuesForSubmit` types them for the API.
 */
export function ServiceConfigFields({
  requirements,
  values,
  onChange,
  errors,
  disabled,
}: {
  requirements: ConfigRequirement[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  if (!requirements.length) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {requirements.map((r) => {
        const hint = r.description ?? (r.type === 'number' && (r.min !== undefined || r.max !== undefined) ? `Between ${r.min ?? '…'} and ${r.max ?? '…'}.` : undefined);
        return (
          <Field key={r.key} label={r.label} required={r.required} hint={hint} error={errors?.[r.key]}>
            {(p) =>
              r.type === 'select' ? (
                <Select {...p} value={values[r.key] ?? ''} disabled={disabled} onChange={(e) => onChange(r.key, e.target.value)}>
                  <option value="">{r.required ? 'Choose…' : 'Not set'}</option>
                  {r.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : r.type === 'boolean' ? (
                <Select {...p} value={values[r.key] ?? ''} disabled={disabled} onChange={(e) => onChange(r.key, e.target.value)}>
                  <option value="">{r.required ? 'Choose…' : 'Not set'}</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </Select>
              ) : (
                <Input
                  {...p}
                  type={r.type === 'number' ? 'number' : r.type === 'url' ? 'url' : 'text'}
                  inputMode={r.type === 'number' ? 'decimal' : undefined}
                  min={r.type === 'number' ? r.min : undefined}
                  max={r.type === 'number' ? r.max : undefined}
                  placeholder={r.placeholder}
                  value={values[r.key] ?? ''}
                  disabled={disabled}
                  onChange={(e) => onChange(r.key, e.target.value)}
                />
              )
            }
          </Field>
        );
      })}
    </div>
  );
}
