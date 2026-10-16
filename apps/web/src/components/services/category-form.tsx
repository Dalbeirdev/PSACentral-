'use client';

import type { ServiceCategoryDto } from '@psacc/contracts';
import { serviceCategoryCreateSchema, serviceCategoryUpdateSchema, suggestServiceKey } from '@psacc/contracts';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, fieldErrors, zodErrors } from '@/lib/api-client';

/** Create or rename / reorder a category. Keys are fixed once created. */
export function CategoryForm({ category }: { category?: ServiceCategoryDto }) {
  const router = useRouter();
  const editing = !!category;
  const [name, setName] = useState(category?.name ?? '');
  const [key, setKey] = useState(category?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(editing);
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 100));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name, sortOrder: sortOrder.trim() === '' ? 100 : Number(sortOrder) };
    const parsed = editing ? serviceCategoryUpdateSchema.safeParse({ ...body, version: category!.version }) : serviceCategoryCreateSchema.safeParse({ ...body, key: key.slice(0, 41) });
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      return setError('Some fields need attention.');
    }
    setBusy(true);
    const r = editing
      ? await apiMutate<ServiceCategoryDto>('PATCH', `/service-categories/${category!.id}`, parsed.data)
      : await apiMutate<ServiceCategoryDto>('POST', '/service-categories', parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setStale(r.problem.type === 'urn:psacc:problem:stale-version');
      return setError(r.problem.type === 'urn:psacc:problem:validation' ? 'Some fields need attention.' : (r.problem.detail ?? 'The category could not be saved.'));
    }
    router.push(`/services/categories?saved=${editing ? 'updated' : 'created'}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {error ? (
        <Alert variant="error" actions={stale ? <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload latest</Button> : undefined}>
          {error}
        </Alert>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Category name" required error={errors.name}>
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(suggestServiceKey(e.target.value).slice(0, 41));
              }}
            />
          )}
        </Field>
        <Field label="Key" required error={errors.key} hint={editing ? 'Fixed once created.' : 'Lowercase letters, digits and underscores.'}>
          {(p) => (
            <Input
              {...p}
              value={key}
              readOnly={editing}
              className="font-mono"
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Sort order" error={errors.sortOrder} hint="Lower numbers come first.">
          {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={10000} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-5">
        <ButtonLink href="/services/categories" variant="secondary"><ArrowLeft /> Cancel</ButtonLink>
        <Button type="submit" loading={busy}>{editing ? 'Save category' : 'Create category'}</Button>
      </div>
    </form>
  );
}

/** Deletes an empty category after an inline confirmation. Categories with services cannot be deleted (the API refuses). */
export function CategoryDelete({ category }: { category: ServiceCategoryDto }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const r = await apiMutate('DELETE', `/service-categories/${category.id}`);
    setBusy(false);
    setConfirm(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The category could not be deleted.');
    router.push('/services/categories?saved=deleted');
    router.refresh();
  }

  if (category.serviceCount > 0) {
    return <p className="text-[13px] text-slate-500">This category has {category.serviceCount} service(s). Move them to another category before deleting it.</p>;
  }
  return (
    <div className="space-y-2">
      {error ? <Alert variant="error" className="py-2 text-[13px]">{error}</Alert> : null}
      {!confirm ? (
        <Button variant="danger" onClick={() => setConfirm(true)}><Trash2 /> Delete category</Button>
      ) : (
        <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200" role="group" aria-label="Confirm deletion">
          <p className="text-[13px] text-amber-900">Delete {category.name}? It has no services. This is recorded in the audit history.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="danger" loading={busy} onClick={run}>Yes, delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
