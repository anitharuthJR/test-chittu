#!/usr/bin/env bash
#
# Everything CI used to run, in one command.
#
#   pnpm verify              # the four lanes that need no container
#   pnpm verify --with-pg    # adds the real-Postgres lane (needs Docker)
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

WITH_PG=0
[ "${1:-}" = "--with-pg" ] && WITH_PG=1

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
step "unit + integration" pnpm test
step "web bundle budget"  bash -c 'pnpm --filter @chittu/web build && pnpm --filter @chittu/web size'
step "prototype (playwright)" pnpm test:prototype
step "guard grader"       python3 llm-kit/test_eval_guard.py
step "corpus leakage"     bash -c 'cd llm-kit && python3 check_leakage.py'
step "L1 crisis gate"     pnpm vitest run --project server packages/safety-kernel

if [ "$WITH_PG" -eq 1 ]; then
  step "postgres 16 + pgvector" bash -c '
    pnpm db:up &&
    DATABASE_URL=postgres://chittu:chittu@localhost:55432/chittu_test pnpm test;
    rc=$?; pnpm db:down; exit $rc'
else
  printf '\n\033[2m── postgres lane skipped (pass --with-pg to include it)\033[0m\n'
fi

printf '\n────────────────────────────────────────\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mall green\033[0m\n'
  exit 0
fi
printf '\033[31mFAILED: %s\033[0m\n' "${FAILED[*]}"
exit 1
