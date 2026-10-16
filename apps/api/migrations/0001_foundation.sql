-- 0001_foundation.sql
-- Control Plane foundation (Module 1).
--   * tenant-context helpers + row-level security (organization AND client scope)
--   * identity: organizations, users, sessions, MFA recovery codes
--   * RBAC: permissions, roles, role_permissions, user_roles, user_client_assignments
--   * append-only audit_events
--   * core operational tables aggregated by the dashboard: clients, psa_providers,
--     psa_instances, deployments, deployment_health_events. Their CRUD/workflows are
--     delivered by Modules 2, 3, 5 and 8, which extend these tables with new migrations.
--
-- Runs as psacc_owner. The API logs in as a member of psacc_app_rw (DML only, NOBYPASSRLS).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Tenant context. Values are set per transaction with set_config(..., true).
-- Unset context => NULL => no rows match (fail closed).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_scope_all() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT coalesce(current_setting('app.scope_all', true), '') = 'on' $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- Organizations (tenants of the control plane)
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  is_synthetic  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-organization human-readable code sequences (CL-00001, PSA-00001, DEP-00001).
CREATE TABLE organization_sequences (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (name IN ('client', 'psa_instance', 'deployment')),
  last_value      bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (organization_id, name)
);

CREATE FUNCTION next_org_code(p_name text, p_prefix text) RETURNS text
  LANGUAGE sql VOLATILE
  AS $$
    INSERT INTO organization_sequences AS s (organization_id, name, last_value)
    VALUES (app_current_org(), p_name, 1)
    ON CONFLICT (organization_id, name) DO UPDATE SET last_value = s.last_value + 1
    RETURNING p_prefix || '-' || lpad(s.last_value::text, 5, '0')
  $$;

-- ---------------------------------------------------------------------------
-- Users & identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email                   text NOT NULL CHECK (email = lower(email) AND length(email) <= 254 AND position('@' IN email) > 1),
  display_name            text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  auth_provider           text NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local', 'oidc')),
  external_subject        text,
  password_hash           text,
  password_changed_at     timestamptz,
  must_change_password    boolean NOT NULL DEFAULT false,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  mfa_enabled             boolean NOT NULL DEFAULT false,
  mfa_secret_enc          text,
  mfa_pending_secret_enc  text,
  mfa_last_used_step      bigint,
  mfa_enrolled_at         timestamptz,
  failed_login_count      integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until            timestamptz,
  last_login_at           timestamptz,
  timezone                text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  is_synthetic            boolean NOT NULL DEFAULT false,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT users_local_has_password CHECK (auth_provider <> 'local' OR password_hash IS NOT NULL),
  CONSTRAINT users_oidc_has_subject CHECK (auth_provider <> 'oidc' OR external_subject IS NOT NULL),
  CONSTRAINT users_mfa_has_secret CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL),
  CONSTRAINT users_created_by_fk FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id)
);
-- One account per email across the platform (login identifier).
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_external_subject_key ON users (auth_provider, external_subject) WHERE external_subject IS NOT NULL;
CREATE INDEX users_org_name_idx ON users (organization_id, display_name);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  user_id              uuid NOT NULL,
  token_hash           bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  state                text NOT NULL CHECK (state IN ('mfa_pending', 'password_change_required', 'mfa_setup_required', 'active')),
  mfa_verified_at      timestamptz,
  mfa_failed_attempts  integer NOT NULL DEFAULT 0 CHECK (mfa_failed_attempts >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoke_reason        text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 64),
  ip                   inet,
  user_agent           text CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  CONSTRAINT sessions_user_fk FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sessions_expiry_order CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_absolute_expiry_idx ON sessions (absolute_expires_at);

CREATE TABLE user_recovery_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  user_id          uuid NOT NULL,
  code_hash        bytea NOT NULL CHECK (length(code_hash) = 32),
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_recovery_codes_user_fk FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT user_recovery_codes_unique UNIQUE (user_id, code_hash)
);

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z]+(\.[a-z_]+)+$'),
  category     text NOT NULL,
  description  text NOT NULL
);

CREATE TABLE roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = system role
  key              text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description      text NOT NULL DEFAULT '',
  scope            text NOT NULL CHECK (scope IN ('all_clients', 'assigned_clients')),
  is_system        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_system_is_global CHECK (is_system = (organization_id IS NULL)),
  CONSTRAINT roles_org_key_unique UNIQUE NULLS NOT DISTINCT (organization_id, key)
);
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key  text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  organization_id  uuid NOT NULL,
  user_id          uuid NOT NULL,
  role_id          uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by       uuid,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT user_roles_user_fk FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX user_roles_role_idx ON user_roles (role_id);

