#!/usr/bin/env bash
# Rebuild a throwaway database, apply the migration, seed it, run the suite.
set -euo pipefail
export PATH=/usr/lib/postgresql/16/bin:$PATH
HOST=${PGHOST:-/tmp}; PORT=${PGPORT:-5433}; DB=${PGDATABASE:-hla_test}
PSQL="psql -h $HOST -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
HERE="$(cd "$(dirname "$0")" && pwd)"

dropdb   -h "$HOST" -p "$PORT" -U postgres --if-exists "$DB"
createdb -h "$HOST" -p "$PORT" -U postgres "$DB"
$PSQL -d "$DB" -f "$HERE/00_auth_shim.sql"
for m in "$HERE"/../supabase/migrations/0*.sql; do $PSQL -d "$DB" -f "$m"; done
$PSQL -d "$DB" -f "$HERE/../supabase/seed.sql"
psql -h "$HOST" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 \
     -f "$HERE/01_engine_test.sql" -f "$HERE/04_rules_test.sql" 2>&1 \
  | grep -E '(^==|NOTICE|ERROR|FAIL)' \
  | sed -E 's/^psql:[^:]*:[0-9]+: //; s/^NOTICE:  //'

echo
echo "== exposure: what anon and a signed-in bidder can actually read =="
psql -h "$HOST" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 \
     -f "$HERE/03_exposure_test.sql" 2>&1 \
  | sed -E 's/^psql:[^:]*:[0-9]+: //; s/^NOTICE:  //' \
  | grep -E '(ok|FAIL|ERROR)'

PGDATABASE="$DB" "$HERE/02_race_test.sh"
