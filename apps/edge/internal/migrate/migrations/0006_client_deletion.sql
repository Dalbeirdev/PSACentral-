-- Module 17: client-initiated deletion ("Delete all data and deregister").
--
-- The application role may only append to audit_events and integration_logs (least privilege). Deleting
-- everything this appliance holds is the one sanctioned exception, and it is a function the schema owner
-- defines, not a privilege the application gets: it needs the deployment code as confirmation, removes
-- every row of every application table, and leaves a single marker so the local admin and the uninstall
-- script can tell that the appliance was emptied on purpose.

CREATE FUNCTION edge_wipe_all_data(p_confirm text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_code text;
  v_table text;
  c bigint;
  out jsonb := '{}'::jsonb;
BEGIN
  SELECT value INTO v_code FROM app_metadata WHERE key = 'deployment.code';
  IF v_code IS NULL OR p_confirm IS NULL OR upper(p_confirm) <> upper(v_code) THEN
    RAISE EXCEPTION 'confirmation does not match this appliance''s deployment code' USING ERRCODE = 'P0001';
  END IF;
  FOR v_table IN
    SELECT t.table_name FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND t.table_name <> 'schema_migrations'
     ORDER BY t.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', v_table) INTO c;
    out := out || jsonb_build_object(v_table, c);
    EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', v_table);
  END LOOP;
  INSERT INTO app_metadata (key, value) VALUES ('service.deleted', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || v_code);
  RETURN out;
END $$;

REVOKE ALL ON FUNCTION edge_wipe_all_data(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edge_wipe_all_data(text) TO psa_edge_app;
