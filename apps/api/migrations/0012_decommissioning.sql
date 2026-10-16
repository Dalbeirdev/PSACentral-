-- Module 15 — Secure decommissioning and deployment removal.
-- Decommissioning retires a deployment's management identity on the Control Plane (certificate, tokens,
-- packages, open commands) and records why. The appliance is never touched remotely: its agent learns
-- that the identity was retired (the gateway answers `decommissioned`), stops PSA work and shows the
-- removal instructions; data stays on the host until the operator runs the uninstall script. The
-- operational metadata the Control Plane kept (reports, heartbeats, inventory, commands, health timeline)
-- is purged after the organization's retention period; the record can then be removed explicitly.
-- Audit events are never deleted.

ALTER TABLE deployments
  ADD COLUMN decommissioned_at         timestamptz,
  ADD COLUMN decommissioned_by         uuid,
  ADD COLUMN decommissioned_reason     text CHECK (decommissioned_reason IS NULL OR length(decommissioned_reason) BETWEEN 3 AND 200),
  ADD COLUMN decommissioned_from_state text CHECK (decommissioned_from_state IS NULL OR decommissioned_from_state IN ('draft', 'package_generated', 'package_downloaded', 'enrolled', 'verified')),
  ADD COLUMN decommission_identity     jsonb,
  ADD COLUMN metadata_purged_at        timestamptz,
  ADD CONSTRAINT deployments_decommissioned_has_ts CHECK (
    lifecycle_state <> 'decommissioned' OR (decommissioned_at IS NOT NULL AND decommissioned_reason IS NOT NULL AND decommissioned_from_state IS NOT NULL)
  );
CREATE INDEX deployments_decommissioned_idx ON deployments (organization_id, decommissioned_at) WHERE lifecycle_state = 'decommissioned';

