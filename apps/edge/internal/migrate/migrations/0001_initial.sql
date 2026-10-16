-- 0001_initial.sql — PSA Edge operational database (one database per client deployment).
--
-- PROVISIONAL schema: it establishes the tables, keys and migration lifecycle. It is NOT a complete
-- PSA engine; ticket synchronization arrives in Module 12 and the columns will be reviewed against
-- the existing ticket-management system (desk-portal) before then.
--
-- Roles (created by edge-migrate before this file runs):
--   owner      — runs migrations (the database owner)
--   psa_edge_app       — application role for edge-api / edge-worker: DML only, append-only logs
--   psa_edge_inspector — catalog metadata only: no privileges on any table (database explorer)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Key/value facts about this installation (deployment identity, schema version, timestamps).
CREATE TABLE app_metadata (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  value       text NOT NULL CHECK (length(value) <= 2000),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The client's PSA instance(s) this appliance integrates with. Non-secret settings only.
CREATE TABLE psa_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_code     text NOT NULL UNIQUE CHECK (instance_code ~ '^PSA-[0-9]{5,}$'),
  provider          text NOT NULL CHECK (provider IN ('autotask', 'connectwise', 'halopsa', 'kaseya_bms', 'freshservice', 'servicenow', 'custom_rest')),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  auth_method       text CHECK (auth_method IS NULL OR length(auth_method) <= 64),
  api_endpoint      text CHECK (api_endpoint IS NULL OR api_endpoint ~ '^https://'),
  config            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  status            text NOT NULL DEFAULT 'not_configured'
                      CHECK (status IN ('not_configured', 'credentials_present', 'verified', 'failed')),
  last_test_at      timestamptz,
  last_test_result  text CHECK (last_test_result IS NULL OR length(last_test_result) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- "verified" needs a real test (Module 11): never set without evidence.
  CONSTRAINT psa_connections_verified_requires_test CHECK (status <> 'verified' OR last_test_at IS NOT NULL)
);

-- PSA credentials, encrypted with this host's data key (AES-256-GCM). Never leave the appliance.
CREATE TABLE credential_store (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  psa_connection_id  uuid NOT NULL REFERENCES psa_connections (id) ON DELETE CASCADE,
  field_key          text NOT NULL CHECK (field_key ~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$'),
  ciphertext         bytea NOT NULL CHECK (length(ciphertext) >= 17),
  nonce              bytea NOT NULL CHECK (length(nonce) = 12),
  key_version        smallint NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_store_field_key UNIQUE (psa_connection_id, field_key)
);

-- Services this appliance runs for the client (Help Desk, Endpoint Management, ...).
CREATE TABLE service_configurations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key        text NOT NULL UNIQUE CHECK (service_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  uses_psa           boolean NOT NULL DEFAULT false,
  enabled            boolean NOT NULL DEFAULT true,
  psa_connection_id  uuid REFERENCES psa_connections (id) ON DELETE SET NULL,
  settings           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_configurations_psa_link CHECK (NOT uses_psa OR psa_connection_id IS NOT NULL OR NOT enabled)
);

-- Unified help desk tickets (system of record for this client). Provisional columns.
CREATE TABLE helpdesk_tickets (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  psa_connection_id          uuid REFERENCES psa_connections (id) ON DELETE RESTRICT,
  external_ticket_id         text CHECK (external_ticket_id IS NULL OR length(external_ticket_id) <= 128),
  provider                   text,
  title                      text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description                text CHECK (description IS NULL OR length(description) <= 100000),
  status                     text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'pending', 'on_hold', 'resolved', 'closed')),
  psa_status                 text CHECK (psa_status IS NULL OR length(psa_status) <= 100),
  priority                   text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  psa_priority               text CHECK (psa_priority IS NULL OR length(psa_priority) <= 100),
  requester_email            text CHECK (requester_email IS NULL OR length(requester_email) <= 254),
  sla_first_response_due_at  timestamptz,
  sla_resolution_due_at      timestamptz,
  resolved_at                timestamptz,
  external_updated_at        timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helpdesk_tickets_external_key UNIQUE (psa_connection_id, external_ticket_id),
  CONSTRAINT helpdesk_tickets_external_needs_connection CHECK (external_ticket_id IS NULL OR psa_connection_id IS NOT NULL),
  CONSTRAINT helpdesk_tickets_resolved_has_ts CHECK (status NOT IN ('resolved', 'closed') OR resolved_at IS NOT NULL)
);
CREATE INDEX helpdesk_tickets_status_idx ON helpdesk_tickets (status, updated_at DESC);
CREATE INDEX helpdesk_tickets_updated_idx ON helpdesk_tickets (updated_at DESC);

