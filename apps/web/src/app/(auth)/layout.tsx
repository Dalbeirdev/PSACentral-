import { Activity, DatabaseZap, ScrollText, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { EnvBadge } from '@/components/shell/app-shell';
import { Logo, LogoMark } from '@/components/shell/logo';
import { getSystemInfo } from '@/lib/api-server';

const POINTS = [
  { icon: DatabaseZap, title: 'Isolated by design', text: 'Every client runs its own appliance and PostgreSQL database.' },
  { icon: ShieldCheck, title: 'Outbound-only edge', text: 'Agents connect out over mutual TLS. Nothing listens at the client.' },
  { icon: Activity, title: 'Real signals only', text: 'Health is reported by agents, never inferred or invented.' },
  { icon: ScrollText, title: 'Audited by default', text: 'Every sign-in and administrative change is recorded.' },
];

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const info = await getSystemInfo();
  return (
    <div className="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden bg-slate-950 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -left-24 -top-24 size-[520px] rounded-full bg-blue-600/30 blur-3xl" />
          <div className="absolute -bottom-32 right-[-80px] size-[460px] rounded-full bg-violet-500/25 blur-3xl" />
          <div className="absolute left-1/3 top-1/2 size-[300px] rounded-full bg-cyan-500/15 blur-3xl" />
          <svg className="absolute inset-0 size-full opacity-[0.07]" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
                <path d="M32 0H0V32" fill="none" stroke="white" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
        </div>
        <div className="relative flex items-center gap-3">
          <LogoMark />
          <span className="text-[15px] font-semibold tracking-tight text-white">PSA Control Center</span>
        </div>
        <div className="relative max-w-lg">
          <h2 className="text-[34px] font-semibold leading-[1.15] tracking-tight text-white">
            One control plane for every client appliance.
          </h2>
          <p className="mt-4 text-[15px] leading-7 text-slate-300">
            Onboard clients, connect their PSA, ship a deployment package and watch each installation report in, without ever mixing one client&apos;s data with another&apos;s.
          </p>
          <ul className="mt-10 grid gap-5 sm:grid-cols-2">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-cyan-300 ring-1 ring-white/15">
                  <p.icon className="size-[18px]" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-white">{p.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-slate-400">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-500">Internal operations tool · authorized personnel only · activity is audited</p>
      </aside>

      <main className="flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 sm:px-10">
          <span className="lg:invisible">
            <Logo subtitle="Sign in" />
          </span>
          <EnvBadge env={info?.environment ?? null} version={info?.version} />
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-16 pt-4 sm:px-10">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>
      </main>
    </div>
  );
}
