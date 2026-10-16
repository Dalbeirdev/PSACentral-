import {
  buildConfigSchema,
  isHttpsUrlWithoutCredentials,
  type PsaProviderDescriptor,
  type PsaProviderKey,
} from '@psacc/contracts';

export type PsaConfig = Record<string, string | number | boolean>;
export interface ValidationIssue {
  path: string;
  message: string;
}

export type ConfigValidationResult =
  | { ok: true; config: PsaConfig; endpoint: string }
  | { ok: false; issues: ValidationIssue[] };

/**
 * The control-plane side of a PSA adapter: configuration metadata only. Everything vendor-specific
 * about configuration rules and endpoint derivation lives behind this interface, one class per
 * provider, so services never branch on the provider key.
 *
 * By design there is no connection or API method here. Authentication, connection tests, ticket
 * processing and synchronization run inside the client's Docker environment (the edge adapter,
 * Modules 11–12), which reports only sanitized status back. The control plane never calls a PSA API.
 */
export interface PsaAdapter {
  readonly descriptor: PsaProviderDescriptor;
  readonly key: PsaProviderKey;
  /** Validates non-secret configuration for an auth method and derives the API endpoint. */
  parseConfig(input: unknown, authMethod: string): ConfigValidationResult;
}

export abstract class BasePsaAdapter implements PsaAdapter {
  private readonly schema;

  constructor(readonly descriptor: PsaProviderDescriptor) {
    this.schema = buildConfigSchema(descriptor);
  }

  get key(): PsaProviderKey {
    return this.descriptor.key;
  }

  /** Vendor API base URL derived from validated configuration. */
  protected abstract deriveEndpoint(config: PsaConfig): string;

  /** Cross-field / auth-method-specific rules. */
  protected validate(_config: PsaConfig, _authMethod: string): ValidationIssue[] {
    return [];
  }

  parseConfig(input: unknown, authMethod: string): ConfigValidationResult {
    const issues: ValidationIssue[] = [];
    if (!this.descriptor.authMethods.some((m) => m.key === authMethod)) {
      issues.push({ path: 'authMethod', message: `Choose an authentication method supported by ${this.descriptor.name}.` });
    }
    const parsed = this.schema.safeParse(input ?? {});
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        if (i.code === 'unrecognized_keys') {
          issues.push({ path: 'config', message: `Unknown configuration field(s): ${i.keys.join(', ')}. Credentials are never stored in configuration.` });
        } else {
          issues.push({ path: ['config', ...i.path.map(String)].join('.'), message: i.message });
        }
      }
      return { ok: false, issues };
    }
    issues.push(...this.validate(parsed.data, authMethod).map((i) => ({ ...i, path: `config.${i.path}` })));
    if (issues.length) return { ok: false, issues };
    const endpoint = this.deriveEndpoint(parsed.data).replace(/\/+$/, '');
    if (!isHttpsUrlWithoutCredentials(endpoint)) {
      return { ok: false, issues: [{ path: 'config', message: 'The configuration does not produce a valid https:// API endpoint.' }] };
    }
    return { ok: true, config: parsed.data, endpoint };
  }
}

export const trimUrl = (u: string) => u.replace(/\/+$/, '');
