#!/usr/bin/env bash
#
# The container lane of `pnpm verify`: build the image and DRIVE it — consent ->
# session -> maths -> crisis, on a real Postgres, against the distroless
# runtime. The only lane that exercises the artifact that actually ships.
#
# It is a file rather than a `bash -c '...'` string inside verify.sh because it
# stopped being three lines: it now needs its own compose project, an overlay,
# an ephemeral port lookup and a teardown that runs on every exit path.
#
# TWO THINGS HERE ARE SAFETY PROPERTIES, not tidiness:
#
#   1. $PROJECT is NOT `chittu`. This script tears down with `down -v`, and
#      compose.yaml pins `name: chittu` — the ONE dev database every worktree
#      shares (#59). Run under that name and every `pnpm verify` silently wipes
#      the dev data of every worktree on the machine.
#   2. compose.verify.yaml drops the fixed host ports. See its header.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${VERIFY_PROJECT:-chittu-verify}"

compose() {
  docker compose -f compose.yaml -f compose.verify.yaml -p "$PROJECT" --profile dev "$@"
}

# Runs on every path out, including the health-wait failure and a Ctrl-C, so a
# killed run cannot leave a stack holding a port or a volume behind.
teardown() { compose down -v >/dev/null 2>&1 || true; }
trap teardown EXIT

teardown

# `api` and not everything: its depends_on pulls postgres-dev and the migrate
# task, while the tmpfs TEST database (compose.yaml's `postgres`, no profile,
# fixed :55432) stays out of it. That database belongs to `pnpm test`, it is
# very likely already up under the shared project, and this lane has no use
# for it.
compose up -d --build api || exit 1

# Ephemeral port: ask compose which one it got. Output is host:port, and the
# host half may be an IPv6 literal, so take the LAST colon-separated field.
PORT="$(compose port api 8080 2>/dev/null | awk -F: '{print $NF}' | head -1)"
if [ -z "$PORT" ]; then
  echo "could not resolve the api's published port" >&2
  compose ps >&2
  exit 1
fi
BASE="http://127.0.0.1:${PORT}"
echo "   driving ${BASE}"

for i in $(seq 1 120); do
  curl -sf "${BASE}/health" >/dev/null 2>&1 && break
  if [ "$i" = 120 ]; then
    echo "api never became healthy" >&2
    compose logs api 2>&1 | tail -30 >&2
    exit 1
  fi
  sleep 1
done

node scripts/smoke-dist.mjs "$BASE"
exit $?
