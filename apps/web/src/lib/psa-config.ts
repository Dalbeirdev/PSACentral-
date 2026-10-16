import type { PsaProviderDescriptor } from '@psacc/contracts';

export type ConfigValues = Record<string, string | boolean>;

/** Turns stored config (numbers/booleans) into form values and fills defaults. */
export function initialConfig(descriptor: PsaProviderDescriptor, stored?: Record<string, unknown> | null): ConfigValues {
  const out: ConfigValues = {};
  for (const f of descriptor.configFields) {
    const v = stored?.[f.key] ?? f.default;
    out[f.key] = f.type === 'boolean' ? Boolean(v) : v === undefined || v === null ? '' : String(v);
  }
  return out;
}
