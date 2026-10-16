/** Formatting helpers. All timestamps render in the user's preferred time zone. */

export function formatDateTime(iso: string | null | undefined, timeZone: string, opts: { seconds?: boolean } = {}): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** Calendar dates (YYYY-MM-DD) have no time zone: render them as-is, never shifted. */
export function formatCalendarDate(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T00:00:00Z`));
}

export function daysUntil(ymd: string, now = new Date()): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - today) / 86_400_000);
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(new Date(iso));
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 45) return rtf.format(diff, 'second');
  if (abs < 2700) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 64_800) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 2_592_000) return rtf.format(Math.round(diff / 86_400), 'day');
  return rtf.format(Math.round(diff / 2_592_000), 'month');
}

export function greeting(timeZone: string, now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(now)) % 24;
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function humanize(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function percent(part: number, whole: number): string {
  if (!whole) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Only same-origin absolute paths are allowed as post-login redirect targets. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.startsWith('/login')) return null;
  return next;
}
