import type { PsaProviderDefinition, PsaProviderKey } from '../common.js';
import type { PsaCapabilities, PsaProviderDescriptor } from './types.js';

const ALL_CAPS: PsaCapabilities = {
  tickets: true, ticketNotes: true, timeEntries: true, companies: true, contacts: true,
  configurationItems: true, slaFields: true, attachments: true, webhooks: true,
};

const optionalNumber = (key: string, label: string, hint: string) => ({ key, label, type: 'number' as const, min: 0, max: 2_147_483_647, hint });

export const AUTOTASK: PsaProviderDescriptor = {
  key: 'autotask',
  name: 'Autotask PSA',
  vendor: 'Kaseya (Datto)',
  description: 'REST API on the tenant’s regional web-services zone.',
  docsUrl: 'https://autotask.net/help/developerhelp/Content/APIs/REST/REST_API_Home.htm',
  adapterStatus: 'config_only',
  sortOrder: 10,
  authMethods: [
    {
      key: 'api_user',
      label: 'API user (username + secret + integration code)',
      credentialFields: [
        { key: 'username', label: 'API user name', secret: false },
        { key: 'secret', label: 'API user secret', secret: true },
        { key: 'integrationCode', label: 'API tracking identifier (integration code)', secret: true },
      ],
    },
  ],
  configFields: [
    {
      key: 'zone',
      label: 'Web services zone',
      type: 'select',
      required: true,
      hint: 'Shown in Autotask under Admin → Resources (API user) or returned by the zone-information API.',
      options: [
        ...Array.from({ length: 24 }, (_, i) => ({ value: `webservices${i + 1}`, label: `webservices${i + 1}.autotask.net` })),
        { value: 'custom', label: 'Other (enter URL)' },
      ],
    },
    { key: 'customZoneUrl', label: 'Zone URL', type: 'url', required: true, placeholder: 'https://webservicesN.autotask.net', showWhen: { field: 'zone', equals: 'custom' } },
    optionalNumber('impersonationResourceId', 'Impersonation resource ID', 'Optional. Tickets are created as this resource.'),
    optionalNumber('defaultQueueId', 'Default queue ID', 'Optional. Queue for new tickets.'),
  ],
  capabilities: ALL_CAPS,
};

export const CONNECTWISE: PsaProviderDescriptor = {
  key: 'connectwise',
  name: 'ConnectWise PSA',
  vendor: 'ConnectWise',
  description: 'Manage REST API (v4_6_release, API 3.0) on the cloud region or an on-premise server.',
  docsUrl: 'https://developer.connectwise.com/Products/ConnectWise_PSA',
  adapterStatus: 'config_only',
  sortOrder: 20,
  authMethods: [
    {
      key: 'api_member_keys',
      label: 'API member keys (public + private key)',
      credentialFields: [
        { key: 'publicKey', label: 'Public key', secret: false },
        { key: 'privateKey', label: 'Private key', secret: true },
        { key: 'clientId', label: 'Integration client ID', secret: false },
      ],
    },
  ],
  configFields: [
    {
      key: 'site',
      label: 'Site',
      type: 'select',
      required: true,
      options: [
        { value: 'na', label: 'North America (na.myconnectwise.net)' },
        { value: 'eu', label: 'Europe (eu.myconnectwise.net)' },
        { value: 'au', label: 'Australia (au.myconnectwise.net)' },
        { value: 'za', label: 'South Africa (za.myconnectwise.net)' },
        { value: 'onprem', label: 'On-premise server' },
      ],
    },
    { key: 'onPremHost', label: 'Server host name', type: 'host', required: true, placeholder: 'psa.company.com', showWhen: { field: 'site', equals: 'onprem' } },
    { key: 'companyId', label: 'Company ID', type: 'text', required: true, pattern: '^[A-Za-z0-9_-]{2,40}$', patternMessage: 'Use the login company identifier (letters, numbers, - and _).', hint: 'The company identifier used at sign-in.' },
    { key: 'defaultBoard', label: 'Default service board', type: 'text', maxLength: 100, hint: 'Optional. Board for new tickets.' },
  ],
  capabilities: ALL_CAPS,
};

