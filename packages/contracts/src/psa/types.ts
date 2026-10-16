import type { PsaAdapterStatus, PsaProviderKey } from '../common.js';

/**
 * Provider descriptors are *data*: they describe a PSA's non-secret configuration fields,
 * authentication methods and capabilities. The UI renders forms from them and the API validates
 * with the schema built from them. Vendor logic (endpoint derivation, cross-field rules and, from
 * Module 11, real API calls) lives in one adapter class per provider in the API.
 */
export type PsaFieldType = 'text' | 'url' | 'host' | 'select' | 'number' | 'boolean';

export interface PsaConfigField {
  key: string;
  label: string;
  type: PsaFieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  /** Regex the value must match (strings). */
  pattern?: string;
  patternMessage?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  default?: string | number | boolean;
  /** Only shown/required when another field has a given value. */
  showWhen?: { field: string; equals: string };
}

export interface PsaCredentialField {
  key: string;
  label: string;
  /** Secret values are entered on the appliance only and never reach the control plane. */
  secret: boolean;
}

export interface PsaAuthMethodDescriptor {
  key: string;
  label: string;
  credentialFields: PsaCredentialField[];
}

/** What the vendor API supports (modelled on desk-portal's ProviderCapabilities). Implemented from Module 12. */
export interface PsaCapabilities {
  tickets: boolean;
  ticketNotes: boolean;
  timeEntries: boolean;
  companies: boolean;
  contacts: boolean;
  configurationItems: boolean;
  slaFields: boolean;
  attachments: boolean;
  webhooks: boolean;
}

export interface PsaProviderDescriptor {
  key: PsaProviderKey;
  name: string;
  vendor: string;
  description: string;
  docsUrl: string;
  adapterStatus: PsaAdapterStatus;
  authMethods: PsaAuthMethodDescriptor[];
  configFields: PsaConfigField[];
  capabilities: PsaCapabilities;
  sortOrder: number;
}

export const CAPABILITY_LABELS: Record<keyof PsaCapabilities, string> = {
  tickets: 'Tickets',
  ticketNotes: 'Ticket notes',
  timeEntries: 'Time entries',
  companies: 'Companies',
  contacts: 'Contacts',
  configurationItems: 'Configuration items',
  slaFields: 'SLA fields',
  attachments: 'Attachments',
  webhooks: 'Webhooks',
};
