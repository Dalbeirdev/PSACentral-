-- 0006_health_monitoring.sql
-- Module 8: agent reports over the mTLS channel, heartbeat history, per-organization health policy.
-- Health states are evaluated by the Control Plane from real reports (never from a heartbeat alone).

-- Centrally configured intervals and thresholds. One row per organization; defaults until edited.
CREATE TABLE health_policies (
  organization_id              uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  heartbeat_interval_seconds   integer NOT NULL DEFAULT 60 CHECK (heartbeat_interval_seconds BETWEEN 15 AND 3600),
  offline_after_seconds        integer NOT NULL DEFAULT 300 CHECK (offline_after_seconds BETWEEN 30 AND 86400),
  stale_report_after_seconds   integer NOT NULL DEFAULT 900 CHECK (stale_report_after_seconds BETWEEN 60 AND 86400),
  cpu_warn_percent             numeric(5,2) NOT NULL DEFAULT 80 CHECK (cpu_warn_percent BETWEEN 0 AND 100),
  cpu_critical_percent         numeric(5,2) NOT NULL DEFAULT 95 CHECK (cpu_critical_percent BETWEEN 0 AND 100),
  memory_warn_percent          numeric(5,2) NOT NULL DEFAULT 80 CHECK (memory_warn_percent BETWEEN 0 AND 100),
  memory_critical_percent      numeric(5,2) NOT NULL DEFAULT 95 CHECK (memory_critical_percent BETWEEN 0 AND 100),
  disk_warn_percent            numeric(5,2) NOT NULL DEFAULT 80 CHECK (disk_warn_percent BETWEEN 0 AND 100),
  disk_critical_percent        numeric(5,2) NOT NULL DEFAULT 95 CHECK (disk_critical_percent BETWEEN 0 AND 100),
  backup_max_age_hours         integer NOT NULL DEFAULT 48 CHECK (backup_max_age_hours BETWEEN 1 AND 8760),
  certificate_warn_days        integer NOT NULL DEFAULT 14 CHECK (certificate_warn_days BETWEEN 1 AND 365),
  updated_by                   uuid,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_policies_cpu CHECK (cpu_warn_percent < cpu_critical_percent),
  CONSTRAINT health_policies_memory CHECK (memory_warn_percent < memory_critical_percent),
  CONSTRAINT health_policies_disk CHECK (disk_warn_percent < disk_critical_percent),
  CONSTRAINT health_policies_offline CHECK (offline_after_seconds >= heartbeat_interval_seconds * 2)
);
ALTER TABLE health_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY health_policies_tenant ON health_policies USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON health_policies TO psacc_app_rw;
-- Default policy rows for existing organizations (FORCE RLS applies to the owner: set each context).
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    INSERT INTO health_policies (organization_id) VALUES (o.id) ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
END $$;

-- Every accepted report (strict, allow-listed payloads only). Kept 30 days; the latest per type is
-- read through deployment_report_latest.
CREATE TABLE deployment_reports (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  installation_id  uuid NOT NULL,
  report_type      text NOT NULL CHECK (report_type IN ('database', 'host_resources', 'containers', 'psa_integration_status',
                     'ticket_processing_metrics', 'synchronization', 'versions', 'backup', 'certificates_security')),
  observed_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  agent_version    text CHECK (agent_version IS NULL OR length(agent_version) <= 40),
  payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT deployment_reports_deployment_fk FOREIGN KEY (client_id, deployment_id) REFERENCES deployments (client_id, id) ON DELETE CASCADE,
  CONSTRAINT deployment_reports_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX deployment_reports_deployment_idx ON deployment_reports (deployment_id, report_type, observed_at DESC);
CREATE INDEX deployment_reports_org_received_idx ON deployment_reports (organization_id, received_at);
ALTER TABLE deployment_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY deployment_reports_tenant ON deployment_reports
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));
GRANT SELECT, INSERT, DELETE ON deployment_reports TO psacc_app_rw;