-- ---------------------------------------------------------------------------
-- Clients (Module 2 adds contacts, onboarding drafts and full CRUD)
-- ---------------------------------------------------------------------------
CREATE TABLE clients (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code                     text NOT NULL CHECK (code ~ '^CL-[0-9]{5,}$'),
  client_reference         text NOT NULL CHECK (length(client_reference) BETWEEN 1 AND 64),
  legal_name               text NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 200),
  display_name             text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  business_type            text CHECK (business_type IS NULL OR length(business_type) <= 80),
  country_code             char(2) CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  state_region             text CHECK (state_region IS NULL OR length(state_region) <= 100),
  city                     text CHECK (city IS NULL OR length(city) <= 100),
  timezone                 text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  website                  text CHECK (website IS NULL OR (website ~* '^https?://' AND length(website) <= 300)),
  status                   text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('prospect', 'onboarding', 'active', 'suspended', 'offboarded')),
  service_status           text NOT NULL DEFAULT 'not_started' CHECK (service_status IN ('not_started', 'in_progress', 'live', 'paused', 'terminated')),
  account_manager_user_id  uuid,
  technical_owner_user_id  uuid,
  onboarding_date          date,
  contract_start_date      date,
  contract_end_date        date,
  internal_notes           text CHECK (internal_notes IS NULL OR length(internal_notes) <= 10000),
  is_synthetic             boolean NOT NULL DEFAULT false,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clients_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT clients_org_code_key UNIQUE (organization_id, code),
  CONSTRAINT clients_contract_dates CHECK (contract_end_date IS NULL OR contract_start_date IS NULL OR contract_end_date >= contract_start_date),
  CONSTRAINT clients_account_manager_fk FOREIGN KEY (organization_id, account_manager_user_id) REFERENCES users (organization_id, id),
  CONSTRAINT clients_technical_owner_fk FOREIGN KEY (organization_id, technical_owner_user_id) REFERENCES users (organization_id, id)
);
-- Client references are unique per organization (case-insensitive).
CREATE UNIQUE INDEX clients_org_reference_key ON clients (organization_id, lower(client_reference));
CREATE INDEX clients_org_created_idx ON clients (organization_id, created_at DESC);
CREATE INDEX clients_display_name_trgm_idx ON clients USING gin (display_name gin_trgm_ops);
CREATE INDEX clients_legal_name_trgm_idx ON clients USING gin (legal_name gin_trgm_ops);
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Technician client scope.
CREATE TABLE user_client_assignments (
  organization_id  uuid NOT NULL,
  user_id          uuid NOT NULL,
  client_id        uuid NOT NULL,
  assigned_by      uuid,
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id),
  CONSTRAINT uca_user_fk FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT uca_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX uca_client_idx ON user_client_assignments (client_id);

