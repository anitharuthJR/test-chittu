#!/usr/bin/env bash
#
# One command to run Chittu locally: API + client, both in the foreground,
# both stopped by a single Ctrl-C.
#
#   pnpm start
#
# No container and no credentials are required. Without DATABASE_URL the API
# uses PGlite (real Postgres, in-process, gone when the process exits), and
# without ANTHROPIC_API_KEY it uses the offline stub router.
#
# That second fallback is the one worth understanding: with no key there is no
# L2 classifier at all. Every turn classifies SAFE. A local session that looks
# safe is not evidence that it is — it is evidence that nothing was asked. The
# API states which router it built; this script deliberately does not guess,
# because .env.local can supply a key that never appears in this shell.
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

for p in "$API_PORT" "$WEB_PORT"; do
  if port_busy "$p"; then
    echo "port $p is already in use — stop what is on it, or set PORT / WEB_PORT." >&2
    exit 1
  fi
done

if [ ! -d node_modules ]; then
  echo "installing dependencies (first run)…"
  pnpm install --frozen-lockfile
fi

echo "─────────────────────────────────────────────────────────────"
# The router is NOT reported here. It used to be, by testing $ANTHROPIC_API_KEY
# in this shell — which stopped being the whole story once .env.local existed:
# the key can reach the API without ever being in this shell, and a banner that
# said STUB while the real classifier ran would be a false statement about which
# guards are live. main.ts knows, so main.ts says. Its stub warning is explicit
# that every turn classifies SAFE.
echo " model router : reported by the API on the next line — read it"
if [ -n "${DATABASE_URL:-}" ]; then
  echo " database     : $DATABASE_URL"
else
  echo " database     : PGlite, in-process — discarded on exit"
fi
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
