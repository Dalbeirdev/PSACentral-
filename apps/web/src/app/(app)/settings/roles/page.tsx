import type { RoleSummary } from '@psacc/contracts';
import { PERMISSIONS, type PermissionKey } from '@psacc/contracts';
import { Check, Lock } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Roles & permissions' };

export default async function RolesPage() {
  const me = await requireActiveSession();
  if (!can(me, 'roles.read')) notFound();
  const roles = await apiGet<RoleSummary[]>('/roles');
  const crumbs = [{ label: 'Settings', href: '/settings' }, { label: 'Roles & permissions' }];
  if (!roles.ok) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title="Roles & permissions" />
        <Card><ErrorState problem={roles.problem} /></Card>
      </>
    );
  }
  const byCategory = new Map<string, PermissionKey[]>();
  for (const [key, def] of Object.entries(PERMISSIONS) as [PermissionKey, (typeof PERMISSIONS)[PermissionKey]][]) {
    byCategory.set(def.category, [...(byCategory.get(def.category) ?? []), key]);
  }

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title="Roles & permissions"
        description="Authorization is enforced by the API on every request, and client scope is also enforced by database row-level security. System roles are fixed; custom roles can be added in a later module."
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {roles.data.map((r) => (
          <Card key={r.id} className="p-5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">{r.name}</p>
              {r.isSystem ? <Badge className="h-5 px-1.5 text-[11px]"><Lock /> System</Badge> : null}
            </div>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">{r.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone={r.scope === 'all_clients' ? 'blue' : 'amber'}>{r.scope === 'all_clients' ? 'All clients' : 'Assigned clients'}</Badge>
              <Badge>{r.permissions.length} permissions</Badge>
              <Badge>{r.userCount} user{r.userCount === 1 ? '' : 's'}</Badge>
            </div>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="Permission matrix" description="✓ = granted by the role" className="pb-4" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-separate border-spacing-0 text-left text-[13px]">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-slate-500">Permission</th>
                {roles.data.map((r) => (
                  <th key={r.id} scope="col" className="border-b border-slate-200 bg-slate-50 px-2 py-2.5 text-center text-[11.5px] font-semibold text-slate-600">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...byCategory.entries()].map(([category, keys]) => (
                <CategoryRows key={category} category={category} keys={keys} roles={roles.data} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function CategoryRows({ category, keys, roles }: { category: string; keys: PermissionKey[]; roles: RoleSummary[] }) {
  return (
    <>
      <tr>
        <th colSpan={roles.length + 1} scope="colgroup" className="border-b border-slate-100 bg-white px-5 pb-1.5 pt-4 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-blue-700">
          {category}
        </th>
      </tr>
      {keys.map((k) => (
        <tr key={k} className="hover:bg-slate-50/70">
          <th scope="row" className="sticky left-0 border-b border-slate-100 bg-white px-5 py-2 font-normal">
            <span className="font-mono text-[12px] text-slate-800">{k}</span>
            <span className="block text-xs text-slate-500">{PERMISSIONS[k].description}</span>
          </th>
          {roles.map((r) => (
            <td key={r.id} className="border-b border-slate-100 px-2 py-2 text-center">
              {r.permissions.includes(k) ? (
                <Check className="mx-auto size-4 text-emerald-600" aria-label="Granted" />
              ) : (
                <span className="text-slate-300" aria-label="Not granted">·</span>
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