export const HALOPSA: PsaProviderDescriptor = {
  key: 'halopsa',
  name: 'HaloPSA',
  vendor: 'Halo Service Solutions',
  description: 'REST API with OAuth 2.0 client credentials, hosted or self-hosted.',
  docsUrl: 'https://halopsa.com/apidoc/',
  adapterStatus: 'config_only',
  sortOrder: 30,
  authMethods: [
    {
      key: 'oauth2_client_credentials',
      label: 'OAuth 2.0 client credentials',
      credentialFields: [
        { key: 'clientId', label: 'Client ID', secret: false },
        { key: 'clientSecret', label: 'Client secret', secret: true },
      ],
    },
  ],
  configFields: [
    { key: 'tenantUrl', label: 'Halo URL', type: 'url', required: true, placeholder: 'https://yourcompany.halopsa.com', hint: 'The address users sign in to.' },
    { key: 'tenant', label: 'Tenant name', type: 'text', maxLength: 100, pattern: '^[A-Za-z0-9_-]+$', patternMessage: 'Letters, numbers, - and _ only.', hint: 'Hosted instances only, if Halo provided one.' },
    { key: 'scope', label: 'OAuth scope', type: 'text', default: 'all', maxLength: 200 },
    optionalNumber('defaultTicketTypeId', 'Default ticket type ID', 'Optional.'),
  ],
  capabilities: { ...ALL_CAPS, webhooks: true },
};

export const KASEYA_BMS: PsaProviderDescriptor = {
  key: 'kaseya_bms',
  name: 'Kaseya BMS',
  vendor: 'Kaseya',
  description: 'BMS REST API with token authentication per tenant.',
  docsUrl: 'https://help.bms.kaseya.com/help/Content/0_Home/Home.htm',
  adapterStatus: 'config_only',
  sortOrder: 40,
  authMethods: [
    {
      key: 'username_password',
      label: 'API user name and password',
      credentialFields: [
        { key: 'username', label: 'User name', secret: false },
        { key: 'password', label: 'Password', secret: true },
      ],
    },
  ],
  configFields: [
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      required: true,
      options: [
        { value: 'bms.kaseya.com', label: 'North America (bms.kaseya.com)' },
        { value: 'bmsemea.kaseya.com', label: 'EMEA (bmsemea.kaseya.com)' },
        { value: 'bmsapac.kaseya.com', label: 'APAC (bmsapac.kaseya.com)' },
      ],
    },
    { key: 'tenant', label: 'Company (tenant) name', type: 'text', required: true, maxLength: 100 },
    { key: 'defaultQueue', label: 'Default queue', type: 'text', maxLength: 100 },
  ],
  capabilities: { ...ALL_CAPS, webhooks: false },
};

export const FRESHSERVICE: PsaProviderDescriptor = {
  key: 'freshservice',
  name: 'Freshservice',
  vendor: 'Freshworks',
  description: 'Freshservice API v2 on the account domain.',
  docsUrl: 'https://api.freshservice.com/',
  adapterStatus: 'config_only',
  sortOrder: 50,
  authMethods: [{ key: 'api_key', label: 'API key', credentialFields: [{ key: 'apiKey', label: 'API key', secret: true }] }],
  configFields: [
    { key: 'domain', label: 'Account domain', type: 'host', required: true, placeholder: 'yourcompany.freshservice.com' },
    optionalNumber('workspaceId', 'Workspace ID', 'Optional, for multi-workspace accounts.'),
    optionalNumber('defaultGroupId', 'Default agent group ID', 'Optional.'),
  ],
  capabilities: { ...ALL_CAPS, timeEntries: true, slaFields: true },
};

