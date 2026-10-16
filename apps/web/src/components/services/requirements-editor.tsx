'use client';

import { CONFIG_REQUIREMENT_TYPES, type ConfigRequirement } from '@psacc/contracts';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';

const TYPE_LABEL: Record<ConfigRequirement['type'], string> = { text: 'Text', number: 'Number', boolean: 'Yes / no', select: 'Choice (select)', url: 'URL' };

/** Editable requirement as kept in the form: options as one line per "value | label"; numbers as strings. */
export interface RequirementDraft {
  key: string;
  label: string;
  type: ConfigRequirement['type'];
  required: boolean;
  description: string;
  placeholder: string;
  options: string;
  min: string;
  max: string;
}

export function draftFromRequirement(r: ConfigRequirement): RequirementDraft {
  return {
    key: r.key, label: r.label, type: r.type, required: r.required, description: r.description ?? '', placeholder: r.placeholder ?? '',
    options: r.options?.map((o) => (o.value === o.label ? o.value : `${o.value} | ${o.label}`)).join('\n') ?? '',
    min: r.min === undefined ? '' : String(r.min), max: r.max === undefined ? '' : String(r.max),
  };
}

export function emptyDraft(): RequirementDraft {
  return { key: '', label: '', type: 'text', required: false, description: '', placeholder: '', options: '', min: '', max: '' };
}

/** Converts drafts to the contract shape; the contract schema reports precise errors. */
export function requirementsFromDrafts(drafts: RequirementDraft[]): unknown[] {
  return drafts.map((d) => {
    const out: Record<string, unknown> = { key: d.key.trim(), label: d.label.trim(), type: d.type, required: d.required };
    if (d.description.trim()) out.description = d.description.trim();
    if (d.placeholder.trim()) out.placeholder = d.placeholder.trim();
    if (d.type === 'select') {
      out.options = d.options
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [value, label] = l.split('|').map((x) => x.trim());
          return { value: value ?? '', label: label || value || '' };
        });
    }
    if (d.type === 'number') {
      if (d.min.trim() !== '') out.min = Number(d.min);
      if (d.max.trim() !== '') out.max = Number(d.max);
    }
    return out;
  });
}

/**
 * Defines what a client must supply when the service is assigned. Everything is inline on the page;
 * credentials are refused by the contract (they belong on the appliance).
 */
export function RequirementsEditor({ drafts, onChange, errors }: { drafts: RequirementDraft[]; onChange: (d: RequirementDraft[]) => void; errors: Record<string, string> }) {
  const update = (i: number, patch: Partial<RequirementDraft>) => onChange(drafts.map((d, n) => (n === i ? { ...d, ...patch } : d)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= drafts.length) return;
    const next = [...drafts];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const err = (i: number, f: string) => errors[`configRequirements.${i}.${f}`];

  return (
    <div className="space-y-4">
      {errors.configRequirements ? <p className="text-xs font-medium text-red-700" role="alert">{errors.configRequirements}</p> : null}
      {drafts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-[13px] text-slate-500">No settings required. Clients can be assigned this service without configuration.</p>
      ) : null}
      <ol className="space-y-4">
        {drafts.map((d, i) => (
          <li key={i} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4" data-testid="requirement-row">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-slate-800">Setting {i + 1}{d.label ? ` — ${d.label}` : ''}</span>
              <span className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" aria-label={`Move setting ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                <Button type="button" variant="ghost" size="sm" aria-label={`Move setting ${i + 1} down`} disabled={i === drafts.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove setting ${i + 1}`} onClick={() => onChange(drafts.filter((_, n) => n !== i))}><Trash2 /> Remove</Button>
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Label" required error={err(i, 'label')}>{(p) => <Input {...p} value={d.label} onChange={(e) => update(i, { label: e.target.value })} />}</Field>
              <Field label="Key" required error={err(i, 'key')} hint="camelCase; stored with the client's values">
                {(p) => <Input {...p} value={d.key} className="font-mono" onChange={(e) => update(i, { key: e.target.value })} />}
              </Field>
              <Field label="Type" required error={err(i, 'type')}>
                {(p) => (
                  <Select {...p} value={d.type} onChange={(e) => update(i, { type: e.target.value as ConfigRequirement['type'] })}>
                    {CONFIG_REQUIREMENT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                  </Select>
                )}
              </Field>
              <div className="flex items-end">
                <Checkbox label="Required" description="Clients cannot be assigned the service without it." checked={d.required} onChange={(e) => update(i, { required: e.target.checked })} className="w-full" />
              </div>
              <Field label="Description" error={err(i, 'description')} className="sm:col-span-2">{(p) => <Input {...p} value={d.description} onChange={(e) => update(i, { description: e.target.value })} />}</Field>
              <Field label="Placeholder" error={err(i, 'placeholder')}>{(p) => <Input {...p} value={d.placeholder} onChange={(e) => update(i, { placeholder: e.target.value })} />}</Field>
              {d.type === 'number' ? (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Min" error={err(i, 'min')}>{(p) => <Input {...p} type="number" value={d.min} onChange={(e) => update(i, { min: e.target.value })} />}</Field>
                  <Field label="Max" error={err(i, 'max')}>{(p) => <Input {...p} type="number" value={d.max} onChange={(e) => update(i, { max: e.target.value })} />}</Field>
                </div>
              ) : null}
              {d.type === 'select' ? (
                <Field label="Options" required error={err(i, 'options')} hint="One per line: value | label (label optional)" className="sm:col-span-2 xl:col-span-4">
                  {(p) => <textarea {...p} rows={3} className="block w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-[13px] focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" value={d.options} onChange={(e) => update(i, { options: e.target.value })} />}
                </Field>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...drafts, emptyDraft()])} disabled={drafts.length >= 20}><Plus /> Add setting</Button>
    </div>
  );
}
