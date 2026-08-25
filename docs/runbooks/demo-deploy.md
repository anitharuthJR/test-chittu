# Runbook — demo deployment (chittu.tulifo.ai)

**What this is:** one small EC2 box that lets a person be shown the product without an AWS
build-out. **What it is not:** the deployment path. That is `infra/` (Fargate + RDS + KMS),
which remains unapplied. The box runs dev-mode keys and still offers `dev_stub` consent —
both of which production refuses by construction — so it rehearses none of the production
key path and moves nothing on **G2–G5**.

**G1 is the exception, and it is not a simulation.** Since 2026-08-25 this box also offers
`automated_id_check` against a LIVE Didit workflow: anyone past the basic-auth wall who
picks "Photo ID check" verifies a real government document and spends one of the 500 free
verifications for the month. Tell a demo audience before they photograph their own ID —
§10 is the caveat, §5 the settings, and `DIDIT_ENVIRONMENT=sandbox` the way to show the
flow without any of it. Being live does not CLEAR G1 either: the gate is live but not
signed off, waiting on a DPO/DPIA decision and a read of Didit's DPA rather than on code.
`docs/chittu-status.md` carries the row.

**Shape:** `t4g.small` (arm64) · Docker running `deploy/demo/compose.yaml` (postgres →
migrate → api) · Caddy serving the built PWA and proxying `/v1`, with automatic HTTPS on
`chittu.tulifo.ai` (GoDaddy DNS) · basic auth as the only gate · **no local LLM** —
`CHITTU_LOCAL_BASE_URL` is unset, so the router reaches Anthropic (key present) or the stub
(absent). Nothing from `llm-kit/` is involved anywhere.

Running cost ≈ **$17–24/mo**; stopped between demos ≈ **$6/mo**. Table in §9.

