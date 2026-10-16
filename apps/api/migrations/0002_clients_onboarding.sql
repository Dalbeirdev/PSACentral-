-- 0002_clients_onboarding.sql
-- Module 2: client contacts, database-driven service catalog + client assignments,
-- server-side onboarding drafts, deployment host label.

-- ---------------------------------------------------------------------------
-- Client contacts (multiple per client, exactly one primary)
-- ---------------------------------------------------------------------------
CREATE TABLE client_contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  full_name        text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  job_title        text CHECK (job_title IS NULL OR length(job_title) <= 120),
  email            text NOT NULL CHECK (email = lower(email) AND length(email) <= 254 AND position('@' IN email) > 1),
  phone            text CHECK (phone IS NULL OR length(phone) <= 40),
  mobile           text CHECK (mobile IS NULL OR length(mobile) <= 40),
  roles            text[] NOT NULL CHECK (cardinality(roles) >= 1
                     AND roles <@ ARRAY['primary', 'technical', 'billing', 'escalation', 'other']::text[]),
  is_primary       boolean GENERATED ALWAYS AS ('primary' = ANY (roles)) STORED,
  notes            text CHECK (notes IS NULL OR length(notes) <= 2000),
  is_synthetic     boolean NOT NULL DEFAULT false,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_contacts_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX client_contacts_one_primary ON client_contacts (client_id) WHERE is_primary;
CREATE UNIQUE INDEX client_contacts_email_per_client ON client_contacts (client_id, email);
CREATE INDEX client_contacts_org_email_idx ON client_contacts (organization_id, email);
CREATE TRIGGER client_contacts_updated_at BEFORE UPDATE ON client_contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Service catalog (per organization, database-driven; administered in Module 4)
-- ---------------------------------------------------------------------------
CREATE TABLE service_categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  sort_order       integer NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_categories_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT service_categories_org_key UNIQUE (organization_id, key)
);
CREATE TRIGGER service_categories_updated_at BEFORE UPDATE ON service_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE services (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  category_id               uuid NOT NULL,
  key                       text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  name                      text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description               text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  is_active                 boolean NOT NULL DEFAULT true,
  is_default                boolean NOT NULL DEFAULT false,
  requires_psa              boolean NOT NULL DEFAULT false,
  integration_dependencies  text[] NOT NULL DEFAULT '{}',
  config_requirements       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(config_requirements) = 'array'),
  sort_order                integer NOT NULL DEFAULT 100,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT services_org_key UNIQUE (organization_id, key),
  CONSTRAINT services_category_fk FOREIGN KEY (organization_id, category_id) REFERENCES service_categories (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT services_default_must_be_active CHECK (NOT is_default OR is_active)
);
CREATE TRIGGER services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE client_services (
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  service_id       uuid NOT NULL,
  config           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  enabled_by       uuid,
  enabled_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, service_id),
  CONSTRAINT client_services_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT client_services_service_fk FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX client_services_service_idx ON client_services (service_id);

-- ---------------------------------------------------------------------------
-- Onboarding drafts (server-side wizard progress; contains no secrets)
-- ---------------------------------------------------------------------------
CREATE TABLE onboarding_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  current_step     text NOT NULL DEFAULT 'client' CHECK (current_step IN
                     ('client', 'psa-provider', 'psa-config', 'services', 'deployment', 'review', 'create', 'download', 'verify', 'complete')),
  completed_steps  text[] NOT NULL DEFAULT '{}' CHECK (completed_steps <@ ARRAY['client', 'psa-provider', 'psa-config', 'services', 'deployment']::text[]),
  data             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) < 262144),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  client_id        uuid,
  result           jsonb,
  created_by       uuid NOT NULL,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT onboarding_drafts_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE SET NULL (client_id),
  CONSTRAINT onboarding_drafts_creator_fk FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id),
  CONSTRAINT onboarding_drafts_completed_has_client CHECK (status <> 'completed' OR (client_id IS NOT NULL AND completed_at IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX onboarding_drafts_org_status_idx ON onboarding_drafts (organization_id, status, updated_at DESC);
CREATE TRIGGER onboarding_drafts_updated_at BEFORE UPDATE ON onboarding_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Deployment host label (captured during onboarding, step 5)
-- ---------------------------------------------------------------------------
ALTER TABLE deployments ADD COLUMN host_label text CHECK (host_label IS NULL OR length(host_label) <= 100);

-- Client activity history.
CREATE INDEX audit_events_org_client_time_idx ON audit_events (organization_id, client_id, occurred_at DESC) WHERE client_id IS NOT NULL;
-- Directory filters.
CREATE INDEX clients_org_status_idx ON clients (organization_id, status);
CREATE INDEX clients_org_country_idx ON clients (organization_id, country_code);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE client_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY client_contacts_tenant ON client_contacts
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY service_categories_tenant ON service_categories
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
CREATE POLICY services_tenant ON services
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE client_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_services FORCE ROW LEVEL SECURITY;
CREATE POLICY client_services_tenant ON client_services
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

ALTER TABLE onboarding_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_drafts_tenant ON onboarding_drafts
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON client_contacts, client_services, onboarding_drafts TO psacc_app_rw;
-- The catalog is read by the app in Module 2; Module 4 adds write grants with its admin API.
GRANT SELECT ON service_categories, services TO psacc_app_rw;
