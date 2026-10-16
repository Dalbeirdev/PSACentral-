'use client';

import type { AppEnvironment } from '@psacc/contracts';
import { Bell, LogOut, Menu, Search, Shield, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/button';
import { apiMutate, navigateTo } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';
import { DELIVERED_MODULES, NAV, sectionFor } from '@/lib/nav';
import { Logo, LogoMark } from './logo';
import { NavIcon } from './nav-icon';

export interface ShellUser {
  displayName: string;
  email: string;
  organizationName: string;
  roleNames: string[];
  permissions: string[];
  clientScope: 'all_clients' | 'assigned_clients';
}

const ENV_STYLE: Record<AppEnvironment, { label: string; className: string }> = {
  development: { label: 'Development', className: 'bg-blue-50 text-blue-700 ring-blue-200/80' },
  test: { label: 'Test', className: 'bg-violet-50 text-violet-700 ring-violet-100' },
  staging: { label: 'Staging', className: 'bg-amber-50 text-amber-800 ring-amber-200' },
  production: { label: 'Production', className: 'bg-white text-red-700 ring-red-300' },
};

export function EnvBadge({ env, version }: { env: AppEnvironment | null; version?: string | null }) {
  if (!env) return <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-500 ring-1 ring-slate-200">API offline</span>;
  const s = ENV_STYLE[env];
  return (
    <span
      className={cn('inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold ring-1 ring-inset', s.className)}
      title={`Environment: ${s.label}${version ? ` · v${version}` : ''}`}
      data-testid="env-badge"
    >
      <span className={cn('size-1.5 rounded-full', env === 'production' ? 'bg-red-500' : env === 'staging' ? 'bg-amber-500' : env === 'test' ? 'bg-violet-500' : 'bg-blue-600')} aria-hidden="true" />
      {s.label}
    </span>
  );
}

function NavLinks({ permissions, onNavigate }: { permissions: string[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="space-y-6">
      {NAV.map((group, gi) => {
        const items = group.items.filter((i) => i.permission === null || permissions.includes(i.permission));
        if (!items.length) return null;
        return (
          <div key={group.label ?? gi}>
            {group.label ? <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{group.label}</p> : null}
            <ul className="space-y-0.5">
              {items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const planned = !DELIVERED_MODULES.has(item.module);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'group relative flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition-colors',
                        active ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900',
                      )}
                    >
                      {active ? <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-blue-600" aria-hidden="true" /> : null}
                      <NavIcon name={item.icon} className={cn('size-[18px]', active ? 'text-blue-600' : 'text-slate-400 group-hover:text-slate-600')} />
                      <span className="flex-1 truncate">{item.label}</span>
                      {planned ? (
                        <span className="rounded px-1 text-[10px] font-semibold tracking-wide text-slate-600 ring-1 ring-slate-200" title={`Planned for Module ${item.module}`}>
                          M{item.module}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function UserMenu({ user }: { user: ShellUser }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    await apiMutate('POST', '/auth/logout');
    navigateTo('/login?signedOut=1');
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${user.displayName}`}
        className="flex items-center gap-2.5 rounded-xl p-1 pr-2 transition-colors hover:bg-slate-100"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-slate-800 to-slate-600 text-[12px] font-semibold text-white">
          {initials(user.displayName)}
        </span>
        <span className="hidden text-left leading-tight xl:block">
          <span className="block text-[13px] font-semibold text-slate-800">{user.displayName}</span>
          <span className="block max-w-40 truncate text-[11.5px] text-slate-500">{user.roleNames[0] ?? 'No role'}</span>
        </span>
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="truncate text-sm font-semibold text-slate-900">{user.displayName}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            <p className="mt-1 truncate text-xs text-slate-500">{user.roleNames.join(', ')}</p>
          </div>
          <div className="p-1.5">
            <Link role="menuitem" href="/settings/profile" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-100">
              <UserRound className="size-4 text-slate-400" /> Profile
            </Link>
            <Link role="menuitem" href="/settings/security" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-100">
              <Shield className="size-4 text-slate-400" /> Security & MFA
            </Link>
            <button role="menuitem" type="button" onClick={signOut} disabled={signingOut} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-red-50 hover:text-red-700">
              {signingOut ? <Spinner /> : <LogOut className="size-4 text-slate-400" />} Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({
  user,
  env,
  version,
  notificationCount,
  children,
}: {
  user: ShellUser;
  env: AppEnvironment | null;
  version: string | null;
  notificationCount: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [pathname]);
  const section = sectionFor(pathname);

  return (
    <div className="app-backdrop min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow-pop">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] flex-col border-r border-slate-200/80 bg-white/95 lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/dashboard" aria-label="PSA Control Center — Overview">
            <Logo />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-6 pt-4">
          <NavLinks permissions={user.permissions} />
        </div>
        <div className="border-t border-slate-100 p-3">
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/70">
            <p className="truncate text-[12.5px] font-semibold text-slate-800" title={user.organizationName}>
              {user.organizationName}
            </p>
            <p className="text-[11.5px] text-slate-500">{user.clientScope === 'all_clients' ? 'Access: all clients' : 'Access: assigned clients only'}</p>
          </div>
        </div>
      </aside>

      <div className="lg:pl-[264px]">
        <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/80 backdrop-blur-md">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              className="inline-flex size-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden"
              onClick={() => setMobileOpen((v) => !v)}
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
              aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
            <Link href="/dashboard" className="lg:hidden" aria-label="Overview">
              <LogoMark className="size-8" />
            </Link>
            <p className="hidden min-w-0 truncate text-[15px] font-semibold text-slate-900 md:block" data-testid="topbar-title">
              {section}
            </p>

            <form action="/search" role="search" className="mx-auto w-full max-w-md flex-1 md:ml-8">
              <label htmlFor="global-search" className="sr-only">
                Search clients, deployments and PSA instances
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <input
                  id="global-search"
                  name="q"
                  type="search"
                  minLength={2}
                  maxLength={100}
                  placeholder="Search clients, deployments…"
                  className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50/80 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-600/10"
                />
              </div>
            </form>

            <div className="flex items-center gap-1.5 sm:gap-2.5">
              <span className="hidden sm:inline-flex">
                <EnvBadge env={env} version={version} />
              </span>
              <Link
                href="/notifications"
                className="relative inline-flex size-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                aria-label={notificationCount ? `Notifications (${notificationCount})` : 'Notifications'}
              >
                <Bell className="size-[18px]" />
                {notificationCount ? (
                  <span className="absolute right-1 top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-4 text-white ring-2 ring-white">
                    {notificationCount > 99 ? '99+' : notificationCount}
                  </span>
                ) : null}
              </Link>
              <UserMenu user={user} />
            </div>
          </div>

          {/* Mobile navigation expands inline (pushes content), never overlays it. */}
          {mobileOpen ? (
            <div id="mobile-nav" className="border-t border-slate-200/70 bg-white px-3 pb-5 pt-4 lg:hidden">
              <div className="mb-4 flex items-center justify-between px-3">
                <EnvBadge env={env} version={version} />
                <span className="text-xs text-slate-500">{user.organizationName}</span>
              </div>
              <NavLinks permissions={user.permissions} onNavigate={() => setMobileOpen(false)} />
            </div>
          ) : null}
        </header>

        <main id="main" className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
