import { COUNTRY_CODES } from '@psacc/contracts';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryName(code: string | null | undefined): string {
  if (!code) return '—';
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name));

export function timeZones(current?: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  const list = all.includes('UTC') ? all : ['UTC', ...all];
  return current && !list.includes(current) ? [current, ...list] : list;
}

/** Call from server components and pass down: keeps hydration deterministic across ICU versions. */
export function referenceLists() {
  return { countries: COUNTRY_OPTIONS, timezones: timeZones() };
}

export const CLIENT_STATUS_LABEL: Record<string, string> = {
  prospect: 'Prospect',
  onboarding: 'Onboarding',
  active: 'Active',
  suspended: 'Suspended',
  offboarded: 'Offboarded',
};
export const SERVICE_STATUS_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  live: 'Live',
  paused: 'Paused',
  terminated: 'Terminated',
};
export const CONTACT_ROLE_LABEL: Record<string, string> = {
  primary: 'Primary',
  technical: 'Technical',
  billing: 'Billing',
  escalation: 'Escalation',
  other: 'Other',
};
export const ENVIRONMENT_LABEL: Record<string, string> = {
  windows_docker: 'Windows Docker host',
  linux_docker: 'Linux Docker host',
  virtual_machine: 'Virtual machine',
  client_server: 'Client server',
  cloud_vm: 'Cloud VM',
  local_test: 'Local testing environment',
};
export const AUTH_METHOD_LABEL: Record<string, string> = {
  api_user: 'API user (username + secret + integration code)',
  api_member_keys: 'API member (public + private key)',
  oauth2_client_credentials: 'OAuth 2.0 client credentials',
  api_token: 'API token',
  api_key: 'API key',
  oauth2: 'OAuth 2.0',
  basic: 'Basic authentication',
};
export const CREDENTIAL_STATUS_LABEL: Record<string, string> = {
  not_configured: 'Not configured',
  pending_appliance: 'Pending — entered on the appliance',
  configured: 'Configured',
  invalid: 'Invalid',
  expired: 'Expired',
};
