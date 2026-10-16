-- 0003_psa_connection_tests.sql
-- Module 11: real PSA authentication and API tests run on this appliance. The result of every test is
-- kept here (codes, HTTP status, latency, a redacted detail) — never credentials, never ticket content.

ALTER TABLE psa_connections
  ADD COLUMN last_test_code        text CHECK (last_test_code IS NULL OR last_test_code ~ '^[a-z0-9_.-]{1,64}$'),
  ADD COLUMN last_test_http_status smallint CHECK (last_test_http_status IS NULL OR last_test_http_status BETWEEN 100 AND 599),
  ADD COLUMN last_test_latency_ms  integer CHECK (last_test_latency_ms IS NULL OR last_test_latency_ms >= 0),
  ADD COLUMN last_tested_by        text CHECK (last_tested_by IS NULL OR last_tested_by IN ('local_admin', 'worker')),
  ADD COLUMN last_success_at       timestamptz,
  ADD COLUMN remote_identity       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(remote_identity) = 'object'),
  ADD COLUMN consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- "verified" needs a recorded success, not just an attempt.
  ADD CONSTRAINT psa_connections_verified_requires_success CHECK (status <> 'verified' OR last_success_at IS NOT NULL);

CREATE TABLE psa_connection_tests (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  psa_connection_id  uuid NOT NULL REFERENCES psa_connections (id) ON DELETE CASCADE,
  tested_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  tested_by          text NOT NULL CHECK (tested_by IN ('local_admin', 'worker')),
  ok                 boolean NOT NULL,
  code               text NOT NULL CHECK (code ~ '^[a-z0-9_.-]{1,64}$'),
  http_status        smallint CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  latency_ms         integer NOT NULL CHECK (latency_ms >= 0),
  detail             text NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
  remote_identity    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(remote_identity) = 'object')
);
CREATE INDEX psa_connection_tests_time_idx ON psa_connection_tests (psa_connection_id, tested_at DESC);

GRANT SELECT, INSERT ON psa_connection_tests TO psa_edge_app;

-- Test metadata for the agent's reports, readable by the catalog-only inspector role (no credentials, no bodies).
CREATE FUNCTION edge_psa_status() RETURNS TABLE (
  last_test_code text, last_test_http_status smallint, last_test_latency_ms integer, last_tested_by text, last_success_at timestamptz,
  remote_identity jsonb, consecutive_failures integer, tests_24h integer, failures_24h integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.last_test_code, c.last_test_http_status, c.last_test_latency_ms, c.last_tested_by, c.last_success_at, c.remote_identity, c.consecutive_failures,
    (SELECT count(*)::int FROM psa_connection_tests t WHERE t.psa_connection_id = c.id AND t.tested_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM psa_connection_tests t WHERE t.psa_connection_id = c.id AND NOT t.ok AND t.tested_at > now() - interval '24 hours')
  FROM (SELECT * FROM psa_connections ORDER BY created_at LIMIT 1) c
$$;
REVOKE ALL ON FUNCTION edge_psa_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edge_psa_status() TO psa_edge_inspector, psa_edge_app;
