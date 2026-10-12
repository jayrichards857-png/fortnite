#!/usr/bin/env bash
# Start/stop a THROWAWAY local PostgreSQL server for running the test-suite. Nothing here touches your real data.
#   scripts/pg-test.sh start    initialise (first time) and start a server on 127.0.0.1:54329, data dir /tmp/pairplug-pg-test
#   scripts/pg-test.sh stop     stop it
#   scripts/pg-test.sh destroy  stop it and delete its data directory
#   eval "$(scripts/pg-test.sh env)"   export PAIRPLUG_TEST_PG for `npm test`
# Needs the PostgreSQL 16 server binaries (e.g. apt install postgresql-16). If you run as root the server runs as the `postgres` user.
set -euo pipefail
PORT="${PAIRPLUG_TEST_PG_PORT:-54329}"
DIR="${PAIRPLUG_TEST_PG_DIR:-/tmp/pairplug-pg-test}"
BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$BIN/pg_ctl" ] || { echo "PostgreSQL server binaries not found (set PG_BIN=/path/to/bin)"; exit 1; }
run() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"; [ "$(id -u)" = 0 ] && chown postgres:postgres "$DIR"
      run "$BIN/initdb" -D "$DIR/data" -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
    fi
    # fsync off = fast and DISPOSABLE. Never point this at data you care about.
    run "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" -l "$DIR/pg.log" -w start >/dev/null
    echo "PostgreSQL test server on 127.0.0.1:$PORT  (export PAIRPLUG_TEST_PG=postgres://postgres@127.0.0.1:$PORT/postgres)";;
  stop) run "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null && echo stopped;;
  destroy) run "$BIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; echo removed "$DIR";;
  env) echo "export PAIRPLUG_TEST_PG=postgres://postgres@127.0.0.1:$PORT/postgres";;
  *) echo "usage: $0 start|stop|destroy|env"; exit 2;;
esac