-- Ticket history; idempotency key + payload hash make PSA event replay safe (as in desk-portal's sync_events).
CREATE TABLE ticket_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        uuid NOT NULL REFERENCES helpdesk_tickets (id) ON DELETE CASCADE,
  event_type       text NOT NULL CHECK (event_type IN ('created', 'updated', 'status_changed', 'note_added', 'assigned', 'synced', 'sync_conflict')),
  source           text NOT NULL CHECK (source IN ('portal', 'psa', 'system')),
  idempotency_key  text UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) <= 200),
  payload_hash     text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  payload          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, occurred_at DESC);

-- One row per synchronization run (Module 12). Counts and sanitized errors only.
CREATE TABLE sync_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  psa_connection_id  uuid NOT NULL REFERENCES psa_connections (id) ON DELETE CASCADE,
  direction          text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'both')),
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'partial')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  items_received     integer NOT NULL DEFAULT 0 CHECK (items_received >= 0),
  items_sent         integer NOT NULL DEFAULT 0 CHECK (items_sent >= 0),
  items_failed       integer NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  error_code         text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_.-]{1,64}$'),
  error_message      text CHECK (error_message IS NULL OR length(error_message) <= 500),
  CONSTRAINT sync_runs_finished_after_start CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT sync_runs_finished_when_done CHECK (status = 'running' OR finished_at IS NOT NULL)
);
CREATE INDEX sync_runs_connection_idx ON sync_runs (psa_connection_id, started_at DESC);

-- Local audit trail (append-only for the application role).
CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type   text NOT NULL CHECK (actor_type IN ('local_admin', 'system', 'agent')),
  actor        text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  action       text NOT NULL CHECK (action ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  target       text CHECK (target IS NULL OR length(target) <= 200),
  outcome      text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  metadata     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_events_time_idx ON audit_events (occurred_at DESC);

-- Local integration log. Messages are redacted before they are written; only counts and
-- sanitized error codes are ever reported to the Control Plane.
CREATE TABLE integration_logs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  level              text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  component          text NOT NULL CHECK (component IN ('migrate', 'api', 'worker', 'agent', 'backup')),
  message            text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  error_code         text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_.-]{1,64}$'),
  http_status        smallint CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  psa_connection_id  uuid REFERENCES psa_connections (id) ON DELETE SET NULL,
  metadata           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX integration_logs_time_idx ON integration_logs (occurred_at DESC);

-- Local database backups made by the edge-backup service.
CREATE TABLE backup_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  file_name      text CHECK (file_name IS NULL OR file_name ~ '^[A-Za-z0-9._-]{1,200}$'),
  size_bytes     bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256         text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  error_message  text CHECK (error_message IS NULL OR length(error_message) <= 500),
  CONSTRAINT backup_runs_succeeded_has_file CHECK (status <> 'succeeded' OR (file_name IS NOT NULL AND sha256 IS NOT NULL AND finished_at IS NOT NULL))
);
CREATE INDEX backup_runs_time_idx ON backup_runs (started_at DESC);

-- Accounts for the local administration / setup UI on this host (independent of the Control Plane).
CREATE TABLE local_admin_users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text NOT NULL CHECK (username ~ '^[a-z][a-z0-9._-]{2,63}$'),
  password_hash    text NOT NULL CHECK (password_hash ~ '^pbkdf2-sha256\$[0-9]+\$'),
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX local_admin_users_username_key ON local_admin_users (lower(username));

CREATE TABLE local_admin_sessions (
  token_hash  bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  user_id     uuid NOT NULL REFERENCES local_admin_users (id) ON DELETE CASCADE,
  csrf_token  text NOT NULL CHECK (length(csrf_token) >= 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CONSTRAINT local_admin_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX local_admin_sessions_expiry_idx ON local_admin_sessions (expires_at);

-- updated_at maintenance
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER app_metadata_touch BEFORE UPDATE ON app_metadata FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER psa_connections_touch BEFORE UPDATE ON psa_connections FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER credential_store_touch BEFORE UPDATE ON credential_store FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER service_configurations_touch BEFORE UPDATE ON service_configurations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER helpdesk_tickets_touch BEFORE UPDATE ON helpdesk_tickets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Least-privilege grants. The inspector role gets nothing on tables: it reads pg_catalog only.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_metadata, psa_connections, credential_store, service_configurations,
  helpdesk_tickets, ticket_events, sync_runs, local_admin_users, local_admin_sessions TO psa_edge_app;
GRANT SELECT, INSERT ON audit_events, integration_logs TO psa_edge_app;
GRANT SELECT ON backup_runs, schema_migrations TO psa_edge_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO psa_edge_app;

-- Schema version for the catalog-only inspector (the agent), without granting it any table.
CREATE FUNCTION edge_schema_status() RETURNS TABLE (schema_version text, migrations_applied integer, last_applied_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT max(version), count(*)::integer, max(applied_at) FROM public.schema_migrations
$$;
REVOKE ALL ON FUNCTION edge_schema_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edge_schema_status() TO psa_edge_inspector, psa_edge_app;
