import { AUTOTASK, CONNECTWISE, CUSTOM_REST, FRESHSERVICE, HALOPSA, KASEYA_BMS, SERVICENOW } from '@psacc/contracts';
import { BasePsaAdapter, type PsaConfig, trimUrl, type ValidationIssue } from './psa-adapter.js';

/** Autotask REST: https://webservicesN.autotask.net/ATServicesRest */
export class AutotaskAdapter extends BasePsaAdapter {
  constructor() {
    super(AUTOTASK);
  }
  protected deriveEndpoint(c: PsaConfig): string {
    const base = c.zone === 'custom' ? trimUrl(String(c.customZoneUrl)) : `https://${String(c.zone)}.autotask.net`;
    return `${base}/ATServicesRest`;
  }
  protected override validate(c: PsaConfig): ValidationIssue[] {
    if (c.zone === 'custom' && !/\.autotask\.net$/i.test(new URL(String(c.customZoneUrl)).hostname)) {
      return [{ path: 'customZoneUrl', message: 'Autotask zone URLs end in .autotask.net.' }];
    }
    return [];
  }
}

/** ConnectWise PSA (Manage) REST: https://api-<site>.myconnectwise.net/v4_6_release/apis/3.0 */
export class ConnectWiseAdapter extends BasePsaAdapter {
  constructor() {
    super(CONNECTWISE);
  }
  protected deriveEndpoint(c: PsaConfig): string {
    const host = c.site === 'onprem' ? String(c.onPremHost) : `api-${String(c.site)}.myconnectwise.net`;
    return `https://${host}/v4_6_release/apis/3.0`;
  }
}

/** HaloPSA resource server: <tenant URL>/api */
export class HaloPsaAdapter extends BasePsaAdapter {
  constructor() {
    super(HALOPSA);
  }
  protected deriveEndpoint(c: PsaConfig): string {
    return `${trimUrl(String(c.tenantUrl))}/api`;
  }
  protected override validate(c: PsaConfig): ValidationIssue[] {
    const u = new URL(String(c.tenantUrl));
    return u.pathname !== '/' && u.pathname !== '' ? [{ path: 'tenantUrl', message: 'Enter only the Halo address (no path), e.g. https://yourcompany.halopsa.com.' }] : [];
  }
}

/** Kaseya BMS: https://<region>/api */
export class KaseyaBmsAdapter extends BasePsaAdapter {
  constructor() {
    super(KASEYA_BMS);
  }
  protected deriveEndpoint(c: PsaConfig): string {
    return `https://${String(c.region)}/api`;
  }
}

/** Freshservice API v2: https://<domain>/api/v2 */
export class FreshserviceAdapter extends BasePsaAdapter {
  constructor() {
    super(FRESHSERVICE);
  }
  protected deriveEndpoint(c: PsaConfig): string {
    return `https://${String(c.domain)}/api/v2`;
  }
}

/** ServiceNow REST: <instance URL>/api/now */
export class ServiceNowAdapter extends BasePsaAdapter {
  constructor() {
    super(SERVICENOW);
  }
  protected deriveEndpoint(c: PsaConfig): string {
    return `${trimUrl(String(c.instanceUrl))}/api/now`;
  }
}

/** Custom REST: the configured base URL. OAuth needs a token URL. */
export class CustomRestAdapter extends BasePsaAdapter {
  constructor() {
    super(CUSTOM_REST);
  }
  protected deriveEndpoint(c: PsaConfig): string {
    return trimUrl(String(c.baseUrl));
  }
  protected override validate(c: PsaConfig, authMethod: string): ValidationIssue[] {
    return authMethod === 'oauth2_client_credentials' && !c.tokenUrl ? [{ path: 'tokenUrl', message: 'OAuth token URL is required for OAuth 2.0.' }] : [];
  }
}
