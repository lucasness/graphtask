#!/bin/bash
set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"

# Initialize Postgres if needed
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  su postgres -c "initdb -D $PGDATA"
  # Loopback only — Node app and Postgres share this container
  echo "host all all 127.0.0.1/32 trust" >> "$PGDATA/pg_hba.conf"
  echo "host all all ::1/128       trust" >> "$PGDATA/pg_hba.conf"
fi

# Start Postgres in background, listening only on loopback
su postgres -c "pg_ctl -D $PGDATA -l /var/log/postgresql.log -o \"-c listen_addresses='127.0.0.1'\" start -w"

# Create database and load schema
su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='graphtask'\" | grep -q 1" \
  || su postgres -c "createdb graphtask"
su postgres -c "psql -d graphtask -f /app/db/schema.sql"

# Raise the soft fd limit to whatever the container's hard limit allows.
# docker-compose sets nofile=65535/65535 by default; if the container was
# started without that, we still pull the soft limit up to the existing hard.
ulimit -Sn 65535 2>/dev/null || ulimit -Sn "$(ulimit -Hn)" 2>/dev/null || true

# Start the Node server
export DATABASE_URL="postgresql://postgres@localhost/graphtask"
export PORT="${PORT:-3000}"
exec node /app/src/server.js
