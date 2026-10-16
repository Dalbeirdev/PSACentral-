-- 0005_agent_enrollment.sql
-- Module 7: internal CA, agent machine certificates, enrollment with the single-use token,
-- certificate-authenticated heartbeats, renewal and revocation.
--
-- The agent gateway has no user session, so it reaches tenant data only through the SECURITY
-- DEFINER functions below. They locate the organization that owns a token or certificate, set that
-- organization's context (FORCE row-level security stays in effect), re-check every condition under
-- a row lock, act, audit, and restore the caller's context.

-- Platform PKI: the internal CA that signs agent certificates, and the gateway's TLS server certificate.
-- Private keys are AES-256-GCM envelopes (application data key); certificates are public.
CREATE TABLE pki_authorities (
  id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ca_cert_pem           text NOT NULL CHECK (ca_cert_pem LIKE '-----BEGIN CERTIFICATE-----%'),
  ca_key_ciphertext     text NOT NULL CHECK (ca_key_ciphertext LIKE 'v1.%'),
  ca_fingerprint        text NOT NULL CHECK (ca_fingerprint ~ '^[0-9a-f]{64}$'),
  server_cert_pem       text NOT NULL CHECK (server_cert_pem LIKE '-----BEGIN CERTIFICATE-----%'),
  server_key_ciphertext text NOT NULL CHECK (server_key_ciphertext LIKE 'v1.%'),
  server_names          text[] NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  server_rotated_at     timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON pki_authorities TO psacc_app_rw;

CREATE TABLE agent_certificates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  installation_id  uuid NOT NULL,
  serial           text NOT NULL UNIQUE CHECK (serial ~ '^[0-9a-f]{32}$'),
  fingerprint      bytea NOT NULL UNIQUE CHECK (length(fingerprint) = 32),
  subject          text NOT NULL CHECK (length(subject) <= 300),
  not_before       timestamptz NOT NULL,
  not_after        timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
  agent_version    text CHECK (agent_version IS NULL OR length(agent_version) <= 40),
  issued_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  issued_via       text NOT NULL CHECK (issued_via IN ('enrollment', 'renewal')),
  last_seen_at     timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid,
  revoke_reason    text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 3 AND 200),
  CONSTRAINT agent_certificates_validity CHECK (not_after > not_before),
  CONSTRAINT agent_certificates_revoked_has_ts CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT agent_certificates_deployment_fk FOREIGN KEY (client_id, deployment_id) REFERENCES deployments (client_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_certificates_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE RESTRICT
);
-- One usable machine identity per deployment.
CREATE UNIQUE INDEX agent_certificates_one_active ON agent_certificates (deployment_id) WHERE status = 'active';
CREATE INDEX agent_certificates_org_client_idx ON agent_certificates (organization_id, client_id);

ALTER TABLE agent_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_certificates_tenant ON agent_certificates
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));
GRANT SELECT, INSERT, UPDATE ON agent_certificates TO psacc_app_rw;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (not granted to the application role).

