-- 0004_ticket_sync.sql
-- Module 12: ticket synchronization on the appliance. helpdesk_tickets is the system of record for this
-- client; the PSA is mirrored into it (inbound) and local changes are pushed back (outbound). The Control
-- Plane only ever receives counts and statuses from this schema, never rows.

ALTER TABLE helpdesk_tickets
  ADD COLUMN origin          text NOT NULL DEFAULT 'psa' CHECK (origin IN ('psa', 'portal')),
  ADD COLUMN sync_state      text NOT NULL DEFAULT 'synced' CHECK (sync_state IN ('synced', 'pending_push', 'conflict', 'push_failed', 'local_only')),
  ADD COLUMN last_synced_at  timestamptz,
  ADD COLUMN local_changed_at timestamptz;
CREATE INDEX helpdesk_tickets_sync_state_idx ON helpdesk_tickets (sync_state) WHERE sync_state <> 'synced';

-- Local changes travel to the PSA as events; pushed_at / push_error record the outcome of the push.
ALTER TABLE ticket_events
  ADD COLUMN pushed_at   timestamptz,
  ADD COLUMN push_error  text CHECK (push_error IS NULL OR length(push_error) <= 300);
CREATE INDEX ticket_events_pending_push_idx ON ticket_events (occurred_at) WHERE source = 'portal' AND pushed_at IS NULL;

ALTER TABLE sync_runs
  ADD COLUMN trigger         text NOT NULL DEFAULT 'scheduled' CHECK (trigger IN ('scheduled', 'manual', 'initial')),
  ADD COLUMN watermark_from  timestamptz,
  ADD COLUMN watermark_to    timestamptz,
  ADD COLUMN pages           integer NOT NULL DEFAULT 0 CHECK (pages >= 0);

-- Sync metadata for the agent's reports, readable by the catalog-only inspector role: counts only.
CREATE FUNCTION edge_sync_status() RETURNS TABLE (
  pending_outbound integer, conflicts_24h integer, last_succeeded_at timestamptz, runs_24h integer, failed_runs_24h integer,
  tickets_local_only integer, tickets_push_failed integer, watermark timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT
    (SELECT count(*)::int FROM ticket_events WHERE source = 'portal' AND pushed_at IS NULL),
    (SELECT count(*)::int FROM ticket_events WHERE event_type = 'sync_conflict' AND occurred_at > now() - interval '24 hours'),
    (SELECT max(finished_at) FROM sync_runs WHERE status IN ('succeeded', 'partial')),
    (SELECT count(*)::int FROM sync_runs WHERE started_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM sync_runs WHERE status = 'failed' AND started_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM helpdesk_tickets WHERE sync_state = 'local_only'),
    (SELECT count(*)::int FROM helpdesk_tickets WHERE sync_state = 'push_failed'),
    (SELECT value::timestamptz FROM app_metadata WHERE key = 'sync.inbound.watermark')
$$;
REVOKE ALL ON FUNCTION edge_sync_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edge_sync_status() TO psa_edge_inspector, psa_edge_app;
