#!/usr/bin/env bash
#
# Everything CI used to run, in one command.
#
#   pnpm verify                   # everything except building the image
#   pnpm verify --with-container  # adds build-the-image + drive-it
#
# ALL LANES NEED DOCKER now. `--with-pg` was removed on 2026-08-25 along with
# PGlite: the suite runs on a real Postgres, so the lane it used to add is the
# lane `pnpm test` already is. `--with-container` is still separate because it
# builds the image, which is minutes rather than seconds.
#
# GitHub Actions was removed on 2026-08-25 — it had been failing every run at 3s
# with "the job was not started because recent account payments have failed", so
# it was providing no signal, only noise. This script is what replaces it, and
# the point of writing it rather than just deleting the workflow is that the
# CHECKS should not disappear with the runner.
#
# Run it before you merge. Nothing else will.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_CONTAINER=0
for arg in "$@"; do
  case "$arg" in
    --with-container) WITH_CONTAINER=1 ;;
    --all)            WITH_CONTAINER=1 ;;
    # Named explicitly rather than falling into "unknown flag", because it was a
    # documented flag and muscle memory outlives a release note.
    --with-pg)
      echo "--with-pg is gone: the suite runs on real Postgres, so that lane is now the default." >&2
      exit 2 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

FAILED=()
step() {
  local name="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m   ok\033[0m\n'
  else
    printf '\033[31m   FAILED\033[0m\n'
    FAILED+=("$name")
  fi
}

step "typecheck"          pnpm typecheck
# Starts postgres on :55432 itself (`pnpm test` chains `pnpm db:up`). The
# container is left up afterwards, so a rerun does not pay initdb again.
step "unit + integration" pnpm test
step "web bundle budget"  bash -c 'pnpm --filter @chittu/web build && pnpm --filter @chittu/web size'
step "prototype (playwright)" pnpm test:prototype
step "guard grader"       python3 llm-kit/test_eval_guard.py
step "corpus leakage"     bash -c 'cd llm-kit && python3 check_leakage.py'
step "L1 crisis gate"     pnpm vitest run --project server packages/safety-kernel

# The emit, not the sources. `pnpm test` resolves @chittu/* through the
# `development` export condition and therefore proves nothing about dist/ —
# which is what the container runs and what the export map points production at.
# This lane is cheap and catches the whole class: an extensionless relative
# specifier typechecks under `bundler` and is unresolvable under `nodenext`.
step "compile to dist"    pnpm -r --filter '!@chittu/web' build

# Terraform, as far as it can be checked without an AWS account: fmt, and a
# validate of every module and env. NOT a plan — that needs credentials, and
# this repository has never had any. infra/README.md is explicit about the
# difference and about the fact that nothing has ever been applied.
if command -v terraform >/dev/null 2>&1; then
  step "terraform fmt + validate" bash -c '
    terraform fmt -recursive -check infra || exit 1
    rc=0
    for d in infra/modules/*/ infra/envs/*/; do
      terraform -chdir="$d" init -backend=false >/dev/null 2>&1 || { echo "init failed: $d"; rc=1; continue; }
      terraform -chdir="$d" validate -no-color >/dev/null 2>&1 || { echo "validate failed: $d"; terraform -chdir="$d" validate -no-color; rc=1; }
    done
    exit $rc'
else
  printf '\n\033[2m── terraform lane skipped (terraform not installed)\033[0m\n'
fi

if [ "$WITH_CONTAINER" -eq 1 ]; then
  # Builds the image and DRIVES it: consent -> session -> maths -> crisis, on a
  # real Postgres, against the distroless runtime. The only lane that exercises
  # the artifact that actually ships.
  step "container + smoke" bash -c '
    docker compose --profile dev down -v >/dev/null 2>&1
    docker compose --profile dev up -d --build || exit 1
    for i in $(seq 1 90); do
      curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1 && break
      [ "$i" = 90 ] && { echo "api never became healthy"; docker compose --profile dev logs api | tail -30; docker compose --profile dev down -v >/dev/null 2>&1; exit 1; }
      sleep 1
    done
    node scripts/smoke-dist.mjs http://127.0.0.1:8080
    rc=$?
    docker compose --profile dev down -v >/dev/null 2>&1
    exit $rc'
else
  printf '\n\033[2m── container lane skipped (pass --with-container to include it)\033[0m\n'
fi

printf '\n────────────────────────────────────────\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mall green\033[0m\n'
  exit 0
fi
printf '\033[31mFAILED: %s\033[0m\n' "${FAILED[*]}"
exit 1
