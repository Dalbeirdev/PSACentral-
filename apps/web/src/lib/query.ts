/** Builds a same-page href with merged query parameters (empty values removed). */
export function hrefWith(path: string, current: Record<string, string | undefined>, changes: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...changes })) {
    if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Picks only known keys from Next.js searchParams (drops arrays / unknown keys). */
export function pickParams<K extends string>(raw: Record<string, string | string[] | undefined>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0 && v.length <= 200) out[k] = v;
  }
  return out;
}
