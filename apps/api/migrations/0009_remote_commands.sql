-- Module 13 — Remote management: signed, time-limited commands pulled by agents (ARCHITECTURE AD-1, AD-13).
-- The Control Plane never connects into a client network. A command is issued by a user with
-- deployments.commands.issue, signed with the Control Plane's Ed25519 command key, fetched by the
-- deployment's agent with its heartbeat, verified and executed on the appliance, and answered over mTLS.
-- Every command keeps its ID, issuer, target, status, timestamps, expiry and result; issue, delivery,
-- completion, expiry and cancellation are audited.

-- One Ed25519 key per Control Plane; the private key is stored encrypted like the PKI keys (0005).
CREATE TABLE command_signing_keys (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  key_id          text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  public_key_pem  text NOT NULL CHECK (public_key_pem LIKE '-----BEGIN PUBLIC KEY-----%'),
  private_key_ciphertext text NOT NULL CHECK (private_key_ciphertext LIKE 'v1.%'),
  created_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON command_signing_keys TO psacc_app_rw;

CREATE TABLE remote_commands (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  client_id        uuid NOT NULL REFERENCES clients (id),
  deployment_id    uuid NOT NULL REFERENCES deployments (id),
  installation_id  uuid NOT NULL,
  command_type     text NOT NULL CHECK (command_type IN ('refresh_health', 'test_psa_connection', 'run_sync', 'restart_service', 'rotate_certificate', 'upgrade')),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'staged', 'succeeded', 'failed', 'expired', 'cancelled')),
  issued_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  note             text CHECK (note IS NULL OR length(note) <= 200),
  key_id           text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  signature        bytea NOT NULL CHECK (length(signature) = 64),
  delivered_at     timestamptz,
  finished_at      timestamptz,
  cancelled_at     timestamptz,
  cancelled_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  result_code      text CHECK (result_code IS NULL OR result_code ~ '^[a-z0-9_.-]{1,64}$'),
  result_message   text CHECK (result_message IS NULL OR length(result_message) <= 500),
  result_started_at timestamptz,
  result_agent_version text CHECK (result_agent_version IS NULL OR length(result_agent_version) <= 40),
  is_synthetic     boolean NOT NULL DEFAULT false,
  CONSTRAINT remote_commands_expiry CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '7 days'),
  CONSTRAINT remote_commands_finished CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL AND result_code IS NOT NULL)),
  CONSTRAINT remote_commands_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX remote_commands_deployment_idx ON remote_commands (deployment_id, issued_at DESC);
-- At most one open command of a type per deployment.
CREATE UNIQUE INDEX remote_commands_one_open_per_type ON remote_commands (deployment_id, command_type) WHERE status IN ('pending', 'delivered', 'staged');
CREATE INDEX remote_commands_open_idx ON remote_commands (expires_at) WHERE status IN ('pending', 'delivered', 'staged');
GRANT SELECT, INSERT, UPDATE ON remote_commands TO psacc_app_rw;

ALTER TABLE remote_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY remote_commands_tenant ON remote_commands
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

