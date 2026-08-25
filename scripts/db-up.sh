#!/usr/bin/env bash
#
# `pnpm db:up`, with a preflight that says what is actually wrong.
#
# compose.yaml pins `name: chittu` so every worktree shares one project and one
# container. That fixes the collision going forward — but it cannot help a
# machine that still has the OLD per-directory containers on it, and one of
# those holding the port produces this:
#
#   Error response from daemon: failed to set up container networking: driver
#   failed programming external connectivity on endpoint chittu-postgres-1
#   (4935efaf46a0…): Bind for 0.0.0.0:55432 failed: port is already allocated
#
# Which reads as "Docker is broken". It is not: another container has the port,
# it has a name, and stopping it is a one-liner. Say that instead.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Two callers, two services. `pnpm db:up` brings up the tmpfs TEST database;
# `scripts/dev.sh` brings up the volume-backed DEV one. Same collision, same
# message, one implementation — dev.sh hit this too, and `pnpm start` died on
# the raw driver error in exactly the same way `pnpm test` did.
PROJECT=chittu
case "${1:-test}" in
  test) SERVICE=postgres;      PORT=55432; PROFILE=() ;;
  dev)  SERVICE=postgres-dev;  PORT=55433; PROFILE=(--profile dev) ;;
  *)    echo "usage: db-up.sh [test|dev]" >&2; exit 2 ;;
esac

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — the suite runs on a real Postgres." >&2
  echo "start Docker (or OrbStack) and try again." >&2
  exit 1
fi

# Anything publishing our port that is NOT ours. `docker ps` filters on publish
# rather than parsing the Ports column, so an IPv4/IPv6 pair counts once.
foreign="$(docker ps --filter "publish=${PORT}" --format '{{.Names}}' \
  | grep -v "^${PROJECT}-${SERVICE}" || true)"

if [ -n "$foreign" ]; then
  echo "" >&2
  echo "port ${PORT} is held by a container that is not this project's:" >&2
  printf '  %s\n' $foreign >&2
  echo "" >&2
  echo "Almost certainly a LEFTOVER from before compose.yaml pinned its project" >&2
  echo "name — this repo used to start one Postgres per worktree, all fighting" >&2
  echo "over this port. There is one shared container now; the old ones are" >&2
  echo "debris and can go:" >&2
  echo "" >&2
  printf '  docker rm -f %s\n' $foreign >&2
  echo "" >&2
  echo "To sweep every stale one at once (this does NOT touch the shared" >&2
  echo "'${PROJECT}-*' containers):" >&2
  echo "" >&2
  echo "  docker ps -aq --filter name=-postgres | xargs -r docker rm -f" >&2
  echo "" >&2
  exit 1
fi

# The `up` itself. `--wait` blocks on the healthcheck, so a caller that returns
# from this script has a database that answers, not one that has been asked to
# start. Already-healthy is a no-op, which is the point of the shared project.
# `${A[@]+"${A[@]}"}` rather than `"${A[@]}"`: macOS ships bash 3.2, where an
# empty array under `set -u` is an unbound variable and takes the script down.
docker compose ${PROFILE[@]+"${PROFILE[@]}"} up -d --wait "$SERVICE"
