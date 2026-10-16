#!/bin/sh
# Runs once, on first initialization of the psacc-dev-pgdata volume.
# Creates least-privilege roles and the per-purpose databases. Never runs on restart.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$PSACC_OWNER_PASSWORD" -v app_pw="$PSACC_APP_PASSWORD" <<'SQL'
-- Owns schema objects; used only by the migration runner.
CREATE ROLE psacc_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'owner_pw';
-- Group role holding the application's DML grants (granted by migrations).
CREATE ROLE psacc_app_rw NOLOGIN NOSUPERUSER NOBYPASSRLS;
-- Login role used by the API. Cannot bypass row-level security.
CREATE ROLE psacc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_pw' IN ROLE psacc_app_rw;
SQL

for db in $PSACC_DATABASES; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE DATABASE \"$db\" OWNER psacc_owner"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$db" TO psacc_app_rw;
ALTER SCHEMA public OWNER TO psacc_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO psacc_app_rw;
SQL
done