> **Current state (2026-08-26): FULLY DEPLOYED, `main` @ `d48fa22` (deployment 3).**
> `infra/envs/demo` applied into account **430313601196** (`ap-south-1`): instance
> `i-04e0ddcc0b509612d` (`t4g.small`) on the adopted EIP **13.205.39.18** =
> `chittu.tulifo.ai` (Let's Encrypt cert valid to Nov 2026). Compose stack healthy
> (postgres + migrated schema + api), image `chittu-api:latest` = `c2d6cc4c2e68`.
> Boot banner: **Anthropic router**, `/ops` mounted with 1 operator, **automated ID
> check offered against a live workflow**, grounded corpus `UNAVAILABLE` (the correct
> three-state answer for an Anthropic-only box, not an outage). Basic auth user
> `demo`; the password and the demo family's parent PIN are with Arun, not in this
> repo. CLI access is the `devops` profile via `aws login` (temporary — re-run
> `aws login --profile devops` when expired).
>
> Every deployment and config change to this box is listed under **Deployment log**
> below, along with the two traps the 2026-08-26 refresh found. This block is only
> ever the CURRENT answer; the log is the history.
>
> Verified after the refresh: `/health` ok, the boot banner (Anthropic router,
> `/ops` mounted with 1 operator, corpus `UNAVAILABLE` — which is the correct
> three-state answer for an Anthropic-only box, not an outage), the deployed web
> bundle byte-identical to the built one, and
> `scripts/smoke-dist.mjs` driven against the deployed API over an SSH forward:
> 32/32, both bands — Law 02, consent cookie never in the body, scripted crisis
> spine, L1 before any classifier, no control-token leak, category-only parent
> flags, crisis lock surviving a re-open. That walk writes two demo families into
> the demo database; `docker compose down -v` and re-onboarding clears them.
> The browser UI behind basic auth was NOT re-walked — §7 by hand still wants a
> human with the password.
>
> That banner also read `automated ID check: NOT offered`, which is the one line
> of it that has since changed: the Didit keys were added later the same day and
> the box now reports `offered, live workflow`. The header is the current answer;
> this block is a record of the refresh, not of today.
>
> **Gotcha found by the walk:** never hand out the URL in
> `https://user:pass@chittu.tulifo.ai` form. A page loaded that way carries the
> credentials in its base URL, and the fetch spec then rejects every relative
> `/v1` request the app makes — the consent flow reports "no verification method"
> and nothing works. Share the bare URL and let the browser's own prompt collect
> the password.

---

## Deployment log

**Nothing tracks deployments automatically, so this table is the record.** The
`deployment` table in the schema is NOT a ledger despite the name — it is a one-row
singleton (`only_row boolean PRIMARY KEY CHECK (only_row)`) holding `env` and `region`, and
its whole job is letting the database refuse `dev_stub` in production. `migrate.ts` writes
it `ON CONFLICT DO NOTHING`, so on this box `set_at` reads `2026-08-25 11:55:41+00` — the
first migration ever run here, unchanged by every deployment since. Do not read it as a
deployment time.

Append a row when you ship. A deployment is a NEW IMAGE on the box; a change to
`/opt/chittu/.env` followed by a restart is a config change and gets its own row marked as
one, because the two fail in different ways and "what is running" is not the same question
as "what is configured".

| # | When | Image | `main` @ | What it carried |
|---|---|---|---|---|
| 1 | 2026-08-25 ~11:54 UTC | *(id not recoverable — replaced by #2)* | `fcec3d0` (#56) | First deploy. §1–§7 walked end-to-end in the browser: consent (dev_stub) → chat → maths (zero model calls) → crisis (scripted spine, IN helplines, lock) → parent PIN → category-only flags → unlock → seal verify. Stub router; no provider key on the box yet. |
| — | 2026-08-25, later | *(unchanged)* | — | **Config only.** `ANTHROPIC_API_KEY` added to `/opt/chittu/.env`; api recreated. Router went from stub to Anthropic. No new image, which is why the runbook went on describing a stub router that was not running. |
| 2 | 2026-08-26 ~01:56 IST | `602929d9cf92` | `3c7ded9` (#62) | Nine commits of catch-up: reading coach (#58), layer-6 grounding (#60), D5 dashboard nodes (#57), Didit ID verification (#61), the picture input, the corpus banner fix, the ops users page. Migrations `0007`–`0009` applied. Found and fixed the boot bug in #66 and the ops-console regression below. |
| — | 2026-08-25 20:xx UTC | *(unchanged)* | — | **Config only.** Didit keys added (`DIDIT_ENVIRONMENT=live`); api recreated. G1's real rail went live on the box — see the header. No new image. |
| 3 | 2026-08-26 ~04:00 IST | `c2d6cc4c2e68` | `d48fa22` (#70) | The two consent scopes that were declared but ungrantable (#70), the default container lane (#69), and the Didit-retention and G1 doc corrections (#67, #68). **No migrations** — `0 applied this run, 9 known, 34 tables`. `pnpm verify` all green INCLUDING the container lane, so the image was booted and driven (32/32) before it was shipped. After the restart: `/health` ok, `/ops` still mounted and the ID rail still offered — the two settings the previous deployment silently dropped. |

**The deployed smoke walk is a ONE-SHOT — do not re-run it as a health check.**
`scripts/smoke-dist.mjs` uses a fixed `smoke-<band>@example.com`, and `parent.email_hash`
is `NOT NULL UNIQUE`, so a second run against the same database fails on a duplicate parent
— which reads as a broken deployment and is not one. Deployment 2 used it (writing the two
families still in there); deployment 3 relied on the container lane instead, which drives
the identical image locally against a throwaway database and can run as often as you like.

**Two traps the 2026-08-26 refresh found**, both worth re-reading before the next one:

- **The image would not boot, and no cheap lane said so.** `@chittu/reading-coach` (#58) was
  in neither of the Dockerfile's two hand-maintained package lists, so the runtime image
  carried a dangling pnpm symlink and died on `ERR_MODULE_NOT_FOUND` at its first line —
  with 1881 tests green. Fixed in #66; `apps/api/src/dockerfile-workspace.test.ts` guards
  both lists, and #69 made the container lane part of `pnpm verify` by default so the
  artifact is booted before it is shipped.
- **Shipping `deploy/demo/compose.yaml` turned the ops console OFF.** `CHITTU_OPS_TOKENS`
  was set in the box's `.env` and named in the box's hand-edited compose file but never in
  the repo's, and compose passes only what the block names — the same trap the file's own
  Didit comment warns about. The variable is in the repo's block now. **If you hand-edit
  compose ON THE BOX, the next `scp` deletes it; put it in the repo instead.**

---

## 0. Which mode this runs in, honestly

- `NODE_ENV=development` — the only environment where `dev_stub` consent completes, and
  where the local key provider's allowlist permits running without KMS. Correct for a demo;
  the database refuses `dev_stub` in prod. **`dev_stub` is no longer the only method offered
  here.** That parenthetical used to read "every real adapter is blocked on something
  external", and it stopped being true on 2026-08-25: `automated_id_check` is live on this
  box against a real Didit workflow (§10). The rest are still blocked.
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
