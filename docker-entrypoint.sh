#!/bin/bash
set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"

# Initialize Postgres if needed
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  su postgres -c "initdb -D $PGDATA"
  echo "host all all 0.0.0.0/0 trust" >> "$PGDATA/pg_hba.conf"
fi

# Start Postgres in background
su postgres -c "pg_ctl -D $PGDATA -l /var/log/postgresql.log start -w"

# Create database and load schema
su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='graphtask'\" | grep -q 1" \
  || su postgres -c "createdb graphtask"
su postgres -c "psql -d graphtask -f /app/db/schema.sql"

# Start the Node server
export DATABASE_URL="postgresql://postgres@localhost/graphtask"
export PORT="${PORT:-3000}"
exec node /app/src/server.js
