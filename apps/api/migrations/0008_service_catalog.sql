-- Module 4 — Service catalog administration.
-- The catalog tables exist since 0002 (database-driven, per organization, FORCE RLS). This migration lets the
-- application write them, records who changed what, and adds the lookups the catalog pages need.

ALTER TABLE services
  ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- Per-client values for a service's configuration requirements live in client_services.config (0002).
-- Deactivated services keep their assignments (history and running appliances are not disturbed);
-- new assignments are refused by the application.

CREATE INDEX services_category_idx ON services (category_id);
CREATE INDEX services_org_active_idx ON services (organization_id, is_active);

-- The application role manages the catalog (RLS still scopes every statement to the organization).
GRANT INSERT, UPDATE ON services TO psacc_app_rw;
GRANT INSERT, UPDATE, DELETE ON service_categories TO psacc_app_rw;
