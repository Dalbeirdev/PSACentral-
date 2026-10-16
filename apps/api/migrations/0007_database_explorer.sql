-- 0007_database_explorer.sql
-- Module 9: per-table schema metadata (columns, keys, indexes, statistics) reported by the agent's
-- catalog-only inspector role. One row per deployment table; rows are projected from
-- `database_schema` reports and never hold table contents.

CREATE TABLE deployment_tables (
  organization_id  uuid NOT NULL,
  client_id        uuid NOT NULL,
  deployment_id    uuid NOT NULL,
  schema_name      text NOT NULL CHECK (length(schema_name) BETWEEN 1 AND 64),
  table_name       text NOT NULL CHECK (length(table_name) BETWEEN 1 AND 64),
  kind             text NOT NULL CHECK (kind IN ('table', 'partitioned')),
  -- Snapshot the row belongs to; rows of an older snapshot are removed when a snapshot completes.
  fingerprint      text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
  observed_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  columns          jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  primary_key      jsonb CHECK (primary_key IS NULL OR jsonb_typeof(primary_key) = 'object'),
  indexes          jsonb NOT NULL CHECK (jsonb_typeof(indexes) = 'array'),
  foreign_keys     jsonb NOT NULL CHECK (jsonb_typeof(foreign_keys) = 'array'),
  stats            jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
  PRIMARY KEY (deployment_id, schema_name, table_name),
  CONSTRAINT deployment_tables_deployment_fk FOREIGN KEY (client_id, deployment_id) REFERENCES deployments (client_id, id) ON DELETE CASCADE,
  CONSTRAINT deployment_tables_client_fk FOREIGN KEY (organization_id, client_id) REFERENCES clients (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX deployment_tables_org_idx ON deployment_tables (organization_id, deployment_id);
ALTER TABLE deployment_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY deployment_tables_tenant ON deployment_tables
  USING (organization_id = app_current_org() AND app_can_access_client(client_id))
  WITH CHECK (organization_id = app_current_org() AND app_can_access_client(client_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON deployment_tables TO psacc_app_rw;