-- Latest report per deployment and type (upserted on receipt).
CREATE TABLE deployment_report_latest (
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  report_type      text NOT NULL,
  observed_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL,
  payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (deployment_id, report_type),
  CONSTRAINT drl_deployment_fk FOREIGN KEY (client_id, deployment_id) REFERENCES deployments (client_id, id) ON DELETE CASCADE,
  CONSTRAINT drl_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE deployment_report_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_report_latest FORCE ROW LEVEL SECURITY;
CREATE POLICY drl_tenant ON deployment_report_latest
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON deployment_report_latest TO psacc_app_rw;

-- Heartbeat history (liveness only). Kept 7 days.
CREATE TABLE deployment_heartbeats (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  agent_version    text CHECK (agent_version IS NULL OR length(agent_version) <= 40),
  buffered_reports integer CHECK (buffered_reports IS NULL OR buffered_reports >= 0),
  CONSTRAINT deployment_heartbeats_deployment_fk FOREIGN KEY (client_id, deployment_id) REFERENCES deployments (client_id, id) ON DELETE CASCADE,
  CONSTRAINT deployment_heartbeats_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX deployment_heartbeats_deployment_idx ON deployment_heartbeats (deployment_id, received_at DESC);
CREATE INDEX deployment_heartbeats_org_received_idx ON deployment_heartbeats (organization_id, received_at);
ALTER TABLE deployment_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY deployment_heartbeats_tenant ON deployment_heartbeats
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));
GRANT SELECT, INSERT, DELETE ON deployment_heartbeats TO psacc_app_rw;

-- The evaluated findings behind a deployment's current state (shown on its health page).
ALTER TABLE deployments
  ADD COLUMN health_findings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(health_findings) = 'array'),
  ADD COLUMN health_evaluated_at timestamptz;

-- Organizations with enrolled deployments, for the cross-organization offline sweep. The application
-- role cannot list organizations, and FORCE RLS on deployments applies even to the owner, so the
-- function sets each organization's context while it looks.
CREATE FUNCTION app_organizations_with_agents() RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  o record;
  prev_org text := coalesce(current_setting('app.org_id', true), '');
  prev_scope text := coalesce(current_setting('app.scope_all', true), 'off');
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true), set_config('app.scope_all', 'on', true);
    IF EXISTS (SELECT 1 FROM deployments WHERE lifecycle_state IN ('enrolled', 'verified') AND NOT is_synthetic) THEN
      RETURN NEXT o.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true), set_config('app.scope_all', prev_scope, true);
END $$;
REVOKE ALL ON FUNCTION app_organizations_with_agents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organizations_with_agents() TO psacc_app_rw;

-- The heartbeat now also records history and the agent's buffered-report count.
CREATE OR REPLACE FUNCTION agent_heartbeat(p_fingerprint bytea, p_agent_version text)
RETURNS TABLE (result text, deployment_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  i record;
  v_now timestamptz := clock_timestamp();
  v_client uuid;
BEGIN
  SELECT * INTO i FROM agent_identify(p_fingerprint);
  IF i.result <> 'ok' THEN
    RETURN QUERY SELECT i.result, i.deployment_code;
    RETURN;
  END IF;
  PERFORM agent_ctx(i.organization_id);
  UPDATE agent_certificates SET last_seen_at = v_now, agent_version = left(p_agent_version, 40) WHERE fingerprint = p_fingerprint;
  UPDATE deployments SET last_heartbeat_at = v_now, agent_version = left(p_agent_version, 40) WHERE id = i.deployment_id RETURNING client_id INTO v_client;
  INSERT INTO deployment_heartbeats (organization_id, client_id, deployment_id, received_at, agent_version)
  VALUES (i.organization_id, v_client, i.deployment_id, v_now, left(p_agent_version, 40));
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT 'ok'::text, i.deployment_code;
END $$;
