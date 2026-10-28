# Chittu proof-of-concept deployment runbook

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | Workspace `package.json` version `0.1.0`. The EC2 tree has no `.git` directory. No deployed commit SHA was recorded. |
| Model revision | Pending on the instance. The comparison harness pins `Tulifo/chittu-story-v0-26m` at `4f11284f8ebc19348ce2885bfea66eb13c8717cc` (`llm-kit/compare/compare/systems.py`). That pin was not compared with the files in `~/chittu-story-v0-26m`. |
| Environment | AWS EC2 `i-0f99f1c94ff3ff3e6`, `ap-southeast-2a`, public address observed as `3.104.224.113` |
| Author role | Deployment audit from repository inspection and the 2026-10-26 operator session |
| Reviewer | Pending |
| Approval status | Draft. Not approved for production. |

This runbook describes the proof-of-concept box that was actually used. It is not the repository's intended demo path. That path is `docs/runbooks/demo-deploy.md` and `infra/envs/demo`: an arm64 `t4g.small` in `ap-south-1`, Elastic IP `13.205.39.18`, hostname `chittu.tulifo.ai`. On 2026-10-26 that hostname still answered HTTPS with Caddy basic auth. It was not redeployed by this work.

## Evidence labels

- **Verified** means a command output, HTTP response, log line, or file read from this session.
- **Operator-reported** means it was supplied as background and was not independently reproduced.
- **Pending** means the check could not be completed.

On 2026-10-27, from the same workstation that reached the instance on 2026-10-26, TCP connections to `3.104.224.113` ports 22, 80, 443, 8080, and 8001 timed out. SSH to `chittu-ec2` timed out. `aws sts get-caller-identity` failed TLS verification because Avast Web/Mail Shield replaces Amazon's certificate, and a separate signed EC2 call on 2026-10-26 returned `AuthFailure`. No AWS resource was modified for this audit. Anything below that describes a live process is true of 2026-10-26 unless a later check is cited.

## 1. What this box is

| Item | Verified value | Evidence |
|---|---|---|
| Account and IAM | Not read. The instance metadata IAM credentials URL returned 404, so the instance has no instance profile. Local AWS keys were rejected. | IMDS `iam/security-credentials/` on 2026-10-26; STS/EC2 API errors |
| Region | `ap-southeast-2` (`ap-southeast-2a`), not `ap-south-1` | IMDS |
| Instance | `i-0f99f1c94ff3ff3e6`, `m7i-flex.large`, x86_64 | IMDS, `uname -m` |
| CPU and RAM | 2 vCPU, 7.6 GiB RAM, about 522 MiB used at first inspection, before the story process was restarted | `nproc`, `free -h` |
| Disk | `/dev/root` 28G, 13G used, 16G free (46%). Volume type and exact billed size were not read. | `df -h /` |
| OS | Ubuntu 26.04.1 LTS | `/etc/os-release` |
| Public address | `3.104.224.113` at inspection. Whether it is an Elastic IP was not confirmed. | IMDS `public-ipv4` |
| Private address | `172.31.2.151` | IMDS |
| Security group name | `launch-wizard-2`. Rule list was not retrieved. | IMDS `security-groups` |
| SSH | User `ubuntu`. Key file `ml_deploy_KP.pem` (public fingerprint `SHA256:XARdqPz3BhlTFdOu6UKtQSuP7ELD6npFmsY1x/phs9Y`). Default `id_rsa` did not match. Windows OpenSSH config host: `chittu-ec2`. | Successful SSH on 2026-10-26 |
| Application tree | `/home/ubuntu/chittu`, no `.git` | `ls`, `git` check |
| Model tree | `/home/ubuntu/chittu-story-v0-26m` | directory listing |
| Model code dependency | `/home/ubuntu/nanochat` (`nanochat/gpt.py`) | import failure, then success after `PYTHONPATH` |
| Python env | `/home/ubuntu/chittu-model-venv` (interpreter symlink to `/usr/bin/python3`, Python 3.14.4) | `python -c` |
| Node | `/usr/bin/node` v22.23.4, `/usr/bin/pnpm` 11.9.0 | version commands |
| Caddy | 2.11.7, installed from the Cloudsmith apt repository | `caddy version`, apt log |

The web client is Preact and Vite (`apps/web`), not React. The API is Fastify (`apps/api`).

## 2. Prerequisites

Verified on the operator workstation on 2026-10-26:

- OpenSSH.
- The `ml_deploy_KP.pem` private key, with permissions OpenSSH would accept. The key material is not recorded here.
- Network reachability to TCP 22. On the morning of 2026-10-26, ports 80 and 443 were closed from the workstation. Port 80 was open later the same day, before any successful AWS API call. The security-group edit that opened it was not performed by the AWS CLI in this session.

Not available:

