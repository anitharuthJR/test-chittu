#!/usr/bin/env bash
#
# One command to run Chittu locally: Postgres, API and client, with the API and
# client in the foreground and both stopped by a single Ctrl-C.
#
#   pnpm start
#
# NEEDS DOCKER. The in-process PGlite fallback was removed on 2026-08-25 — it
# could not run pgvector, so it was serving a shimmed schema, and it was slower
# than the container besides. This script starts `postgres-dev` (volume-backed,
# :55433) and migrates it before launching, because bootstrapDb() connects and
# deliberately does not migrate. The container is LEFT RUNNING on exit: the
# volume is the point, and `pnpm stack:down` is how you stop it.
#
# No credentials are required. Without ANTHROPIC_API_KEY the API uses the
# offline stub router, and that fallback is the one worth understanding: with no
# key there is no L2 classifier at all. Every turn classifies SAFE. A local
# session that looks safe is not evidence that it is — it is evidence that
# nothing was asked. The API states which router it built; this script
# deliberately does not guess, because .env.local can supply a key that never
# appears in this shell.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_PORT="${PORT:-8080}"
WEB_PORT="${WEB_PORT:-5173}"

# Job control ON, so each `&` child becomes its own process-group leader and can
# be signalled as a GROUP. This is load-bearing rather than tidy: `pnpm --filter
# … run dev` is a wrapper that spawns vite as a grandchild, so killing the PID we
# actually hold leaves vite alive and holding :5173. Observed, not theorised —
# the first version of this script did exactly that.
set -m

API_PID=""
WEB_PID=""

# Kill the whole group, then the bare pid as a fallback for the case where the
# child never made it into a group of its own.
kill_tree() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  kill_tree "$WEB_PID"
  kill_tree "$API_PID"
  # Give them a moment to close listeners, then insist.
  sleep 1
  kill -KILL -- "-$WEB_PID" 2>/dev/null || true
  kill -KILL -- "-$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo ""
  echo "stopped."
}
trap cleanup INT TERM EXIT

port_busy() { lsof -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

# Reclaim a port instead of refusing to start on it. This used to exit 1 and
# tell you to clean up by hand — which was correct caution for a port some
# OTHER worktree is legitimately using, but this repo's normal mode is 2-3
# parallel worktrees each on their OWN PORT/WEB_PORT, and the process actually
# holding one of these two is overwhelmingly this same worktree's previous
# `pnpm start` that Ctrl-C didn't reach (a crashed shell, a killed terminal).
# Printed PID + command before killing either way, so a genuine collision with
# someone else's server is visible rather than silently reclaimed.
free_port() {
  local port="$1" pids pid
  pids="$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  echo "port $port is in use — reclaiming it:" >&2
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    ps -o pid=,command= -p "$pid" 2>/dev/null | sed 's/^/  /' >&2
    kill_tree "$pid"
  done <<< "$pids"
  for _ in $(seq 1 10); do
    port_busy "$port" || return 0
    sleep 0.3
  done
  # Still listening after TERM — insist, the same way cleanup() does on exit.
  pids="$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done <<< "$pids"
  sleep 0.3
  if port_busy "$port"; then
    echo "port $port is still in use after kill -9 — probably not ours to take (permissions, or a non-process listener)." >&2
    exit 1
  fi
}

for p in "$API_PORT" "$WEB_PORT"; do
  free_port "$p"
done

if [ ! -d node_modules ]; then
  echo "installing dependencies (first run)…"
  pnpm install --frozen-lockfile
fi

# The database, before anything that needs one. Same spirit as the line above:
# this script's job is that `pnpm start` works, not that you have assembled the
# prerequisites yourself.
DATABASE_URL="${DATABASE_URL:-postgres://chittu:chittu@localhost:55433/chittu}"
export DATABASE_URL

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — Chittu needs a real Postgres." >&2
  echo "start Docker (or OrbStack), or point DATABASE_URL at your own server." >&2
  exit 1
fi

echo "starting postgres-dev…"
# Through the shared preflight, for the same reason `pnpm db:up` goes through
# it: compose.yaml pins one project for the whole repository, and a leftover
# per-worktree container holding :55433 otherwise fails here with a Docker
# driver error that names an endpoint hash instead of the container. `--wait`
# inside it blocks on the healthcheck, so the migration below cannot race the
# server's first-boot initdb.
bash scripts/db-up.sh dev

# Migrations are a SEPARATE STEP from booting the API on purpose — see the
# comment at the top of apps/api/src/migrate.ts. It keeps a ledger, so running
# it on every launch against a volume-backed database is a no-op after the first.
pnpm db:migrate

echo "─────────────────────────────────────────────────────────────"
# The router is NOT reported here. It used to be, by testing $ANTHROPIC_API_KEY
# in this shell — which stopped being the whole story once .env.local existed:
# the key can reach the API without ever being in this shell, and a banner that
# said STUB while the real classifier ran would be a false statement about which
# guards are live. main.ts knows, so main.ts says. Its stub warning is explicit
# that every turn classifies SAFE.
echo " model router : reported by the API on the next line — read it"
# The host and database, never the password DATABASE_URL carries — this line is
# read aloud in screen shares and pasted into issues.
echo " database     : $(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@/]*@#://#')"
echo " api          : http://localhost:$API_PORT"
echo " app          : http://localhost:$WEB_PORT"
echo "─────────────────────────────────────────────────────────────"

PORT="$API_PORT" pnpm --filter @chittu/api run dev &
API_PID=$!

# Wait for the API before starting vite, so the first page load does not race
# the proxy target and show a connection error the user has to reload past.
for _ in $(seq 1 60); do
  if curl -sf --max-time 1 "http://localhost:$API_PORT/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "api exited during startup — see the output above." >&2
    exit 1
  fi
  sleep 0.5
done

# NO `--` before these flags. pnpm 11 forwards `--` to the script VERBATIM, so
# `vite -- --port 5174 --strictPort` makes vite stop reading at the `--`: it
# falls back to the port in vite.config.ts (5173) and, with --strictPort also
# lost, auto-increments off it. That is the worst shape of bug, because WEB_PORT
# then looks like it worked — vite usually lands on the port you asked for by
# arriving at it one busy port at a time. Observed on pnpm 11.9.0, which this
# repo pins: without the `--`, vite binds WEB_PORT exactly or exits.
pnpm --filter @chittu/web run dev --port "$WEB_PORT" --strictPort &
WEB_PID=$!

echo ""
echo "ready — open http://localhost:$WEB_PORT   (Ctrl-C stops both)"
echo ""

# Exit as soon as EITHER dies, so a crashed API does not leave a client running
# against nothing and looking merely broken.
#
# Polled rather than `wait -n`, which macOS's stock bash 3.2 does not have —
# there it fails instantly with "invalid option" and the script tears the whole
# thing down a second after printing "ready". Costs one wake per second and
# works on every bash anyone actually has.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done