-- Agent side: fetch the open commands of the caller's deployment (marking them delivered) ...
CREATE FUNCTION agent_commands_fetch(p_fingerprint bytea)
RETURNS TABLE (result text, id uuid, command_type text, params jsonb, deployment_id uuid, installation_id uuid, issued_at timestamptz, expires_at timestamptz, key_id text, signature bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  i record;
BEGIN
  SELECT * INTO i FROM agent_identify(p_fingerprint);
  IF i.result <> 'ok' THEN
    RETURN QUERY SELECT i.result, NULL::uuid, NULL::text, NULL::jsonb, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::bytea;
    RETURN;
  END IF;
  PERFORM agent_ctx(i.organization_id);
  RETURN QUERY
    WITH due AS (
      UPDATE remote_commands c
         SET status = 'delivered', delivered_at = coalesce(c.delivered_at, clock_timestamp())
       WHERE c.deployment_id = i.deployment_id AND c.installation_id = i.installation_id
         AND c.status IN ('pending', 'delivered') AND c.expires_at > clock_timestamp()
      RETURNING c.id, c.command_type, c.params, c.deployment_id, c.installation_id, c.issued_at, c.expires_at, c.key_id, c.signature
    )
    SELECT 'ok'::text, d.id, d.command_type, d.params, d.deployment_id, d.installation_id, d.issued_at, d.expires_at, d.key_id, d.signature
      FROM due d ORDER BY d.issued_at;
  PERFORM agent_ctx(NULL);
END $$;

-- ... and answer one. A result is accepted once, only for the caller's own deployment and installation,
-- and only while the command is open (a late result after expiry is recorded as a note, not a success).
CREATE FUNCTION agent_command_result(p_fingerprint bytea, p_id uuid, p_status text, p_code text, p_message text, p_started_at timestamptz, p_finished_at timestamptz, p_agent_version text, p_ip inet)
RETURNS TABLE (result text, command_type text, deployment_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  i record;
  c record;
  v_status text;
BEGIN
  SELECT * INTO i FROM agent_identify(p_fingerprint);
  IF i.result <> 'ok' THEN
    RETURN QUERY SELECT i.result, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF p_status NOT IN ('succeeded', 'failed', 'staged') THEN
    RETURN QUERY SELECT 'invalid_status'::text, NULL::text, i.deployment_code;
    RETURN;
  END IF;
  PERFORM agent_ctx(i.organization_id);
  SELECT * INTO c FROM remote_commands WHERE id = p_id FOR UPDATE;
  IF c.id IS NULL OR c.deployment_id <> i.deployment_id OR c.installation_id <> i.installation_id THEN
    PERFORM agent_ctx(NULL);
    RETURN QUERY SELECT 'unknown_command'::text, NULL::text, i.deployment_code;
    RETURN;
  END IF;
  IF c.status NOT IN ('pending', 'delivered', 'staged') THEN
    PERFORM agent_ctx(NULL);
    RETURN QUERY SELECT 'not_open'::text, c.command_type, i.deployment_code;
    RETURN;
  END IF;
  v_status := p_status;
  IF p_status = 'staged' THEN
    UPDATE remote_commands SET status = 'staged', delivered_at = coalesce(delivered_at, clock_timestamp()),
           result_code = left(p_code, 64), result_message = left(p_message, 500), result_started_at = p_started_at, result_agent_version = left(p_agent_version, 40)
     WHERE id = p_id;
  ELSE
    UPDATE remote_commands SET status = v_status, delivered_at = coalesce(delivered_at, clock_timestamp()), finished_at = p_finished_at,
           result_code = left(p_code, 64), result_message = left(p_message, 500), result_started_at = p_started_at, result_agent_version = left(p_agent_version, 40)
     WHERE id = p_id;
  END IF;
  INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, ip, metadata)
  VALUES (c.organization_id, clock_timestamp(), 'agent', 'Agent ' || c.installation_id::text,
          CASE WHEN p_status = 'staged' THEN 'deployment.command.staged' ELSE 'deployment.command.completed' END,
          'deployment', c.deployment_id::text, i.deployment_code, c.client_id,
          CASE WHEN p_status = 'failed' THEN 'failure' ELSE 'success' END, p_ip,
          jsonb_build_object('commandId', c.id, 'type', c.command_type, 'status', v_status, 'code', left(p_code, 64), 'message', left(p_message, 500), 'agentVersion', left(p_agent_version, 40)));
  PERFORM agent_ctx(NULL);
  RETURN QUERY SELECT 'ok'::text, c.command_type, i.deployment_code;
END $$;

-- Expiry sweep (all organizations, or one): open commands past their expiry are closed and audited.
CREATE FUNCTION app_expire_remote_commands(p_org uuid DEFAULT NULL) RETURNS integer
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
      UPDATE remote_commands c SET status = 'expired'
       WHERE c.organization_id = o.id AND c.status IN ('pending', 'delivered', 'staged') AND c.expires_at <= clock_timestamp()
      RETURNING c.id, c.deployment_id, c.client_id, c.command_type, c.status AS previous
    ), audited AS (
      INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id, target_display, client_id, outcome, metadata)
      SELECT o.id, clock_timestamp(), 'system', 'Command expiry', 'deployment.command.expired', 'deployment', e.deployment_id::text, d.code, e.client_id, 'failure',
             jsonb_build_object('commandId', e.id, 'type', e.command_type)
        FROM expired e JOIN deployments d ON d.id = e.deployment_id
      RETURNING 1
    )
    SELECT count(*) INTO m FROM audited;
    n := n + m;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);
  PERFORM set_config('app.scope_all', prev_scope, true);
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION agent_commands_fetch(bytea), agent_command_result(bytea, uuid, text, text, text, timestamptz, timestamptz, text, inet), app_expire_remote_commands(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_commands_fetch(bytea), agent_command_result(bytea, uuid, text, text, text, timestamptz, timestamptz, text, inet), app_expire_remote_commands(uuid) TO psacc_app_rw;
