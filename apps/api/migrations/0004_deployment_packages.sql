-- 0004_deployment_packages.sql
-- Module 5: deployment packages, single-use enrollment tokens, download tracking.
--
-- A package is the client-specific Compose configuration + documentation for one installation of the
-- standard PSA Edge image. It is NOT an image. Its archive contains a short-lived single-use enrollment
-- token, so the archive is stored encrypted (AES-256-GCM, application key) only while that token can
-- still be used, and purged as soon as the package is superseded, revoked, expired or consumed.

CREATE TABLE deployment_packages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  client_id           uuid NOT NULL,
  deployment_id       uuid NOT NULL,
  package_number      integer NOT NULL CHECK (package_number >= 1),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'superseded', 'revoked', 'consumed')),
  -- Identity of the installation this package creates; registered when the agent enrolls (Module 7).
  installation_id     uuid NOT NULL UNIQUE,
  image_repository    text NOT NULL CHECK (image_repository ~ '^[a-z0-9]+([._/-][a-z0-9]+)*$' AND length(image_repository) <= 200),
  image_version       text NOT NULL CHECK (image_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'),
  image_digest        text CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_environment  text NOT NULL,
  target_os           text NOT NULL CHECK (target_os IN ('linux', 'windows')),
  target_arch         text NOT NULL CHECK (target_arch IN ('amd64', 'arm64')),
  -- Non-secret edge configuration as generated (config/edge.json), for display and audit.
  config_snapshot     jsonb NOT NULL,
  -- [{ path, size, sha256, containsToken }] for every file in the archive.
  manifest            jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  size_bytes          integer NOT NULL CHECK (size_bytes > 0),
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  archive_ciphertext  text,
  archive_purged_at   timestamptz,
  generated_by        uuid,
  generated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at          timestamptz,
  revoked_by          uuid,
  revoke_reason       text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 3 AND 200),
  download_count      integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  first_downloaded_at timestamptz,
  last_downloaded_at  timestamptz,
  CONSTRAINT deployment_packages_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT deployment_packages_deployment_id_key UNIQUE (deployment_id, id),
  CONSTRAINT deployment_packages_number_key UNIQUE (deployment_id, package_number),
  CONSTRAINT deployment_packages_deployment_fk FOREIGN KEY (client_id, deployment_id) REFERENCES deployments (client_id, id) ON DELETE RESTRICT,
  CONSTRAINT deployment_packages_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE RESTRICT,
  -- Only a usable package may hold its token-bearing archive.
  CONSTRAINT deployment_packages_archive_only_when_active CHECK (status = 'active' OR archive_ciphertext IS NULL),
  CONSTRAINT deployment_packages_active_has_archive CHECK (status <> 'active' OR archive_ciphertext IS NOT NULL),
  CONSTRAINT deployment_packages_revoked_has_ts CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT deployment_packages_downloaded_has_ts CHECK (download_count = 0 OR first_downloaded_at IS NOT NULL)
);
-- At most one usable package per deployment.
CREATE UNIQUE INDEX deployment_packages_one_active ON deployment_packages (deployment_id) WHERE status = 'active';
CREATE INDEX deployment_packages_org_client_idx ON deployment_packages (organization_id, client_id);

CREATE TABLE enrollment_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  package_id       uuid NOT NULL UNIQUE,
  -- SHA-256 of the token. The token itself is never stored in readable form.
  token_hash       bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  -- First characters only, so people can match a token to its package without seeing it.
  token_prefix     text NOT NULL CHECK (token_prefix ~ '^psacc_enr_[A-Za-z0-9_-]{4}$'),
  issued_by        uuid,
  issued_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Short-lived: at most 72 hours.
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  revoked_at       timestamptz,
  revoke_reason    text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 3 AND 200),
  CONSTRAINT enrollment_tokens_lifetime CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '72 hours'),
  CONSTRAINT enrollment_tokens_single_outcome CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT enrollment_tokens_package_fk FOREIGN KEY (deployment_id, package_id) REFERENCES deployment_packages (deployment_id, id) ON DELETE RESTRICT,
  CONSTRAINT enrollment_tokens_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE RESTRICT
);
-- At most one token per deployment that has been neither consumed nor revoked.
CREATE UNIQUE INDEX enrollment_tokens_one_open ON enrollment_tokens (deployment_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Append-only record of every package download.
CREATE TABLE deployment_package_downloads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  package_id       uuid NOT NULL,
  downloaded_by    uuid NOT NULL,
  downloaded_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  ip               inet,
  user_agent       text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT dpd_package_fk FOREIGN KEY (deployment_id, package_id) REFERENCES deployment_packages (deployment_id, id) ON DELETE RESTRICT,
  CONSTRAINT dpd_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX dpd_package_idx ON deployment_package_downloads (package_id, downloaded_at DESC);

-- Row-level security: organization + client scope, forced for the owner too.
ALTER TABLE deployment_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY deployment_packages_tenant ON deployment_packages
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

ALTER TABLE enrollment_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY enrollment_tokens_tenant ON enrollment_tokens
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

ALTER TABLE deployment_package_downloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_package_downloads FORCE ROW LEVEL SECURITY;
CREATE POLICY dpd_tenant ON deployment_package_downloads
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

-- Packages and tokens are never deleted (history); downloads are append-only.
GRANT SELECT, INSERT, UPDATE ON deployment_packages TO psacc_app_rw;
GRANT SELECT, INSERT, UPDATE ON enrollment_tokens TO psacc_app_rw;
GRANT SELECT, INSERT ON deployment_package_downloads TO psacc_app_rw;

-- Expiry sweep: packages whose token expired lose their archive, their deployment returns to 'draft'
-- (no usable package) and a system audit event is written. Optionally limited to one organization.
-- SECURITY DEFINER with a fixed search_path; it sets each organization's context so FORCE RLS still
-- applies, and restores the caller's context afterwards (it may run inside a tenant transaction).
CREATE FUNCTION app_expire_deployment_packages(p_org uuid DEFAULT NULL) RETURNS integer
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
      UPDATE deployment_packages p
         SET status = 'expired', archive_ciphertext = NULL, archive_purged_at = clock_timestamp()
        FROM enrollment_tokens t
       WHERE t.package_id = p.id AND p.status = 'active'
         AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at <= clock_timestamp()
      RETURNING p.id, p.deployment_id, p.client_id, p.package_number
    ), reverted AS (
      UPDATE deployments d SET lifecycle_state = 'draft', package_downloaded_at = NULL
        FROM expired e
       WHERE d.id = e.deployment_id AND d.lifecycle_state IN ('package_generated', 'package_downloaded')
      RETURNING d.id
    ), audited AS (
      INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_display, action, target_type, target_id,
                                target_display, client_id, outcome, metadata)
      SELECT o.id, clock_timestamp(), 'system', 'Package expiry', 'deployment.package.expired', 'deployment', e.deployment_id::text,
             d.code, e.client_id, 'success', jsonb_build_object('packageNumber', e.package_number, 'reason', 'Enrollment token expired')
        FROM expired e JOIN deployments d ON d.id = e.deployment_id
      RETURNING 1
    )
    SELECT count(*) INTO m FROM expired;
    n := n + m;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);
  PERFORM set_config('app.scope_all', prev_scope, true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app_expire_deployment_packages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_expire_deployment_packages(uuid) TO psacc_app_rw;