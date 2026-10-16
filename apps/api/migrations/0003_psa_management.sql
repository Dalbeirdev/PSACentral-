-- 0003_psa_management.sql
-- Module 3: PSA instance lifecycle status, notes, per-instance enabled services, unique names per client.

ALTER TABLE psa_instances
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  ADD COLUMN notes text CHECK (notes IS NULL OR length(notes) <= 2000);

-- Notes previously lived inside config (Module 2 onboarding); move them to their own column.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    PERFORM set_config('app.scope_all', 'on', true);
    UPDATE psa_instances SET notes = config ->> 'notes', config = config - 'notes' WHERE config ? 'notes';
    -- Authentication method keys renamed to match the provider adapters.
    UPDATE psa_instances SET auth_method = 'username_password' WHERE provider_key = 'kaseya_bms' AND auth_method = 'api_token';
    UPDATE psa_instances SET auth_method = 'oauth2_password' WHERE provider_key = 'servicenow' AND auth_method = 'oauth2';
    UPDATE psa_instances SET auth_method = 'oauth2_client_credentials' WHERE provider_key = 'custom_rest' AND auth_method = 'oauth2';
  END LOOP;
END $$;

CREATE UNIQUE INDEX psa_instances_client_name_key ON psa_instances (client_id, lower(display_name));
CREATE INDEX psa_instances_org_status_idx ON psa_instances (organization_id, status);

-- Which of the client's assigned services this PSA instance serves (e.g. Help Desk → this Autotask).
-- The composite FK to client_services removes the enablement automatically when the service is unassigned.
CREATE TABLE psa_instance_services (
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  psa_instance_id  uuid NOT NULL,
  service_id       uuid NOT NULL,
  enabled_by       uuid,
  enabled_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (psa_instance_id, service_id),
  CONSTRAINT pis_instance_fk FOREIGN KEY (client_id, psa_instance_id) REFERENCES psa_instances (client_id, id) ON DELETE CASCADE,
  CONSTRAINT pis_client_service_fk FOREIGN KEY (client_id, service_id) REFERENCES client_services (client_id, service_id) ON DELETE CASCADE,
  CONSTRAINT pis_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX pis_service_idx ON psa_instance_services (service_id);

ALTER TABLE psa_instance_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE psa_instance_services FORCE ROW LEVEL SECURITY;
CREATE POLICY pis_tenant ON psa_instance_services
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON psa_instance_services TO psacc_app_rw;

-- Backfill: services that use a PSA are enabled on the client's first (primary) PSA instance.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    PERFORM set_config('app.scope_all', 'on', true);
    INSERT INTO psa_instance_services (organization_id, client_id, psa_instance_id, service_id, enabled_by)
    SELECT cs.organization_id, cs.client_id, first_psa.id, cs.service_id, cs.enabled_by
    FROM client_services cs
    JOIN services s ON s.id = cs.service_id AND s.requires_psa
    CROSS JOIN LATERAL (
      SELECT i.id FROM psa_instances i WHERE i.client_id = cs.client_id ORDER BY i.created_at, i.code LIMIT 1
    ) first_psa
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
END $$;
