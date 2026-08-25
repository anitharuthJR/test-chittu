# Runbook — demo deployment (chittu.tulifo.ai)

**What this is:** one small EC2 box that lets a person be shown the product without an AWS
build-out. **What it is not:** the deployment path. That is `infra/` (Fargate + RDS + KMS),
which remains unapplied, and this box moves nothing on G1–G5 — it runs dev-mode consent and
dev-mode keys, which production refuses by construction.

**Shape:** `t4g.small` (arm64) · Docker running `deploy/demo/compose.yaml` (postgres →
migrate → api) · Caddy serving the built PWA and proxying `/v1`, with automatic HTTPS on
`chittu.tulifo.ai` (GoDaddy DNS) · basic auth as the only gate · **no local LLM** —
`CHITTU_LOCAL_BASE_URL` is unset, so the router reaches Anthropic (key present) or the stub
(absent). Nothing from `llm-kit/` is involved anywhere.

Running cost ≈ **$17–24/mo**; stopped between demos ≈ **$6/mo**. Table in §9.

> **Current state (2026-08-26): FULLY DEPLOYED, refreshed to `main` @ 3c7ded9.**
> `infra/envs/demo` applied into account **430313601196** (`ap-south-1`): instance
> `i-04e0ddcc0b509612d` (`t4g.small`) on the adopted EIP **13.205.39.18** =
> `chittu.tulifo.ai` (Let's Encrypt cert valid to Nov 2026). Compose stack healthy
> (postgres + migrated schema + api), image `chittu-api:latest` = `602929d9cf92`.
> **The router is Anthropic**, not the stub — a key was added to `/opt/chittu/.env`
> after the first deploy, and the boot line says so. Basic auth user `demo`; the
> password and the demo family's parent PIN are with Arun, not in this repo.
> CLI access is the `devops` profile via `aws login` (temporary — re-run
> `aws login --profile devops` when expired).
>
> **The 2026-08-26 refresh**, for the record, because two of its three findings
> are traps the next refresh can fall into as well:
>
> - Migrations `0007_reading_stats`, `0008_automated_id_check` and `0009_ops_users`
>   applied on the ledger's first run against the existing demo data; 34 tables.
> - **The image would not boot, and no cheap lane said so.** `@chittu/reading-coach`
>   (#58) was in neither of the Dockerfile's two hand-maintained package lists, so
>   the runtime image carried a dangling pnpm symlink and died on
>   `ERR_MODULE_NOT_FOUND` at its first line — with 1881 tests green. Fixed, and
>   `apps/api/src/dockerfile-workspace.test.ts` now guards both lists.
> - **Shipping `deploy/demo/compose.yaml` turned the ops console OFF.**
>   `CHITTU_OPS_TOKENS` was set in the box's `.env` and named in the box's
>   hand-edited compose file but never in the repo's, and compose passes only what
>   the block names — the same trap the file's own Didit comment warns about. The
>   variable is in the repo's block now. If you hand-edit compose ON THE BOX again,
>   the next `scp` deletes it; put it in the repo instead.
>
> Verified after the refresh: `/health` ok, the boot banner (Anthropic router,
> `/ops` mounted with 1 operator, ID check not offered, corpus `UNAVAILABLE` —
> which is the correct three-state answer for an Anthropic-only box, not an
> outage), the deployed web bundle byte-identical to the built one, and
> `scripts/smoke-dist.mjs` driven against the deployed API over an SSH forward:
> 32/32, both bands — Law 02, consent cookie never in the body, scripted crisis
> spine, L1 before any classifier, no control-token leak, category-only parent
> flags, crisis lock surviving a re-open. That walk writes two demo families into
> the demo database; `docker compose down -v` and re-onboarding clears them.
> The browser UI behind basic auth was NOT re-walked — §7 by hand still wants a
> human with the password.
>
> **Gotcha found by the walk:** never hand out the URL in
> `https://user:pass@chittu.tulifo.ai` form. A page loaded that way carries the
> credentials in its base URL, and the fetch spec then rejects every relative
> `/v1` request the app makes — the consent flow reports "no verification method"
> and nothing works. Share the bare URL and let the browser's own prompt collect
> the password.

---

## 0. Which mode this runs in, honestly

- `NODE_ENV=development` — the only environment where `dev_stub` consent completes (G1:
  every real adapter is blocked on something external) and where the local key provider's
  allowlist permits running without KMS. Correct for a demo; the database refuses
  `dev_stub` in prod.
- `CHITTU_DEV_MASTER_KEY` is **required** by the compose file. Without a stable key the dev
  provider mints `randomBytes(32)` per boot and every API restart makes previously stored
  ciphertext unreadable — loud by design, wrong for a box that stops between demos.
- Without `ANTHROPIC_API_KEY` the stub router serves L2/L5 and says so on the API's first
  log line. The strongest demo material — consent, CPA maths, the crisis turn + lock +
  parent unlock, L1 guards, memory book, dashboard, seal verify — makes **zero** model
  calls either way.

## 1. AWS — one-time, Terraform-managed

The box, its security group (22 from one address; **80 + 443 from 0.0.0.0/0**, because
Let's Encrypt must reach it — basic auth is the gate, not the firewall), the key pair and
the Elastic IP association are all `infra/envs/demo`:

```bash
cd infra/envs/demo   # terraform.tfvars: your /32, your .pub line, the EIP mode
terraform init && terraform plan
terraform apply      # after a human reads the plan
```

The EIP itself is either adopted (hand-allocated, survives `destroy` — the DNS record
stays valid) or created and owned by Terraform (`destroy` releases it and the GoDaddy
record must be repointed) — set `eip_allocation_id` accordingly; see `infra/README.md`,
"envs/demo".

## 2. GoDaddy DNS — one-time

In the `tulifo.ai` DNS management panel, add one record (this touches nothing else on the
domain — not MX, not the apex):

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `chittu` | the Elastic IP | lowest offered (600s / ½ hour) |

Verify before moving on: `dig +short chittu.tulifo.ai` returns the EIP.

## 3. Box packages — automated

`infra/envs/demo/user-data.sh` runs on first boot and does all of it: Docker
(get.docker.com), Caddy (official apt repo), both services enabled, `/srv/chittu-web` and
`/opt/chittu` created and owned by `ubuntu`. Allow ~2–3 minutes after the instance shows
running, then verify rather than assume:

```bash
ssh ubuntu@<public_ip> 'docker --version && systemctl is-enabled caddy && ls -ld /opt/chittu'
```

If anything is missing, the transcript is in `/var/log/cloud-init-output.log`.

## 4. Ship a build — from the Mac, repeated per update

The box never compiles anything. Apple-silicon Macs are arm64, the same architecture as
t4g, so the image `pnpm verify` builds in its container lane runs there natively. (If ever
building from an x86 machine instead: `docker buildx build --platform linux/arm64`.)

```bash
docker build -f apps/api/Dockerfile -t chittu-api .
docker save chittu-api | gzip | ssh chittu-demo 'gunzip | docker load'

pnpm install && pnpm build
rsync -a --delete apps/web/dist/ chittu-demo:/srv/chittu-web/
scp deploy/demo/compose.yaml chittu-demo:/opt/chittu/compose.yaml
```

(`chittu-demo` is an `~/.ssh/config` alias for `ubuntu@<elastic-ip>`.)

## 5. First start — on the box

```bash
cd /opt/chittu
# .env per deploy/demo/.env.example:
#   CHITTU_DEV_MASTER_KEY=$(openssl rand -base64 32)   ← generate ONCE, keep it
#   ANTHROPIC_API_KEY=...                              ← optional, low-limit key
#   CHITTU_OPS_TOKENS=name=token                       ← bare token refuses to BOOT
#
# The G1 ID rail (optional; absent => not offered, and the banner says so):
#   DIDIT_API_KEY=...
#   DIDIT_WORKFLOW_ID=c53d125d-d09e-47d0-a16a-5c0ade2b9c7e
#   DIDIT_ENVIRONMENT=live
#   DIDIT_CALLBACK_URL=https://chittu.tulifo.ai/?idcheck=return   ← NOT localhost
chmod 600 .env
docker compose up -d
docker compose ps                  # api "healthy" — its healthcheck hits /health, which checks the DB
curl -s localhost:8080/health
```

**`DIDIT_CALLBACK_URL` must be the public origin.** Copied verbatim from a developer's
`.env.local` it reads `http://localhost:5173/?idcheck=return`, which sends every parent
back to their OWN machine after the ID check. The failure is silent in the worst way: the
vendor completes, bills, and reports success, and only the return hop is broken.

**Keep the key.** Losing `.env` makes every stored demo row unreadable — that is the
crypto-shred property working as designed. For a demo the fallback is also fine: wipe the
volume (`docker compose down -v`) and re-onboard in seconds.

## 6. Caddy — one-time

```bash
caddy hash-password                          # paste the hash into the Caddyfile
sudo cp Caddyfile /etc/caddy/Caddyfile       # from deploy/demo/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The first request to <https://chittu.tulifo.ai> triggers certificate issuance; expect a
few seconds. From that moment the hostname is in public Certificate Transparency logs,
permanently — see §10.

## 7. Verify before any demo — the walk

consent (dev_stub) → chat → a maths turn → a crisis turn (lock, helplines, parent flag) →
parent PIN → dashboard → seal verify.

This is the same walk CLAUDE.md prescribes after `apps/web` changes, for the same reason:
layout defects on the screens that matter most are not reachable from a test runner.

## 8. Between demos, and updating

- **Stop the instance** when idle (console or `aws ec2 stop-instances`). The EIP, the
  Postgres volume and `.env` all persist; cost drops to ≈ $6/mo. On start, Docker's
  restart policies bring postgres and the API back unattended.
- **New build:** repeat §4, then on the box
  `docker compose up -d --force-recreate migrate api` — migrate reruns to completion (a
  no-op ledger check when there is nothing new), then the API restarts on the new image.
- **Logs:** `docker compose logs -f api`. First line states stub vs real router.

## 9. Costs (approximate on-demand, ap-south-1)

| Item | Monthly |
|---|---|
| EC2 `t4g.small`, 24/7 | ~$10–13 |
| EBS 30 GB gp3 | ~$2.50 |
| Elastic IP | ~$3.60 |
| Data transfer (demo traffic) | <$1 |
| Domain — subdomain on owned `tulifo.ai` | $0 |
| Anthropic usage at demo volumes | ~$1–5 |
| **Total running** | **≈ $17–24** |
| **Stopped between demos** (EBS + EIP only) | **≈ $6** |

Reference point: applying the real Terraform dev environment would run ≈ $120–140/mo — and
still could not serve the PWA, since no CloudFront/S3 web tier is written.

## 10. Caveats — read before sharing the URL

- **Basic auth is the only gate.** Certificate Transparency makes the hostname public and
  discoverable the moment the cert issues; there is no obscurity. Use a real password,
  never remove the block, and note it covers `/v1` — the API — not just the page.
- **No real children.** "No child has ever used it" is a load-bearing sentence in this
  project, and a demo URL must not be where it stops being true. The audience is adults.
- **The ID rail is LIVE, and it bills.** Since 2026-08-25 the box runs
  `automated_id_check` with `DIDIT_ENVIRONMENT=live`, so anyone past the basic-auth wall
  who picks "Photo ID check" performs a real identity verification against a real
  government document and consumes one of the 500 free verifications per month. It is not
  a simulation. Two consequences worth stating: a demo audience should be told before they
  photograph their own ID, and G1 is still recorded as awaiting a DPO/DPIA decision about
  a processor handling parents' biometrics. Set `DIDIT_ENVIRONMENT=sandbox` with a
  sandbox key to demo the flow without any of that.
- **Rate limiting is shared behind the proxy.** The API keys its per-IP limit
  (`apps/api/src/server.ts`, default 120/window) off the socket address and does not trust
  proxy headers, so behind Caddy every visitor is `127.0.0.1` and the whole audience
  shares one budget. Fine for a handful of people; a large room may bump into it. Do not
  "fix" this by enabling proxy trust for the demo — that is a production decision with its
  own review.
- **The provider key sits on a demo box.** Use a scoped, low-limit key; `.env` stays mode
  600; the SG keeps 22 closed to the world.
- Surface area, for the record: Caddy is the only listener on 80/443, the API binds
  loopback only, and Postgres publishes no port.

## Teardown

`docker compose down -v` → terminate the instance → **release the Elastic IP** (it bills
until released) → delete the `chittu` A record at GoDaddy.
