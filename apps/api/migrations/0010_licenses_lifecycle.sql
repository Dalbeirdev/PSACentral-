-- Module 14 — Licensing, suspension and lifecycle management.
-- A license is a per-client entitlement (plan, term, maximum number of deployments) with its own identifier
-- (LIC-xxxxx, one of the appliance identifiers of ARCHITECTURE §1.1.4). Deployments bind to a license;
-- packages can only be generated, and agents can only enroll, under an active license. A deployment can
-- be suspended (reversible: the appliance keeps its data and local UI, PSA work pauses) and resumed.

CREATE TABLE licenses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  client_id        uuid NOT NULL REFERENCES clients (id),
  code             text NOT NULL CHECK (code ~ '^LIC-[0-9]{5,}$'),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'expired', 'revoked')),
  starts_at        date NOT NULL,
  ends_at          date CHECK (ends_at IS NULL OR ends_at >= starts_at),
  max_deployments  integer NOT NULL DEFAULT 1 CHECK (max_deployments BETWEEN 1 AND 1000),
  notes            text CHECK (notes IS NULL OR length(notes) <= 2000),
  suspended_at     timestamptz,
  suspended_reason text CHECK (suspended_reason IS NULL OR length(suspended_reason) BETWEEN 3 AND 200),
  revoked_at       timestamptz,
  revoke_reason    text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 3 AND 200),
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  is_synthetic     boolean NOT NULL DEFAULT false,
  CONSTRAINT licenses_code_unique UNIQUE (organization_id, code),
  CONSTRAINT licenses_suspended_ts CHECK ((status = 'suspended') = (suspended_at IS NOT NULL)),
  CONSTRAINT licenses_revoked_ts CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX licenses_client_idx ON licenses (client_id, status);
CREATE INDEX licenses_ends_idx ON licenses (ends_at) WHERE status = 'active';
GRANT SELECT, INSERT, UPDATE ON licenses TO psacc_app_rw;

ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses FORCE ROW LEVEL SECURITY;
CREATE POLICY licenses_tenant ON licenses
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

-- Deployments: the license they run under, and their suspension bookkeeping.
ALTER TABLE deployments
  ADD COLUMN license_id           uuid REFERENCES licenses (id),
  ADD COLUMN suspended_at         timestamptz,
  ADD COLUMN suspended_reason     text CHECK (suspended_reason IS NULL OR length(suspended_reason) BETWEEN 3 AND 200),
  ADD COLUMN suspended_from_state text CHECK (suspended_from_state IS NULL OR suspended_from_state IN ('draft', 'package_generated', 'package_downloaded', 'enrolled', 'verified')),
  ADD COLUMN resumed_at           timestamptz,
  ADD CONSTRAINT deployments_suspended_has_ts CHECK (lifecycle_state <> 'suspended' OR (suspended_at IS NOT NULL AND suspended_from_state IS NOT NULL));
CREATE INDEX deployments_license_idx ON deployments (license_id) WHERE license_id IS NOT NULL;

-- Remote commands gain the (reversible) suspend / resume pair; the appliance pauses PSA work, keeps everything else.
ALTER TABLE remote_commands DROP CONSTRAINT IF EXISTS remote_commands_command_type_check;
ALTER TABLE remote_commands ADD CONSTRAINT remote_commands_command_type_check
  CHECK (command_type IN ('refresh_health', 'test_psa_connection', 'run_sync', 'restart_service', 'rotate_certificate', 'upgrade', 'suspend', 'resume'));

-- Enrollment now also requires an active license and a deployment that is not suspended.
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

-- Daily sweep: active licenses past their end date become expired (audited); the deployments keep running
-- and the health rules flag them.
CREATE FUNCTION app_expire_licenses(p_org uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  o record;
  n integer := 0;
  m integer;
  prev_org text := coalesce(current_setting('app.org_id', true), '');
  prev_scope text := coalesce(current_setting('app.scope_all', true), 'off');
BEGIN
  FOR o IN SELECT id FROM organizations WHERE p_org IS NULL OR id = p_org LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    PERFORM set_config('app.scope_all', 'on', true);
    WITH expired AS (
      UPDATE licenses l SET status = 'expired', updated_at = clock_timestamp()
       WHERE l.organization_id = o.id AND l.status = 'active' AND l.ends_at IS NOT NULL AND l.ends_at < current_date
      RETURNING l.id, l.code, l.client_id, l.ends_at
    ), audited AS (
      INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, metadata)
      SELECT o.id, clock_timestamp(), 'system', 'License expiry', 'license.expired', 'license', e.id::text, e.code, e.client_id, 'failure',
             jsonb_build_object('endsAt', e.ends_at)
        FROM expired e
      RETURNING 1
    )
    SELECT count(*) INTO m FROM audited;
    n := n + m;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);
  PERFORM set_config('app.scope_all', prev_scope, true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app_expire_licenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_expire_licenses(uuid) TO psacc_app_rw;