- A working AWS CLI identity. Installation of AWS CLI 2.38.5 succeeded. Calls did not.
- Node, pnpm, and Docker on the workstation. Builds ran on the instance.
- GoDaddy access. DNS for `chittu.tulifo.ai` was not changed. On 2026-10-26 it was an A record, TTL 600, to `13.205.39.18`.

## 3. Chronological procedure

### 3.1 Source placement

**Where:** EC2, before this session.

**Operator-reported:** GitHub clone failed and the tree was copied with WinSCP.

**Verified:** `/home/ubuntu/chittu` existed, had no `.git`, and these files were byte-identical to the workspace used for this audit: `package.json`, `pnpm-lock.yaml`, `apps/web/package.json`, `apps/web/vite.config.ts`, `deploy/demo/Caddyfile`, `deploy/demo/compose.yaml`, `.env.example`. SHA-256 values were compared on 2026-10-26. `apps/api/src/providers/cells.ts` was not in that comparison.

`node_modules` was already present. `apps/web/dist` was not.

### 3.2 Runtimes already on the box

**Verified present:** Node 22.23.4, pnpm 11.9.0, Python 3.14.4, Docker, Git. Caddy was not installed. PostgreSQL client `psql` was not installed. Postgres ran in Docker image `pgvector/pgvector:pg16`, container `chittu-postgres-dev-1`, project `chittu`, volume `chittu_chittu-dev-data`. At first contact the container was `Exited` and had last been unhealthy.

### 3.3 Build

**Where:** `/home/ubuntu/chittu` on EC2.

**Command verified:** `/usr/bin/pnpm build`, which runs the root script `pnpm -r --filter './packages/**' --filter './apps/**' run build`.

**Result:** exit 0 at 2026-10-26 06:48:14 UTC. Vite 6.4.3 wrote `apps/web/dist`. The JS bundle was 74.51 kB (26.67 kB gzip). `index.html` was 1.41 kB. API `tsc` completed. Output was copied to `/srv/chittu-web`.

### 3.4 Database

**Why:** `bootstrapDb()` connects and does not migrate. Migrations are applied by `apps/api/src/migrate.ts` (`pnpm --filter @chittu/api run migrate`). There is no `apps/api/src/migrate.js`.

**Change verified:** in the server copy of `compose.yaml`, the dev database publish was changed from `55433:5432` to `127.0.0.1:55433:5432`. The container was recreated. `docker inspect` then showed `HostIp` `127.0.0.1` and restart policy `unless-stopped`. The named volume was kept.

**Migration result:** `0 applied this run, 9 known, 35 tables present`. Files `0001` through `0009` were already applied.

**Secret handling:** `DATABASE_URL` and `CHITTU_DEV_MASTER_KEY` were written to `/home/ubuntu/.config/chittu/api.env`, mode 600. Values are not recorded in this document. `.env.local` in the tree only named `CHITTU_LOCAL_BASE_URL` and `CHITTU_CELL_SANDBOX`. Its values were `http://127.0.0.1:8001` and `local:chittu-story-v0-26m`.

`NODE_ENV=development` was set because production refuses to boot without KMS, and because a dev master key is the supported demo key provider. This is the repository's own demo rule (`deploy/demo/compose.yaml`), not a production configuration.

### 3.5 Story model service

**Failure verified:** the first systemd unit set `PYTHONPATH` to only `~/chittu-story-v0-26m`. The process exited with `ModuleNotFoundError: No module named 'nanochat.gpt'`.

**Correction verified:** `PYTHONPATH=/home/ubuntu/nanochat:/home/ubuntu/chittu-story-v0-26m`. The unit was restarted. `GET http://127.0.0.1:8001/health` returned `{"model":"chittu-story-v0-26m","status":"ok"}`. The listen address was `127.0.0.1:8001`.

**Startup log, one observation:** systemd started the unit at 2026-10-26 08:17:30 UTC. "Chittu story model loaded." was logged at 08:17:34 UTC. Flask then reported `Running on http://127.0.0.1:8001`.

The unit file is `/etc/systemd/system/chittu-story.service`. `ExecStart` is `/home/ubuntu/chittu-model-venv/bin/python /home/ubuntu/chittu-story-api.py`. `Restart=on-failure`. A reboot test was not run.

### 3.6 Chittu API service

Unit `/etc/systemd/system/chittu-api.service`:

- User `ubuntu`
- Working directory `/home/ubuntu/chittu/apps/api`
- `EnvironmentFile=/home/ubuntu/.config/chittu/api.env`
- `ExecStart=/usr/bin/node dist/main.js`
- `Restart=on-failure`

**Boot log verified at 2026-10-26 08:14:51 UTC:**

- `.env.local supplied: CHITTU_LOCAL_BASE_URL, CHITTU_CELL_SANDBOX`
- database `127.0.0.1:55433/chittu`
- providers configured: `local`
- cells naming unreachable providers: `classifier -> anthropic`, `homework -> anthropic`, `curriculum -> anthropic`, `vision -> anthropic`
- routing override in effect: `sandbox -> local/chittu-story-v0-26m (env)`
- provider clearance not enforced outside production
- automated ID check not offered
- grounded corpus banner: `ON — local/mxbai-embed-large`
- listening on `http://127.0.0.1:8080`
- `GET /health` returned `{"status":"ok"}`