CREATE FUNCTION app_can_access_client(p_client_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT app_scope_all() OR EXISTS (
      SELECT 1 FROM user_client_assignments a
      WHERE a.user_id = app_current_user() AND a.client_id = p_client_id
    )
  $$;

-- ---------------------------------------------------------------------------
-- PSA providers (global catalog, synced from @psacc/contracts) and instances
-- ---------------------------------------------------------------------------
CREATE TABLE psa_providers (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name            text NOT NULL,
  vendor          text NOT NULL,
  auth_methods    text[] NOT NULL DEFAULT '{}',
  adapter_status  text NOT NULL CHECK (adapter_status IN ('planned', 'config_only', 'connection_test', 'sync')),
  is_enabled      boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER psa_providers_updated_at BEFORE UPDATE ON psa_providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE psa_instances (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  client_id                uuid NOT NULL,
  code                     text NOT NULL CHECK (code ~ '^PSA-[0-9]{5,}$'),
  provider_key             text NOT NULL REFERENCES psa_providers(key),
  display_name             text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  api_endpoint             text CHECK (api_endpoint IS NULL OR (api_endpoint ~* '^https://' AND length(api_endpoint) <= 300)),
  auth_method              text CHECK (auth_method IS NULL OR length(auth_method) <= 64),
  config                   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  credential_status        text NOT NULL DEFAULT 'not_configured'
                             CHECK (credential_status IN ('not_configured', 'pending_appliance', 'configured', 'invalid', 'expired')),
  connection_status        text NOT NULL DEFAULT 'untested' CHECK (connection_status IN ('untested', 'succeeded', 'failed')),
  last_successful_test_at  timestamptz,
  last_sync_at             timestamptz,
  is_synthetic             boolean NOT NULL DEFAULT false,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT psa_instances_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT psa_instances_client_id_key UNIQUE (client_id, id),
  CONSTRAINT psa_instances_org_code_key UNIQUE (organization_id, code),
  CONSTRAINT psa_instances_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE RESTRICT,
  -- Connectivity can only be "succeeded" if a real test recorded a success time.
  CONSTRAINT psa_instances_verified_requires_test CHECK (connection_status <> 'succeeded' OR last_successful_test_at IS NOT NULL)
);
CREATE INDEX psa_instances_org_provider_idx ON psa_instances (organization_id, provider_key);
CREATE TRIGGER psa_instances_updated_at BEFORE UPDATE ON psa_instances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Deployments (Module 5 adds packages/enrollment tokens; Module 7 certificates)
-- ---------------------------------------------------------------------------
CREATE TABLE deployments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  client_id              uuid NOT NULL,
  psa_instance_id        uuid,
  code                   text NOT NULL CHECK (code ~ '^DEP-[0-9]{5,}$'),
  installation_id        uuid UNIQUE,
  target_environment     text NOT NULL CHECK (target_environment IN
                           ('windows_docker', 'linux_docker', 'virtual_machine', 'client_server', 'cloud_vm', 'local_test')),
  target_os              text CHECK (target_os IS NULL OR target_os IN ('linux', 'windows')),
  target_arch            text CHECK (target_arch IS NULL OR target_arch IN ('amd64', 'arm64')),
  lifecycle_state        text NOT NULL DEFAULT 'draft' CHECK (lifecycle_state IN
                           ('draft', 'package_generated', 'package_downloaded', 'enrolled', 'verified', 'suspended', 'decommissioned')),
  health_state           text NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('healthy', 'degraded', 'critical', 'offline', 'unknown')),
  health_reason          text CHECK (health_reason IS NULL OR length(health_reason) <= 500),
  image_version          text CHECK (image_version IS NULL OR image_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'),
  image_digest           text CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$'),
  agent_version          text CHECK (agent_version IS NULL OR length(agent_version) <= 40),
  last_heartbeat_at      timestamptz,
  package_generated_at   timestamptz,
  package_downloaded_at  timestamptz,
  enrolled_at            timestamptz,
  verified_at            timestamptz,
  is_synthetic           boolean NOT NULL DEFAULT false,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployments_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT deployments_client_id_key UNIQUE (client_id, id),
  CONSTRAINT deployments_org_code_key UNIQUE (organization_id, code),
  CONSTRAINT deployments_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE RESTRICT,
  -- The bound PSA instance must belong to the same client.
  CONSTRAINT deployments_psa_instance_fk FOREIGN KEY (client_id, psa_instance_id) REFERENCES psa_instances (client_id, id) ON DELETE RESTRICT,
  -- Lifecycle honesty: later stages require evidence timestamps; health requires enrollment.
  CONSTRAINT deployments_generated_has_ts CHECK (lifecycle_state = 'draft' OR package_generated_at IS NOT NULL),
  CONSTRAINT deployments_enrolled_has_ts CHECK (lifecycle_state NOT IN ('enrolled', 'verified') OR enrolled_at IS NOT NULL),
  CONSTRAINT deployments_verified_has_ts CHECK (lifecycle_state <> 'verified' OR verified_at IS NOT NULL),
  CONSTRAINT deployments_health_requires_enrollment CHECK (health_state = 'unknown' OR enrolled_at IS NOT NULL)
);
CREATE INDEX deployments_org_client_idx ON deployments (organization_id, client_id);
CREATE INDEX deployments_org_health_idx ON deployments (organization_id, health_state);
CREATE INDEX deployments_org_created_idx ON deployments (organization_id, created_at DESC);
CREATE TRIGGER deployments_updated_at BEFORE UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Health timeline. Append-only for the application.
CREATE TABLE deployment_health_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  health_state     text NOT NULL CHECK (health_state IN ('healthy', 'degraded', 'critical', 'offline', 'unknown')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  source           text NOT NULL CHECK (source IN ('agent', 'system', 'synthetic')),
  observed_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dhe_deployment_fk FOREIGN KEY (organization_id, deployment_id) REFERENCES deployments (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT dhe_client_deployment_fk FOREIGN KEY (client_id, deployment_id) REFERENCES deployments (client_id, id) ON DELETE CASCADE
);
CREATE INDEX dhe_deployment_observed_idx ON deployment_health_events (deployment_id, observed_at DESC);
CREATE INDEX dhe_org_observed_idx ON deployment_health_events (organization_id, observed_at);

-- ---------------------------------------------------------------------------
-- Audit (append-only: the application role has INSERT + SELECT only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('user', 'system', 'agent')),
  actor_user_id    uuid,
  actor_display    text NOT NULL CHECK (length(actor_display) <= 200),
  action           text NOT NULL CHECK (action ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  target_type      text CHECK (target_type IS NULL OR length(target_type) <= 64),
  target_id        text CHECK (target_id IS NULL OR length(target_id) <= 128),
  target_display   text CHECK (target_display IS NULL OR length(target_display) <= 200),
  client_id        uuid,
  outcome          text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  ip               inet,
  user_agent       text CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  request_id       text CHECK (request_id IS NULL OR length(request_id) <= 128),
  metadata         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_events_org_time_idx ON audit_events (organization_id, occurred_at DESC);
CREATE INDEX audit_events_org_action_idx ON audit_events (organization_id, action);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Pre-authentication lookups. SECURITY DEFINER (owner bypasses RLS on these
-- non-FORCE tables) with a pinned search_path; returns only what auth needs.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_lookup_user(p_email text)
  RETURNS TABLE (user_id uuid, organization_id uuid, password_hash text, status text,
                 auth_provider text, locked_until timestamptz, org_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.id, u.organization_id, u.password_hash, u.status, u.auth_provider, u.locked_until, o.status
    FROM public.users u
    JOIN public.organizations o ON o.id = u.organization_id
    WHERE u.email = lower(p_email)
  $$;

CREATE FUNCTION auth_resolve_session(p_token_hash bytea)
  RETURNS TABLE (session_id uuid, organization_id uuid, user_id uuid, state text,
                 mfa_verified_at timestamptz, last_seen_at timestamptz,
                 idle_expires_at timestamptz, absolute_expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT s.id, s.organization_id, s.user_id, s.state, s.mfa_verified_at, s.last_seen_at,
           s.idle_expires_at, s.absolute_expires_at
    FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
    JOIN public.organizations o ON o.id = s.organization_id
    WHERE s.token_hash = p_token_hash
      AND s.revoked_at IS NULL
      AND s.idle_expires_at > now()
      AND s.absolute_expires_at > now()
      AND u.status = 'active'
      AND o.status = 'active'
  $$;

REVOKE ALL ON FUNCTION auth_lookup_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_session(bytea) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant ON organizations FOR SELECT USING (id = app_current_org());

ALTER TABLE organization_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_sequences_tenant ON organization_sequences
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

-- users / sessions are read by the SECURITY DEFINER auth functions (owner), so not FORCE'd.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant ON users
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_tenant ON sessions
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY user_recovery_codes_tenant ON user_recovery_codes
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

-- System roles (organization_id IS NULL) are visible to everyone but writable only by the owner.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_read ON roles FOR SELECT USING (organization_id IS NULL OR organization_id = app_current_org());
CREATE POLICY roles_insert ON roles FOR INSERT WITH CHECK (organization_id = app_current_org() AND NOT is_system);
CREATE POLICY roles_update ON roles FOR UPDATE USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org() AND NOT is_system);
CREATE POLICY roles_delete ON roles FOR DELETE USING (organization_id = app_current_org());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_read ON role_permissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id));
CREATE POLICY role_permissions_write ON role_permissions FOR ALL
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.organization_id = app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.organization_id = app_current_org()));

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_tenant ON user_roles
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE user_client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_client_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY uca_tenant ON user_client_assignments
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant ON clients
  USING (organization_id = app_current_org() AND app_can_access_client(id))
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE psa_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE psa_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY psa_instances_tenant ON psa_instances
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY deployments_tenant ON deployments
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

ALTER TABLE deployment_health_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_health_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dhe_tenant ON deployment_health_events
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_read ON audit_events FOR SELECT USING (organization_id = app_current_org());
CREATE POLICY audit_events_append ON audit_events FOR INSERT WITH CHECK (organization_id = app_current_org());

-- ---------------------------------------------------------------------------
-- Least-privilege grants for the application group role
-- ---------------------------------------------------------------------------
GRANT SELECT ON organizations, permissions, psa_providers TO psacc_app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organization_sequences, users, sessions, user_recovery_codes, roles, role_permissions,
  user_roles, user_client_assignments, clients, psa_instances, deployments
  TO psacc_app_rw;
-- Append-only tables: no UPDATE / DELETE privilege exists for the application.
GRANT SELECT, INSERT ON audit_events, deployment_health_events TO psacc_app_rw;
GRANT USAGE ON SEQUENCE deployment_health_events_id_seq TO psacc_app_rw;
GRANT EXECUTE ON FUNCTION auth_lookup_user(text), auth_resolve_session(bytea) TO psacc_app_rw;
