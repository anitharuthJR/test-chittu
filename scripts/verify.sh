#!/usr/bin/env bash
#
# Everything CI used to run, in one command.
#
#   pnpm verify                 # everything, including building the image
#   pnpm verify --no-container  # skip the slow lane when you know you can
#
# ALL LANES NEED DOCKER. `--with-pg` was removed on 2026-08-25 along with
# PGlite: the suite runs on a real Postgres, so the lane it used to add is the
# lane `pnpm test` already is.
#
# THE CONTAINER LANE IS NOT OPTIONAL ANY MORE, and #66 is why. It is the only
# lane that drives the artifact that ships, it sat behind `--with-container`
# with no CI to pass that flag, and so an image that could not boot at all —
# `ERR_MODULE_NOT_FOUND` on its first line — shipped for eight commits while
# 1881 tests stayed green. A check nobody runs is not a check. It costs
# minutes; a dead container costs a deploy.
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

WITH_CONTAINER=1

# The container lane gets its OWN compose project, and that is a safety
# property rather than tidiness. It tears down with `down -v`, and compose.yaml
# pins `name: chittu` — the ONE dev database every worktree shares (#59). Run
# under that name by default and every verify wipes everyone's dev data.
export VERIFY_PROJECT=chittu-verify

for arg in "$@"; do
  case "$arg" in
    --no-container)   WITH_CONTAINER=0 ;;
    # Both were the way to ASK for this lane. They now ask for what they
    # already have, so they stay parseable rather than becoming "unknown flag"
    # — same courtesy the removed --with-pg gets below.
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
# The story kit (llm-kit/nanochat/chittu) is Python under uv. Gated on the env EXISTING,
# not on uv: a bare `uv run` would sync the env and download torch in the middle of a
# verify. A skip says so — a check nobody runs is not a check, and a silent one is worse.
step "story kit"          bash -c 'if [ -x llm-kit/nanochat/.venv/bin/python ]; then cd llm-kit/nanochat && uv run --no-sync python -m pytest -q chittu; else echo "   SKIPPED: story kit env not set up (cd llm-kit/nanochat && uv sync --frozen --extra cpu --group dev) — its tests did not run"; fi'
step "compare kit"        bash -c 'if [ -x llm-kit/compare/.venv/bin/python ]; then cd llm-kit/compare && uv run --frozen python -m pytest -q; else echo "   SKIPPED: compare kit env not set up (cd llm-kit/compare && uv sync --frozen --group dev) — its tests did not run"; fi'
step "L1 crisis gate"     pnpm vitest run --project server packages/safety-kernel
# G2. Regressions block; the open-gap COUNT is pinned, so fixing one also fails
# here until the corpus is updated — which is how a number stops drifting.
step "red-team gate (G2, offline)" pnpm vitest run --project server packages/pipeline/src/red-team.test.ts
# The other half of G2 is `pnpm g2:live`, and it is NOT run here: it needs a
# provider key, a network and about 20c. It is also the half that finds what
# this lane structurally cannot — the offline gate hands the pipeline the label
# a correct classifier WOULD return, so it is green by construction on every
# defect that lives in the model or in reading the model's reply. The
# 2026-08-30 run found three CRITICAL blockers behind a green lane.
# Scorecards: safety-corpus/evals/.

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
  # Builds the image and DRIVES it. The only lane that exercises the artifact
  # that actually ships, and the reason it is no longer optional is #66: an
  # image that could not boot shipped for eight commits because nothing passed
  # --with-container. Its own file, because it grew past a bash -c string —
  # and two of its details (its own project, its own ports) are what let it run
  # beside the parallel worktrees this repo is used through.
  step "container + smoke" bash scripts/verify-container.sh
else
  printf '\n\033[2m── container lane SKIPPED by --no-container — the artifact that ships is unverified\033[0m\n'
fi

printf '\n────────────────────────────────────────\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mall green\033[0m\n'
  exit 0
fi
printf '\033[31mFAILED: %s\033[0m\n' "${FAILED[*]}"
exit 1