The workspace copy of `MODEL_CATALOGUE` in `apps/api/src/providers/cells.ts` does not list `chittu-story-v0-26m`. `validate()` refuses an uncatalogued model, and `describeCells()` prints only cells that passed. This workspace therefore cannot log `sandbox -> local/chittu-story-v0-26m` as in effect. The process on the instance did log that line at 08:14:51 UTC, and the captured journal tail did not contain `routing config REJECTED`. The server copy of `cells.ts` and of `dist/` was not hashed. The running build and this repository disagree. That remains unresolved until SSH can diff them.

The same journal line was written while `chittu-story.service` was still crash-looping on `ModuleNotFoundError: No module named 'nanochat.gpt'`. The line shows the API accepted the cell. It does not show that the model was loaded yet. The paired generation test was later, after `/health` returned ok.

Later the same day the public site stopped serving the Chittu API and served the Flask process instead. It was not re-proven whether the `chittu-api` process itself was still running after that routing change. The stop commands were given to the operator and were not confirmed by a later `systemctl` read.

### 3.7 Public HTTP

Caddy was installed and, in the final verified arrangement, forwarded port 80 to `127.0.0.1:8001`.

**Verified publicly on 2026-10-26:**

- `GET http://3.104.224.113/health` returned HTTP 200, body `{"model":"chittu-story-v0-26m","status":"ok"}`, `Server: Werkzeug/3.1.9`, `Via: 1.1 Caddy`.
- `GET /` returned the small HTML prompt page, HTTP 200.
- `POST /chat/completions` with a sparrow prompt and `max_tokens` 40 returned a story. `generation_seconds` was 0.717.
- No basic auth was required on these model routes.
- TLS was not configured. `https://` was not used. Certificate issuance for `chittu.tulifo.ai` was deliberately not started, because DNS still pointed at the other server.

An earlier arrangement the same day served the built frontend and proxied `/v1` and `/health` to `127.0.0.1:8080`, with HTTP basic auth user `demo`. That arrangement was then replaced. The password file remains on the server at `/home/ubuntu/.config/chittu/basic-auth.password` and is not copied here.

### 3.8 Browser page

`/home/ubuntu/chittu-story-api.py` gained a `GET /` handler that serves a one-field form. The Ask button posts JSON to `/chat/completions`. This was added on 2026-10-26 after a browser navigation to `/chat/completions` correctly returned "Method Not Allowed" (the address bar sends GET; the route is POST-only). The service was restarted and `GET /` returned 200. A screenshot from the operator showed a generated story on that page.

The Flask development server remains the process behind the proxy. Werkzeug logged that it should not be used as production deployment.

## 4. Operate what is deployed

These commands were the ones installed. Re-run them only after SSH works again. They are not a new deployment.

```bash
ssh chittu-ec2
systemctl is-active chittu-story caddy chittu-api
sudo systemctl restart chittu-story
sudo systemctl reload caddy
journalctl -u chittu-story.service -n 50 --no-pager
curl -sS http://127.0.0.1:8001/health
```

Start the Chittu API again only with the existing environment file:

```bash
sudo systemctl enable --now chittu-api
curl -sS http://127.0.0.1:8080/health
```

Do not print `api.env`.

## 5. What was not done

- DNS was not changed.
- A public certificate was not issued.
- Security-group rules were not read or written through AWS.
- Port 443 was not part of the final verified listener set. Caddy on `:80` logged that automatic HTTPS would not be applied.
- No reboot test.
- The story model was not confirmed against the Hugging Face revision pin.
- `pnpm verify` and the container image build were not run.
- The production Terraform in `infra/envs/dev` remains unapplied, as `infra/README.md` states.

## 6. Failure and recovery

| Symptom | What was observed | Recovery that worked |
|---|---|---|
| `nanochat.gpt` missing | Story unit crash loop | Set `PYTHONPATH` to `/home/ubuntu/nanochat:/home/ubuntu/chittu-story-v0-26m`, `systemctl daemon-reload`, `reset-failed`, restart |
| Caddy apt key unreadable | `NO_PUBKEY`, keyring mode 600 | `chmod 644` on the keyring and the list file, then `apt-get install caddy` |
| Browser "Method Not Allowed" on `/chat/completions` | GET to a POST route | Use POST, or the form at `/` |
| AWS CLI TLS error | Avast scanning certificate | Pause HTTPS scanning, or use another machine. Do not disable certificate verification. |
| Public ports all time out | 2026-10-27 from the operator PC | Confirm in the AWS console whether the instance is running, whether `3.104.224.113` is still its address, and whether the security group still allows the needed port. Do not guess that the process crashed. |
