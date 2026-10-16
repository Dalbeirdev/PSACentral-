-- 0002_health_status.sql
-- Module 8: metadata for the agent's health reports, exposed to the catalog-only inspector role through
-- SECURITY DEFINER functions. They return counts, statuses, timestamps and redacted error codes —
-- never ticket content or credentials.

-- Service liveness, PSA status, backup status and local admin security counters.
CREATE FUNCTION edge_health_status() RETURNS TABLE (
  worker_last_seen_at timestamptz,
  psa_instance_code text, psa_provider text, psa_status text, psa_credential_fields_present integer, psa_last_test_at timestamptz, psa_last_test_result text,
  backup_last_status text, backup_last_at timestamptz, backup_last_size_bytes bigint, backup_retained integer, backup_last_error text,
  tickets_total integer, tickets_open integer, ticket_events_24h integer, ticket_failed_24h integer, ticket_last_processed_at timestamptz,
  sync_last_run_at timestamptz, sync_last_status text, sync_items_received integer, sync_items_sent integer, sync_items_failed integer, sync_error_code text,
  errors_24h integer, local_admin_failed_logins_24h integer, local_admin_locked boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT
    (SELECT value::timestamptz FROM app_metadata WHERE key = 'worker.last_seen_at'),
    c.instance_code, c.provider, c.status,
    (SELECT count(*)::int FROM credential_store s WHERE s.psa_connection_id = c.id),
    c.last_test_at, left(c.last_test_result, 64),
    coalesce(b.status, 'none'), coalesce(b.finished_at, b.started_at), b.size_bytes,
    (SELECT count(*)::int FROM backup_runs WHERE status = 'succeeded'), left(b.error_message, 200),
    (SELECT count(*)::int FROM helpdesk_tickets),
    (SELECT count(*)::int FROM helpdesk_tickets WHERE status IN ('new', 'open', 'pending', 'on_hold')),
    (SELECT count(*)::int FROM ticket_events WHERE occurred_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM ticket_events WHERE occurred_at > now() - interval '24 hours' AND event_type = 'sync_conflict'),
    (SELECT max(occurred_at) FROM ticket_events),
    r.started_at, r.status, r.items_received, r.items_sent, r.items_failed, r.error_code,
    (SELECT count(*)::int FROM integration_logs WHERE level = 'error' AND occurred_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM audit_events WHERE action = 'local_admin.login' AND outcome IN ('failure', 'denied') AND occurred_at > now() - interval '24 hours'),
    (SELECT coalesce(bool_or(locked_until > now()), false) FROM local_admin_users)
  FROM (SELECT * FROM psa_connections ORDER BY created_at LIMIT 1) c
  LEFT JOIN LATERAL (SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 1) b ON true
  LEFT JOIN LATERAL (SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1) r ON true
$$;

-- Recent integration errors: component, code, HTTP status and the (already redacted) message, newest first.
CREATE FUNCTION edge_recent_errors(p_limit integer DEFAULT 10) RETURNS TABLE (occurred_at timestamptz, component text, error_code text, http_status smallint, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT occurred_at, component, error_code, http_status, left(message, 200)
  FROM integration_logs WHERE level = 'error' ORDER BY id DESC LIMIT least(greatest(p_limit, 1), 20)
$$;

REVOKE ALL ON FUNCTION edge_health_status(), edge_recent_errors(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edge_health_status(), edge_recent_errors(integer) TO psa_edge_inspector, psa_edge_app;