CREATE FUNCTION agent_ctx(p_org uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.org_id', coalesce(p_org::text, ''), true), set_config('app.scope_all', CASE WHEN p_org IS NULL THEN 'off' ELSE 'on' END, true), set_config('app.user_id', '', true);
$$;

-- Organization that owns an enrollment token (searched per organization, so FORCE RLS applies).
CREATE FUNCTION agent_org_of_token(p_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM agent_ctx(o.id);
    IF EXISTS (SELECT 1 FROM enrollment_tokens WHERE token_hash = p_hash) THEN RETURN o.id; END IF;
  END LOOP;
  PERFORM agent_ctx(NULL);
  RETURN NULL;
END $$;

CREATE FUNCTION agent_org_of_certificate(p_fp bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM agent_ctx(o.id);
    IF EXISTS (SELECT 1 FROM agent_certificates WHERE fingerprint = p_fp) THEN RETURN o.id; END IF;
  END LOOP;
  PERFORM agent_ctx(NULL);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION agent_ctx(uuid), agent_org_of_token(bytea), agent_org_of_certificate(bytea) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Enrollment, step 1: is this token usable for this deployment and installation? (No change.)
-- Rejections of a known token are audited in its organization.

CREATE FUNCTION agent_enrollment_check(p_token_hash bytea, p_deployment uuid, p_installation uuid, p_ip inet)
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
  SELECT t.*, p.installation_id AS pkg_installation, p.status AS pkg_status, d.code, d.lifecycle_state, d.client_id AS dep_client
    INTO r
    FROM enrollment_tokens t
    JOIN deployment_packages p ON p.id = t.package_id
    JOIN deployments d ON d.id = t.deployment_id
   WHERE t.token_hash = p_token_hash;
  v_result := CASE
    WHEN r.consumed_at IS NOT NULL THEN 'token-used'
    WHEN r.revoked_at IS NOT NULL OR r.pkg_status IN ('revoked', 'superseded') THEN 'token-revoked'
    WHEN r.expires_at <= clock_timestamp() OR r.pkg_status = 'expired' THEN 'token-expired'
    WHEN r.deployment_id <> p_deployment OR r.pkg_installation <> p_installation THEN 'identity-mismatch'
    WHEN r.lifecycle_state NOT IN ('draft', 'package_generated', 'package_downloaded') THEN 'already-enrolled'
    ELSE 'ok' END;
  IF v_result <> 'ok' THEN
    INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, ip, metadata)
    VALUES (v_org, clock_timestamp(), 'agent', 'Agent ' || p_installation::text, 'agent.enrollment.rejected', 'deployment', r.deployment_id::text,
            r.code, r.dep_client, 'denied', p_ip, jsonb_build_object('reason', v_result, 'tokenRef', r.token_prefix));
  END IF;
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT v_result, v_org, r.dep_client, r.code::text;
END $$;

-- Enrollment, step 2: under a row lock, re-check, consume the token, register the installation and
-- its machine certificate, and mark the deployment enrolled. Exactly one caller can win.
CREATE FUNCTION agent_enrollment_complete(
  p_token_hash bytea, p_deployment uuid, p_installation uuid, p_serial text, p_fingerprint bytea, p_subject text,
  p_not_before timestamptz, p_not_after timestamptz, p_agent_version text, p_ip inet)
RETURNS TABLE (result text, organization_id uuid, deployment_code text, enrolled_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := agent_org_of_token(p_token_hash);
  r record;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_org IS NULL THEN
    RETURN QUERY SELECT 'invalid-token'::text, NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  PERFORM agent_ctx(v_org);
  SELECT t.id, t.deployment_id, t.package_id, t.consumed_at, t.revoked_at, t.expires_at, t.token_prefix,
         p.installation_id AS pkg_installation, p.status AS pkg_status, d.code, d.client_id, d.lifecycle_state
    INTO r
    FROM enrollment_tokens t
    JOIN deployment_packages p ON p.id = t.package_id
    JOIN deployments d ON d.id = t.deployment_id
   WHERE t.token_hash = p_token_hash
     FOR UPDATE OF t, p, d;
  IF r.consumed_at IS NOT NULL THEN
    PERFORM agent_ctx(NULL);
    RETURN QUERY SELECT 'token-used'::text, v_org, r.code::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF r.revoked_at IS NOT NULL OR r.pkg_status <> 'active' OR r.expires_at <= v_now
     OR r.deployment_id <> p_deployment OR r.pkg_installation <> p_installation
     OR r.lifecycle_state NOT IN ('draft', 'package_generated', 'package_downloaded') THEN
    PERFORM agent_ctx(NULL);
    RETURN QUERY SELECT 'not-enrollable'::text, v_org, r.code::text, NULL::timestamptz;
    RETURN;
  END IF;
  BEGIN
    UPDATE enrollment_tokens SET consumed_at = v_now WHERE id = r.id;
    UPDATE deployment_packages SET status = 'consumed', archive_ciphertext = NULL, archive_purged_at = v_now WHERE id = r.package_id;
    INSERT INTO agent_certificates (organization_id, client_id, deployment_id, installation_id, serial, fingerprint, subject, not_before, not_after, agent_version, issued_via, last_seen_at)
    VALUES (v_org, r.client_id, r.deployment_id, p_installation, p_serial, p_fingerprint, p_subject, p_not_before, p_not_after, p_agent_version, 'enrollment', v_now);
    UPDATE deployments SET lifecycle_state = 'enrolled', enrolled_at = v_now, installation_id = p_installation,
           agent_version = p_agent_version, last_heartbeat_at = v_now
     WHERE id = r.deployment_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM agent_ctx(NULL);
    RETURN QUERY SELECT 'duplicate-installation'::text, v_org, r.code::text, NULL::timestamptz;
    RETURN;
  END;
  INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, ip, metadata)
  VALUES (v_org, v_now, 'agent', 'Agent ' || p_installation::text, 'agent.enrolled', 'deployment', r.deployment_id::text, r.code, r.client_id, 'success', p_ip,
          jsonb_build_object('installationId', p_installation, 'serial', p_serial, 'fingerprint', encode(p_fingerprint, 'hex'),
                             'notAfter', p_not_after, 'agentVersion', p_agent_version, 'tokenRef', r.token_prefix));
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT 'ok'::text, v_org, r.code::text, v_now;
END $$;

-- Which deployment does this certificate identify, and may it be used?
CREATE FUNCTION agent_identify(p_fingerprint bytea)
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
  SELECT a.status, a.not_after, a.deployment_id, a.installation_id, d.code INTO c
    FROM agent_certificates a JOIN deployments d ON d.id = a.deployment_id WHERE a.fingerprint = p_fingerprint;
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT CASE WHEN c.status = 'revoked' THEN 'revoked' WHEN c.status = 'superseded' THEN 'superseded'
                           WHEN c.not_after <= clock_timestamp() THEN 'expired' ELSE 'ok' END,
                      v_org, c.deployment_id, c.code::text, c.installation_id, c.not_after;
END $$;

-- Certificate-authenticated heartbeat: liveness and agent version only (health reports: Module 8).
CREATE FUNCTION agent_heartbeat(p_fingerprint bytea, p_agent_version text)
RETURNS TABLE (result text, deployment_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  i record;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO i FROM agent_identify(p_fingerprint);
  IF i.result <> 'ok' THEN
    RETURN QUERY SELECT i.result, i.deployment_code;
    RETURN;
  END IF;
  PERFORM agent_ctx(i.organization_id);
  UPDATE agent_certificates SET last_seen_at = v_now, agent_version = left(p_agent_version, 40) WHERE fingerprint = p_fingerprint;
  UPDATE deployments SET last_heartbeat_at = v_now, agent_version = left(p_agent_version, 40) WHERE id = i.deployment_id;
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT 'ok'::text, i.deployment_code;
END $$;

-- Renewal: the current certificate is superseded by a new one for the same installation.
CREATE FUNCTION agent_renew(p_fingerprint bytea, p_serial text, p_new_fingerprint bytea, p_subject text, p_not_before timestamptz, p_not_after timestamptz, p_ip inet)
RETURNS TABLE (result text, deployment_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  i record;
  c record;
BEGIN
  SELECT * INTO i FROM agent_identify(p_fingerprint);
  IF i.result <> 'ok' THEN
    RETURN QUERY SELECT i.result, i.deployment_code;
    RETURN;
  END IF;
  PERFORM agent_ctx(i.organization_id);
  SELECT * INTO c FROM agent_certificates WHERE fingerprint = p_fingerprint FOR UPDATE;
  IF c.status <> 'active' THEN
    PERFORM agent_ctx(NULL);
    RETURN QUERY SELECT c.status::text, i.deployment_code;
    RETURN;
  END IF;
  UPDATE agent_certificates SET status = 'superseded' WHERE id = c.id;
  INSERT INTO agent_certificates (organization_id, client_id, deployment_id, installation_id, serial, fingerprint, subject, not_before, not_after, agent_version, issued_via, last_seen_at)
  VALUES (c.organization_id, c.client_id, c.deployment_id, c.installation_id, p_serial, p_new_fingerprint, p_subject, p_not_before, p_not_after, c.agent_version, 'renewal', clock_timestamp());
  INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, ip, metadata)
  VALUES (c.organization_id, clock_timestamp(), 'agent', 'Agent ' || c.installation_id::text, 'agent.certificate.renewed', 'deployment', c.deployment_id::text,
          i.deployment_code, c.client_id, 'success', p_ip, jsonb_build_object('previousSerial', c.serial, 'serial', p_serial, 'notAfter', p_not_after));
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT 'ok'::text, i.deployment_code;
END $$;

REVOKE ALL ON FUNCTION agent_enrollment_check(bytea, uuid, uuid, inet), agent_enrollment_complete(bytea, uuid, uuid, text, bytea, text, timestamptz, timestamptz, text, inet),
  agent_identify(bytea), agent_heartbeat(bytea, text), agent_renew(bytea, text, bytea, text, timestamptz, timestamptz, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_enrollment_check(bytea, uuid, uuid, inet), agent_enrollment_complete(bytea, uuid, uuid, text, bytea, text, timestamptz, timestamptz, text, inet),
  agent_identify(bytea), agent_heartbeat(bytea, text), agent_renew(bytea, text, bytea, text, timestamptz, timestamptz, inet) TO psacc_app_rw;