-- Per-organization retention of decommissioned deployments' operational metadata.
CREATE TABLE retention_policies (
  organization_id               uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  decommissioned_metadata_days  integer NOT NULL DEFAULT 90 CHECK (decommissioned_metadata_days BETWEEN 7 AND 3650),
  updated_by                    uuid,
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_policies_tenant ON retention_policies USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON retention_policies TO psacc_app_rw;

-- A revoked certificate of a decommissioned deployment answers `decommissioned` (not `revoked`): the agent
-- treats it as final, while a plain revocation still means "re-enroll with a new package".
CREATE OR REPLACE FUNCTION agent_identify(p_fingerprint bytea)
RETURNS TABLE (result text, organization_id uuid, deployment_id uuid, deployment_code text, installation_id uuid, not_after timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := agent_org_of_certificate(p_fingerprint);
  c record;
BEGIN
  IF v_org IS NULL THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  PERFORM agent_ctx(v_org);
  SELECT a.status, a.not_after, a.deployment_id, a.installation_id, d.code, d.lifecycle_state INTO c
    FROM agent_certificates a JOIN deployments d ON d.id = a.deployment_id WHERE a.fingerprint = p_fingerprint;
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT CASE WHEN c.lifecycle_state = 'decommissioned' THEN 'decommissioned'
                           WHEN c.status = 'revoked' THEN 'revoked' WHEN c.status = 'superseded' THEN 'superseded'
                           WHEN c.not_after <= clock_timestamp() THEN 'expired' ELSE 'ok' END,
                      v_org, c.deployment_id, c.code::text, c.installation_id, c.not_after;
END $$;

-- Enrollment: a decommissioned deployment refuses every token, with its own reason (audited).
CREATE OR REPLACE FUNCTION agent_enrollment_check(p_token_hash bytea, p_deployment uuid, p_installation uuid, p_ip inet)
RETURNS TABLE (result text, organization_id uuid, client_id uuid, deployment_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := agent_org_of_token(p_token_hash);
  r record;
  v_result text := 'ok';
BEGIN
  IF v_org IS NULL THEN
    RETURN QUERY SELECT 'invalid-token'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  PERFORM agent_ctx(v_org);
  SELECT t.*, p.installation_id AS pkg_installation, p.status AS pkg_status, d.code, d.lifecycle_state, d.client_id AS dep_client,
         l.status AS license_status, l.ends_at AS license_ends
    INTO r
    FROM enrollment_tokens t
    JOIN deployment_packages p ON p.id = t.package_id
    JOIN deployments d ON d.id = t.deployment_id
    LEFT JOIN licenses l ON l.id = d.license_id
   WHERE t.token_hash = p_token_hash;
  v_result := CASE
    WHEN r.lifecycle_state = 'decommissioned' THEN 'deployment-decommissioned'
    WHEN r.consumed_at IS NOT NULL THEN 'token-used'
    WHEN r.revoked_at IS NOT NULL OR r.pkg_status IN ('revoked', 'superseded') THEN 'token-revoked'
    WHEN r.expires_at <= clock_timestamp() OR r.pkg_status = 'expired' THEN 'token-expired'
    WHEN r.deployment_id <> p_deployment OR r.pkg_installation <> p_installation THEN 'identity-mismatch'
    WHEN r.lifecycle_state = 'suspended' THEN 'deployment-suspended'
    WHEN r.lifecycle_state NOT IN ('draft', 'package_generated', 'package_downloaded') THEN 'already-enrolled'
    WHEN r.license_status IS NULL THEN 'license-missing'
    WHEN r.license_status <> 'active' OR (r.license_ends IS NOT NULL AND r.license_ends < current_date) THEN 'license-inactive'
    ELSE 'ok' END;
  IF v_result <> 'ok' THEN
    INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, ip, metadata)
    VALUES (v_org, clock_timestamp(), 'agent', 'Agent ' || p_installation::text, 'agent.enrollment.rejected', 'deployment', r.deployment_id::text,
            r.code, r.dep_client, 'denied', p_ip, jsonb_build_object('reason', v_result, 'tokenRef', r.token_prefix));
  END IF;
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT v_result, v_org, r.dep_client, r.code::text;
END $$;

-- Retention sweep (daily in the API process; tests and "Purge now" call it directly): the operational
-- metadata of deployments decommissioned longer than the organization's retention period is deleted and
-- the purge is audited. The deployment record, its identity history and the audit trail stay.
CREATE FUNCTION app_purge_decommissioned(p_org uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  o record;
  d record;
  n integer := 0;
  v_days integer;
  v_counts jsonb;
  c_reports integer; c_latest integer; c_heartbeats integer; c_tables integer; c_events integer; c_commands integer;
  prev_org text := coalesce(current_setting('app.org_id', true), '');
  prev_scope text := coalesce(current_setting('app.scope_all', true), 'off');
BEGIN
  FOR o IN SELECT id FROM organizations WHERE p_org IS NULL OR id = p_org LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    PERFORM set_config('app.scope_all', 'on', true);
    SELECT coalesce((SELECT decommissioned_metadata_days FROM retention_policies WHERE organization_id = o.id), 90) INTO v_days;
    FOR d IN SELECT id, code, client_id, decommissioned_at FROM deployments
              WHERE organization_id = o.id AND lifecycle_state = 'decommissioned' AND metadata_purged_at IS NULL
                AND decommissioned_at < clock_timestamp() - make_interval(days => v_days)
              ORDER BY decommissioned_at FOR UPDATE LOOP
      DELETE FROM deployment_reports WHERE deployment_id = d.id; GET DIAGNOSTICS c_reports = ROW_COUNT;
      DELETE FROM deployment_report_latest WHERE deployment_id = d.id; GET DIAGNOSTICS c_latest = ROW_COUNT;
      DELETE FROM deployment_heartbeats WHERE deployment_id = d.id; GET DIAGNOSTICS c_heartbeats = ROW_COUNT;
      DELETE FROM deployment_tables WHERE deployment_id = d.id; GET DIAGNOSTICS c_tables = ROW_COUNT;
      DELETE FROM deployment_health_events WHERE deployment_id = d.id; GET DIAGNOSTICS c_events = ROW_COUNT;
      DELETE FROM remote_commands WHERE deployment_id = d.id; GET DIAGNOSTICS c_commands = ROW_COUNT;
      v_counts := jsonb_build_object('reports', c_reports, 'latestReports', c_latest, 'heartbeats', c_heartbeats, 'tableInventory', c_tables,
                                     'healthEvents', c_events, 'commands', c_commands);
      UPDATE deployments SET metadata_purged_at = clock_timestamp(), health_state = 'unknown', health_reason = 'Decommissioned', agent_version = NULL
       WHERE id = d.id;
      INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, metadata)
      VALUES (o.id, clock_timestamp(), 'system', 'Retention policy', 'deployment.metadata.purged', 'deployment', d.id::text, d.code, d.client_id, 'success',
              jsonb_build_object('code', d.code, 'decommissionedAt', d.decommissioned_at, 'retentionDays', v_days, 'deleted', v_counts));
      n := n + 1;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);
  PERFORM set_config('app.scope_all', prev_scope, true);
  RETURN n;
END $$;

-- Explicit removal of a decommissioned deployment record (the service audits it first, in the same
-- transaction). Runs inside the caller's tenant context, so RLS limits it to the caller's organization and
-- client scope. Returns the rows deleted per table.
CREATE FUNCTION app_remove_deployment(p_deployment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_state text;
  c integer;
  out jsonb := '{}'::jsonb;
BEGIN
  SELECT lifecycle_state INTO v_state FROM deployments WHERE id = p_deployment FOR UPDATE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'deployment not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_state <> 'decommissioned' THEN
    RAISE EXCEPTION 'only a decommissioned deployment can be removed' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM remote_commands WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('commands', c);
  DELETE FROM deployment_tables WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('tableInventory', c);
  DELETE FROM deployment_report_latest WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('latestReports', c);
  DELETE FROM deployment_reports WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('reports', c);
  DELETE FROM deployment_heartbeats WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('heartbeats', c);
  DELETE FROM deployment_health_events WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('healthEvents', c);
  DELETE FROM agent_certificates WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('certificates', c);
  DELETE FROM deployment_package_downloads WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('packageDownloads', c);
  DELETE FROM enrollment_tokens WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('enrollmentTokens', c);
  DELETE FROM deployment_packages WHERE deployment_id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('packages', c);
  DELETE FROM deployments WHERE id = p_deployment; GET DIAGNOSTICS c = ROW_COUNT; out := out || jsonb_build_object('deployments', c);
  RETURN out;
END $$;

REVOKE ALL ON FUNCTION app_purge_decommissioned(uuid), app_remove_deployment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_decommissioned(uuid), app_remove_deployment(uuid) TO psacc_app_rw;
