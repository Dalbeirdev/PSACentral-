-- Module 13 — Remote commands: a PSA connection test may now be requested by a signed remote command
-- (relayed by the agent and executed by the worker); it is recorded with tested_by = 'remote'.
ALTER TABLE psa_connection_tests DROP CONSTRAINT IF EXISTS psa_connection_tests_tested_by_check;
ALTER TABLE psa_connection_tests ADD CONSTRAINT psa_connection_tests_tested_by_check CHECK (tested_by IN ('local_admin', 'worker', 'remote'));
ALTER TABLE psa_connections DROP CONSTRAINT IF EXISTS psa_connections_last_tested_by_check;
ALTER TABLE psa_connections ADD CONSTRAINT psa_connections_last_tested_by_check CHECK (last_tested_by IS NULL OR last_tested_by IN ('local_admin', 'worker', 'remote'));
-- A synchronization pass may also be requested by a signed remote command (trigger = 'remote').
ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_trigger_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_trigger_check CHECK (trigger IN ('scheduled', 'manual', 'initial', 'remote'));