export const SERVICENOW: PsaProviderDescriptor = {
  key: 'servicenow',
  name: 'ServiceNow',
  vendor: 'ServiceNow',
  description: 'Table API on the client’s ServiceNow instance.',
  docsUrl: 'https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI',
  adapterStatus: 'config_only',
  sortOrder: 60,
  authMethods: [
    {
      key: 'oauth2_password',
      label: 'OAuth 2.0 (password grant)',
      credentialFields: [
        { key: 'clientId', label: 'Client ID', secret: false },
        { key: 'clientSecret', label: 'Client secret', secret: true },
        { key: 'username', label: 'Integration user', secret: false },
        { key: 'password', label: 'Integration user password', secret: true },
      ],
    },
    {
      key: 'basic',
      label: 'Basic authentication',
      credentialFields: [
        { key: 'username', label: 'Integration user', secret: false },
        { key: 'password', label: 'Password', secret: true },
      ],
    },
  ],
  configFields: [
    { key: 'instanceUrl', label: 'Instance URL', type: 'url', required: true, placeholder: 'https://yourinstance.service-now.com' },
    { key: 'incidentTable', label: 'Ticket table', type: 'text', default: 'incident', pattern: '^[a-z][a-z0-9_]{1,79}$', patternMessage: 'A ServiceNow table name, e.g. incident.' },
    { key: 'assignmentGroup', label: 'Default assignment group', type: 'text', maxLength: 100 },
  ],
  capabilities: { ...ALL_CAPS, timeEntries: false },
};

export const CUSTOM_REST: PsaProviderDescriptor = {
  key: 'custom_rest',
  name: 'Custom PSA / REST API',
  vendor: 'Custom',
  description: 'Any PSA exposing a REST ticket API. Mapping is configured during integration (Module 11).',
  docsUrl: '',
  adapterStatus: 'config_only',
  sortOrder: 90,
  authMethods: [
    { key: 'api_key', label: 'API key', credentialFields: [{ key: 'apiKey', label: 'API key', secret: true }] },
    {
      key: 'oauth2_client_credentials',
      label: 'OAuth 2.0 client credentials',
      credentialFields: [
        { key: 'clientId', label: 'Client ID', secret: false },
        { key: 'clientSecret', label: 'Client secret', secret: true },
      ],
    },
    {
      key: 'basic',
      label: 'Basic authentication',
      credentialFields: [
        { key: 'username', label: 'User name', secret: false },
        { key: 'password', label: 'Password', secret: true },
      ],
    },
  ],
  configFields: [
    { key: 'baseUrl', label: 'API base URL', type: 'url', required: true, placeholder: 'https://psa.example.com/api' },
    { key: 'ticketsPath', label: 'Tickets path', type: 'text', default: '/tickets', pattern: '^/[A-Za-z0-9/_.-]*$', patternMessage: 'A path starting with /.' },
    { key: 'healthPath', label: 'Health-check path', type: 'text', pattern: '^/[A-Za-z0-9/_.-]*$', patternMessage: 'A path starting with /.' },
    { key: 'apiKeyHeader', label: 'API key header', type: 'text', default: 'X-API-Key', pattern: '^[A-Za-z0-9-]{1,64}$', patternMessage: 'A valid HTTP header name.' },
    { key: 'tokenUrl', label: 'OAuth token URL', type: 'url', hint: 'Only for OAuth 2.0.' },
    {
      key: 'pagination',
      label: 'Pagination style',
      type: 'select',
      default: 'page',
      options: [
        { value: 'none', label: 'None' },
        { value: 'page', label: 'Page number' },
        { value: 'cursor', label: 'Cursor' },
      ],
    },
  ],
  capabilities: { tickets: true, ticketNotes: true, timeEntries: false, companies: false, contacts: false, configurationItems: false, slaFields: false, attachments: false, webhooks: false },
};

export const PSA_PROVIDER_DESCRIPTORS: Record<PsaProviderKey, PsaProviderDescriptor> = {
  autotask: AUTOTASK,
  connectwise: CONNECTWISE,
  halopsa: HALOPSA,
  kaseya_bms: KASEYA_BMS,
  freshservice: FRESHSERVICE,
  servicenow: SERVICENOW,
  custom_rest: CUSTOM_REST,
};

/** Flat catalog (synced to the psa_providers table as reference data). Derived from the descriptors. */
export const PSA_PROVIDER_CATALOG: readonly PsaProviderDefinition[] = Object.values(PSA_PROVIDER_DESCRIPTORS)
  .sort((a, b) => a.sortOrder - b.sortOrder)
  .map((d) => ({ key: d.key, name: d.name, vendor: d.vendor, authMethods: d.authMethods.map((m) => m.key), adapterStatus: d.adapterStatus, sortOrder: d.sortOrder }));
