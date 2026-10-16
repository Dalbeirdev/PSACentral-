'use client';

import { BUSINESS_TYPES, CONTACT_ROLES, type ContactRole, type UserRef } from '@psacc/contracts';
import { Plus, Star, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { CONTACT_ROLE_LABEL } from '@/lib/reference';

/** Option lists come from the server so server and browser render identical markup (ICU data differs). */
export interface ReferenceLists {
  countries: { code: string; name: string }[];
  timezones: string[];
}

export interface CompanyForm {
  legalName: string;
  displayName: string;
  clientReference: string;
  businessType: string;
  countryCode: string;
  stateRegion: string;
  city: string;
  timezone: string;
  website: string;
}
export interface ManagementForm {
  accountManagerUserId: string;
  technicalOwnerUserId: string;
  onboardingDate: string;
  contractStartDate: string;
  contractEndDate: string;
  internalNotes: string;
}
export interface ContactForm {
  fullName: string;
  jobTitle: string;
  email: string;
  phone: string;
  mobile: string;
  roles: ContactRole[];
  notes: string;
}

export const emptyCompany = (): CompanyForm => ({
  legalName: '', displayName: '', clientReference: '', businessType: '', countryCode: '', stateRegion: '', city: '', timezone: '', website: '',
});
export const emptyManagement = (): ManagementForm => ({
  accountManagerUserId: '', technicalOwnerUserId: '', onboardingDate: '', contractStartDate: '', contractEndDate: '', internalNotes: '',
});
export const emptyContact = (roles: ContactRole[] = []): ContactForm => ({ fullName: '', jobTitle: '', email: '', phone: '', mobile: '', roles, notes: '' });

/** Turns API/stored values (possibly undefined/null) into form strings. */
export function toForm<T extends object>(blank: T, value: Partial<Record<keyof T, unknown>> | null | undefined): T {
  const out = { ...blank } as Record<string, unknown>;
  for (const k of Object.keys(blank)) {
    const v = value?.[k as keyof T];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as T;
}

type Errors = Record<string, string>;

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="border-t border-slate-100 pt-6 first:border-t-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <h3 className="text-sm font-semibold text-slate-900" aria-hidden="true">{title}</h3>
      {description ? <p className="mt-0.5 text-[13px] text-slate-500">{description}</p> : null}
      <div className="mt-4 grid gap-5 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

export function CompanyFields({
  value,
  onChange,
  errors,
  prefix = 'company',
  referenceHint,
  lists,
}: {
  lists: ReferenceLists;
  value: CompanyForm;
  onChange: (v: CompanyForm) => void;
  errors: Errors;
  prefix?: string;
  referenceHint?: ReactNode;
}) {
  const set = (k: keyof CompanyForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const err = (k: string) => errors[`${prefix}.${k}`];
  return (
    <>
      <Section title="Company" description="Legal identity and how the client appears in this platform.">
        <Field label="Legal company name" required error={err('legalName')}>
          {(p) => <Input {...p} value={value.legalName} onChange={set('legalName')} autoComplete="organization" />}
        </Field>
        <Field label="Display name" required error={err('displayName')} hint="Short name used in lists and dashboards.">
          {(p) => <Input {...p} value={value.displayName} onChange={set('displayName')} />}
        </Field>
        <Field label="Client reference" required error={err('clientReference')} hint={referenceHint ?? 'Your internal account or CRM reference. Unique within your organization.'}>
          {(p) => <Input {...p} value={value.clientReference} onChange={set('clientReference')} className="font-mono" />}
        </Field>
        <Field label="Business type" required error={err('businessType')}>
          {(p) => (
            <Select {...p} value={value.businessType} onChange={set('businessType')}>
              <option value="">Choose…</option>
              {BUSINESS_TYPES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Company website" error={err('website')} className="sm:col-span-2">
          {(p) => <Input {...p} type="url" value={value.website} onChange={set('website')} placeholder="https://www.example.com" autoComplete="url" />}
        </Field>
      </Section>
      <Section title="Location" description="Used for support hours and to display the client’s local time.">
        <Field label="Country" required error={err('countryCode')}>
          {(p) => (
            <Select {...p} value={value.countryCode} onChange={set('countryCode')} autoComplete="country">
              <option value="">Choose…</option>
              {lists.countries.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="State / region" error={err('stateRegion')}>
          {(p) => <Input {...p} value={value.stateRegion} onChange={set('stateRegion')} autoComplete="address-level1" />}
        </Field>
        <Field label="City" error={err('city')}>
          {(p) => <Input {...p} value={value.city} onChange={set('city')} autoComplete="address-level2" />}
        </Field>
        <Field label="Time zone" required error={err('timezone')}>
          {(p) => (
            <Select {...p} value={value.timezone} onChange={set('timezone')}>
              <option value="">Choose…</option>
              {(value.timezone && !lists.timezones.includes(value.timezone) ? [value.timezone, ...lists.timezones] : lists.timezones).map((z) => (
                <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>
              ))}
            </Select>
          )}
        </Field>
      </Section>
    </>
  );
}

export function ManagementFields({
  value,
  onChange,
  errors,
  users,
  prefix = 'management',
}: {
  value: ManagementForm;
  onChange: (v: ManagementForm) => void;
  errors: Errors;
  users: UserRef[];
  prefix?: string;
}) {
  const set = (k: keyof ManagementForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const err = (k: string) => errors[`${prefix}.${k}`];
  const userSelect = (k: 'accountManagerUserId' | 'technicalOwnerUserId') => (p: object) => (
    <Select {...p} value={value[k]} onChange={set(k)}>
      <option value="">Not assigned</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>{u.displayName}</option>
      ))}
    </Select>
  );
  return (
    <Section title="Management" description="Ownership and contract details. Internal notes are never shared with the client.">
      <Field label="Account manager" error={err('accountManagerUserId')}>{userSelect('accountManagerUserId')}</Field>
      <Field label="Technical owner" error={err('technicalOwnerUserId')}>{userSelect('technicalOwnerUserId')}</Field>
      <Field label="Onboarding date" error={err('onboardingDate')} hint="Defaults to today when the client is created.">
        {(p) => <Input {...p} type="date" value={value.onboardingDate} onChange={set('onboardingDate')} />}
      </Field>
      <div className="hidden sm:block" />
      <Field label="Contract start" error={err('contractStartDate')}>
        {(p) => <Input {...p} type="date" value={value.contractStartDate} onChange={set('contractStartDate')} />}
      </Field>
      <Field label="Contract end" error={err('contractEndDate')}>
        {(p) => <Input {...p} type="date" value={value.contractEndDate} onChange={set('contractEndDate')} />}
      </Field>
      <Field label="Internal notes" error={err('internalNotes')} className="sm:col-span-2">
        {(p) => <Textarea {...p} value={value.internalNotes} onChange={set('internalNotes')} />}
      </Field>
    </Section>
  );
}

export function ContactFields({ value, onChange, errors, prefix }: { value: ContactForm; onChange: (v: ContactForm) => void; errors: Errors; prefix: string }) {
  const set = (k: keyof Omit<ContactForm, 'roles'>) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const err = (k: string) => errors[`${prefix}${k}`];
  const toggle = (r: ContactRole) =>
    onChange({ ...value, roles: value.roles.includes(r) ? value.roles.filter((x) => x !== r) : [...value.roles, r] });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Full name" required error={err('fullName')}>
        {(p) => <Input {...p} value={value.fullName} onChange={set('fullName')} autoComplete="off" />}
      </Field>
      <Field label="Job title" error={err('jobTitle')}>
        {(p) => <Input {...p} value={value.jobTitle} onChange={set('jobTitle')} />}
      </Field>
      <Field label="Email" required error={err('email')}>
        {(p) => <Input {...p} type="email" value={value.email} onChange={set('email')} autoComplete="off" />}
      </Field>
      <Field label="Phone" error={err('phone')}>
        {(p) => <Input {...p} type="tel" value={value.phone} onChange={set('phone')} placeholder="+1 555 0100" />}
      </Field>
      <Field label="Mobile" error={err('mobile')}>
        {(p) => <Input {...p} type="tel" value={value.mobile} onChange={set('mobile')} />}
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">Roles</legend>
        <div className="mt-2 flex flex-wrap gap-2" role="group">
          {CONTACT_ROLES.map((r) => {
            const on = value.roles.includes(r);
            return (
              <label
                key={r}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600',
                  on ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                )}
              >
                <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(r)} />
                {r === 'primary' ? <Star className="size-3.5" aria-hidden="true" /> : null}
                {CONTACT_ROLE_LABEL[r]}
              </label>
            );
          })}
        </div>
        {err('roles') ? <p className="mt-1.5 text-xs font-medium text-red-700" role="alert">{err('roles')}</p> : null}
      </fieldset>
    </div>
  );
}

export function ContactListFields({ value, onChange, errors, prefix = 'contacts' }: { value: ContactForm[]; onChange: (v: ContactForm[]) => void; errors: Errors; prefix?: string }) {
  const listError = errors[prefix];
  return (
    <fieldset className="border-t border-slate-100 pt-6">
      <legend className="sr-only">Contacts</legend>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900" aria-hidden="true">Contacts</h3>
          <p className="mt-0.5 text-[13px] text-slate-500">Add the primary, technical and billing contacts. Exactly one contact is the primary contact.</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...value, emptyContact(value.length ? [] : ['primary'])])} disabled={value.length >= 25}>
          <Plus /> Add contact
        </Button>
      </div>
      {listError ? <p className="mt-3 text-xs font-medium text-red-700" role="alert">{listError}</p> : null}
      <ol className="mt-4 space-y-4">
        {value.map((c, i) => (
          <li key={i} className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[13px] font-semibold text-slate-700">
                Contact {i + 1}
                {c.roles.includes('primary') ? <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">Primary</span> : null}
              </p>
              {value.length > 1 ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove contact ${i + 1}`}>
                  <Trash2 /> Remove
                </Button>
              ) : null}
            </div>
            <ContactFields value={c} onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))} errors={errors} prefix={`${prefix}.${i}.`} />
          </li>
        ))}
      </ol>
    </fieldset>
  );
}
