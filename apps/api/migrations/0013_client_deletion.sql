-- Module 17: client-initiated deletion from the appliance.
--
-- The local administrator of an appliance can delete everything it holds and deregister it from the
-- Control Plane. The Control Plane then keeps nothing about that deployment beyond the audit trail:
-- the same removal as Module 15's explicit removal, but allowed for a deployment in any lifecycle
-- state, because the request comes from the appliance's own authenticated identity (mutual TLS) and
-- the client's decision is final. The audit event is written first, in the same transaction.

DROP FUNCTION app_remove_deployment(uuid);

CREATE FUNCTION app_remove_deployment(p_deployment uuid, p_client_initiated boolean DEFAULT false) RETURNS jsonb
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
  IF v_state <> 'decommissioned' AND NOT p_client_initiated THEN
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

REVOKE ALL ON FUNCTION app_remove_deployment(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_remove_deployment(uuid, boolean) TO psacc_app_rw;

-- The appliance proves it is the deployment it claims to delete: the gateway resolves the certificate
-- and the service compares the installation id. A deletion that already happened leaves a tombstone
-- only in the audit trail; this index lets the gateway answer "already deleted" to a retry.
CREATE INDEX audit_events_client_deletion_idx ON audit_events ((metadata->>'certificateFingerprint'))
  WHERE action = 'deployment.deleted_by_client';

-- Tombstone lookup for the gateway: audit rows are tenant-scoped (no scope-all exception) and the
-- organization of a deleted certificate is no longer derivable from any table, so this definer function
-- searches per organization, the way agent_org_of_certificate does.
CREATE FUNCTION agent_deletion_tombstone(p_fingerprint_hex text)
RETURNS TABLE (event_id uuid, org_id uuid, occurred_at timestamptz, deployment_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  o record;
  r record;
BEGIN
  FOR o IN SELECT org.id FROM organizations org LOOP
    PERFORM agent_ctx(o.id);
    SELECT e.id, e.organization_id, e.occurred_at, e.target_display INTO r
      FROM audit_events e
     WHERE e.action = 'deployment.deleted_by_client' AND e.metadata->>'certificateFingerprint' = p_fingerprint_hex
     ORDER BY e.occurred_at DESC LIMIT 1;
    IF FOUND THEN
      PERFORM agent_ctx(NULL);
      RETURN QUERY SELECT r.id, r.organization_id, r.occurred_at, r.target_display;
      RETURN;
    END IF;
  END LOOP;
  PERFORM agent_ctx(NULL);
END $$;
REVOKE ALL ON FUNCTION agent_deletion_tombstone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_deletion_tombstone(text) TO psacc_app_rw;
