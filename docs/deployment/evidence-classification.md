# Second-pass evidence classification

| Field | Value |
|---|---|
| Document version | 0.2 |
| Prepared | 2026-10-27, second pass |
| Application revision | Workspace `0.1.0`. Deployed commit still pending. |
| Model revision | Still pending on disk. Harness pin unchanged and still unchecked. |
| Environment | EC2 `i-0f99f1c94ff3ff3e6`. SSH to `3.104.224.113:22` timed out in this pass. |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Draft. Not production. |

Classes:

1. **Verified** — read from the repository in this pass, or from a captured command result that this pass re-checked against the source.
2. **Historical** — captured on 26 October in command output. Not re-run on 27 October.
3. **Estimated** — arithmetic from stated prices and stated assumptions. Not a bill.
4. **Recommended** — a future action. Not something that was done.
5. **Pending** — required to finish the audit, and not available in this pass.

A historical pass in the checklist is not a pass for today.

## 1. What this pass could and could not reach

| Check | Result | Class |
|---|---|---|
| Re-read `local.ts`, `cells.ts`, `main.ts`, `router.ts`, `embed.ts`, `package.json`, `apps/web/package.json`, `vite.config.ts`, `.env.example`, `compose.yaml`, `infra/README.md`, `llm-kit/compare/compare/systems.py`, `card.py` | Read | Verified |
| Secret scan of `docs/deployment/*.md` for tokens, private keys, and database URLs with passwords | No values found. Names of variables and the basic-auth user `demo` are present. | Verified |
| `ssh -o BatchMode=yes -o ConnectTimeout=8 chittu-ec2 hostname` | `Connection timed out` to `3.104.224.113` port 22 | Verified as a failed reachability check. Instance state is Pending. |
| `aws sts get-caller-identity` | `SSL: CERTIFICATE_VERIFY_FAILED` against `https://sts.amazonaws.com/`. No identity was returned. | Verified as a failed call. AWS facts remain Pending. |
| Generation, health, security group, Cost Explorer | Not run | Pending |

## 2. Integration of the model with Chittu

| Claim | Class | Evidence |
|---|---|---|
| The local provider posts to `{CHITTU_LOCAL_BASE_URL}` with a trailing slash removed, then `/chat/completions`. It also posts to `{base}/embeddings`. It does not insert `/v1`. | Verified | `apps/api/src/providers/local.ts` lines 186 and 296. Default timeout 60 seconds. Default `max_tokens` 1000. Body includes `model`, `max_tokens`, and `messages` with a system message first. |
| `.env.example` and the unit test use a base that already ends in `/v1`. | Verified | `.env.example` comment `http://127.0.0.1:11434/v1`. `local.test.ts` sets `baseUrl` to `http://127.0.0.1:<port>/v1`, so the recorded request path is `/v1/chat/completions`. That is the test server's mount, not an extra prefix in `local.ts`. |
| The deployed base was `http://127.0.0.1:8001`, and the sandbox cell was `local:chittu-story-v0-26m`. | Historical | Boot log 2026-10-26 08:14:51 UTC: `.env.local supplied: CHITTU_LOCAL_BASE_URL, CHITTU_CELL_SANDBOX` and `self-hosted provider available at http://127.0.0.1:8001`. Runbook records the two values. The file was not re-read in this pass. |
| With that base, the sandbox call is `http://127.0.0.1:8001/chat/completions`. Adding `/v1` would miss the Flask route. | Verified for the path join. Historical for the Flask route existing. | Path join is the source above. Flask routes were observed on 26 October (`/health`, `/chat/completions`, later `/`). The wrapper is not in git and was not re-read. |
| A healthy model endpoint proves Chittu uses it. | Rejected. Do not use. | Health and integration were separate observations. |
| A consented turn and a direct model call returned the same opening, and the direct response named `chittu-story-v0-26m`. | Historical | One paired script after the model health check succeeded. Direct: HTTP 200, `generation_seconds` 1.197, 257 characters. Turn: draft 201, finalize 200, session 201, turn 200, 814 characters, trace `SANDBOX (Law 05) · FAST-PATH-ONLY · CORPUS UNAVAILABLE`. Both excerpts began "Once upon a time, there was a brave little sparrow. He lived in a small village near a big hill." Not re-run. |
| The boot line `routing overrides IN EFFECT` / `sandbox -> local/chittu-story-v0-26m` proves the weights were loaded. | Rejected. The line is historical and earlier than a successful load. | Journal 08:14:51 UTC printed the line while `chittu-story.service` was still exiting with `ModuleNotFoundError: No module named 'nanochat.gpt'`. "Chittu story model loaded." was logged at 08:17:34 UTC. |
| Current source would accept `CHITTU_CELL_SANDBOX=local:chittu-story-v0-26m`. | Rejected. | `MODEL_CATALOGUE.local` is `chittu-baseline`, `chittu-baseline-8b`, `mlx-community/Qwen3-4B-Instruct-2507-4bit`, `mxbai-embed-large`. `validate()` returns a problem for any other model. `describeCells()` lists only accepted cells. This workspace cannot print that model under `IN EFFECT`. |
| The process on the server did print that line, and the captured tail did not contain `routing config REJECTED`. | Historical | Journal excerpt cited above. |
| Server `cells.ts` or `dist/` matches the workspace. | Pending | `cells.ts` was not hashed on 26 October. SSH failed in this pass. The log and the source disagree, so a match is not assumed. |
| Classifier, homework, curriculum, and vision default to Anthropic. Embedding defaults to local `mxbai-embed-large`. | Verified | `DEFAULT_CELLS` in `router.ts`. |
| The boot line "the real L2 classifier runs on every turn" is printed whenever any adapter exists, including a local-only process. | Verified | `main.ts` prints it unconditionally after the adapter map is built. The 26 October log printed it next to `providers configured: local` and `classifier -> anthropic` unreachable. |
| `FAST-PATH-ONLY` means the classifier threw or returned no usable verdict. The turn still continues. | Verified | `packages/pipeline/src/index.ts` catch sets `FAST-PATH-ONLY` / `classifier unavailable`. |
| Embeddings to the story wrapper returned 404, and the turn said `CORPUS UNAVAILABLE`. The boot banner had said the corpus was ON. | Historical for the 404 and the turn. Verified that ON and UNAVAILABLE are different statements. | Banner means the embedding cell is wired. The turn is the call result. `embed.ts` documents that the old direct `/v1/embeddings` fetch was removed. The adapter now calls `{base}/embeddings`. |
| Pointing the classifier cell at the story model would satisfy classification. | Rejected. Recommended not to do. | The wrapper is a chat completion API. It has no classifier contract and no embeddings. |
| `card.py` says `chittu-story-v0-26m` has never served a child and clears none of the promotion gates. | Verified | `llm-kit/compare/compare/card.py`. |
| Harness pin `4f11284f8ebc19348ce2885bfea66eb13c8717cc` is the revision that was loaded. | Pending | The pin is in `systems.py`. It was not compared with `~/chittu-story-v0-26m`. |

## 3. Deployment facts

| Claim | Class | Evidence |
|---|---|---|
| Instance `i-0f99f1c94ff3ff3e6`, `m7i-flex.large`, `ap-southeast-2a`, Ubuntu, 2 vCPU, 7.6 GiB, 28G filesystem with 13G used, address `3.104.224.113` when inspected. | Historical | IMDS and `df` on 26 October. Not re-read. |
| This is not the Mumbai demo. That demo is `ap-south-1`, `13.205.39.18`, name `chittu.tulifo.ai`. DNS was not changed. | Historical for the DNS observation. Verified that `infra/README.md` says the Fargate production stack has never been applied, and that `envs/demo` is a separate lane. | |
| Node 22.23.4 and pnpm 11.9.0 were the binaries used on the box. Root `packageManager` is `pnpm@11.9.0`. Web dependencies are Preact, not React. API is Fastify. | Historical for the box versions. Verified for the manifests. | |
| `pnpm build` exit 0, Vite bundle 74.51 kB / 26.67 kB gzip, copied to `/srv/chittu-web`. | Historical | Build log 2026-10-26 06:48 UTC. |
| Postgres published on `127.0.0.1:55433` after a server edit. Nine migrations, 35 tables, already applied. | Historical | `docker inspect` and migrate output. |
| Workspace `compose.yaml` still publishes `'55433:5432'` on all host interfaces. | Verified | `compose.yaml` line 94. A future copy can reopen the port. |
| `chittu-api.service` runs `node dist/main.js` with `NODE_ENV=development`. | Historical | Unit and boot log. Production refusal without KMS is in `main.ts` and is Verified. |
| Story unit `PYTHONPATH` must include both `nanochat` and the weight directory. | Historical | Crash loop, then health JSON after the correction. |
| Final public behavior was Caddy on port 80 proxying to Flask with no basic auth. `Server: Werkzeug`, `Via: 1.1 Caddy`. | Historical | HTTP response 2026-10-26. Exact Caddyfile bytes were not re-read, because an earlier file held a password hash. |
| Public `POST /chat/completions` returned `generation_seconds` 0.717, 40 completion tokens, 12 prompt tokens. | Historical | Curl body. Not re-run. |
| Browser form at `/` was added on the server and is not in git. | Historical | `GET /` returned HTML. Operator screenshot. This pass did not re-read the Python file. |
| Temperature 0.6, top-k 50, seed 42, and `max_tokens` clamped to 1–200 are fixed in the wrapper. The form sends 80. | Historical | Read from the server file on 26 October. Not in the repository. Pending re-read. |
| Ports 5173, 8080, and 8001 were not open from the internet when tested. | Historical | TCP checks. Not re-tested in this pass except that SSH itself timed out. |
| Security group `launch-wizard-2` rules. | Pending | Name was seen. Rules were never returned. |
| `chittu-api` was stopped after the model-only change. | Pending | The stop command was offered. `systemctl` was not read back. |
| Reboot persistence. | Pending | Not tested. |
| Whether `3.104.224.113` is still the address, and whether the instance is running. | Pending | SSH timeout does not distinguish stop, address change, and firewall. |

## 4. Cost and latency

| Claim | Class | Evidence |
|---|---|---|
| `m7i-flex.large` at 0.1197 USD/hour in `ap-southeast-2`, public IPv4 at 0.005 USD/hour, gp3 at 0.096 USD/GB-month, 95.22 INR per USD. | Estimated | Third-party price pages and an exchange quote on 27 October. Not the AWS Price List API. Not re-fetched in this pass. |
| 176-hour total 24.83 USD / 2,364 INR. Full month 93.91 USD / 8,942 INR. Elastic IP left allocated: 27.60 USD. Two instances: 187.82 USD. | Estimated | Arithmetic on the rates above. Disk assumed 30 GB gp3. Egress, tax, credits, snapshots, NAT, and a load balancer are excluded, not priced at zero as a finding that they are absent. |
| These figures are the AWS bill. | Rejected | Cost Explorer was not read. |
| Two warm samples: 1.197 s for a 60-token cap on loopback, 0.717 s for a 40-token cap through the public proxy. | Historical | Not a percentile. The benchmark script in `performance-and-latency.md` was not run. |
| The whole consent-plus-turn script returned in about 21 seconds. | Historical | Wall clock of the script, including consent. Not model latency. |
| CPU and memory during generation. | Pending | Idle memory before the successful model start was 522 MiB used. The 297.8 MiB figure is the failed import, not the loaded model. |

## 5. Corrections made in this pass

| Document | Correction |
|---|---|
| `deployment-runbook.md` | Migration source is `apps/api/src/migrate.ts`, not `migrate.js`. The catalogue paragraph now says current source cannot log the override as in effect, and that the log line preceded a successful model load. |
| `architecture.md` | Path join and catalogue disagreement recorded from the re-read. Corpus "ON" at boot is distinguished from `CORPUS UNAVAILABLE` on the turn. |
| `security-and-production-readiness.md` | Catalogue row changed from "unresolved mismatch" to a confirmed disagreement between the running log and current source, with the server file still unread. |
| `executive-summary.md` and `deployment-validation-checklist.md` | Second pass did not re-execute tests. Historical passes are labeled as such. |
| `product-owner-submission.md` | Version 0.2. Integration, URL, catalogue disagreement, and the ordered gap list. |

No command output, latency, or cost was invented to fill a gap. No application behavior was changed.

## 6. Read-only commands still required

Run these only after SSH works and after AWS calls succeed without disabling certificate checks. Do not open ports 5173, 8080, or 8001. Do not print `api.env`.

On the instance:

```bash
sha256sum apps/api/src/providers/cells.ts apps/api/dist/providers/cells.js
python3 - << 'PY'
import hashlib, pathlib
p = pathlib.Path("/home/ubuntu/chittu-story-v0-26m")
# Record revision markers only. Do not print tokens.
for name in (".git/HEAD", "README.md"):
    f = p / name
    print(name, f.exists())
PY
# If the weight directory is a Hugging Face snapshot, record the commit file name only:
find /home/ubuntu/chittu-story-v0-26m /home/ubuntu/.cache/huggingface -name 'refs' -o -name 'snapshots' -maxdepth 4 -type d
git -C /home/ubuntu/nanochat rev-parse HEAD
systemctl is-active chittu-story chittu-api caddy
ss -lnt | awk 'NR==1 || /:22|:80|:443|:5173|:8080|:8001|:55433/'
curl -sS --max-time 5 http://127.0.0.1:8001/health
curl -sS --max-time 5 http://127.0.0.1:8080/health
# Confirm the Caddyfile proxies to 8001 and does not contain a secret before copying it off the box.
sudo grep -n 'reverse_proxy\|basic_auth\|:80' /etc/caddy/Caddyfile
```

From a machine whose AWS client can validate Amazon's certificate:

```bash
aws sts get-caller-identity
aws ec2 describe-instances --region ap-southeast-2 --instance-ids i-0f99f1c94ff3ff3e6 \
  --query 'Reservations[].Instances[].{State:State.Name,Type:InstanceType,Az:Placement.AvailabilityZone,Ip:PublicIpAddress,Sg:SecurityGroups}'
aws ec2 describe-security-groups --region ap-southeast-2 --group-names launch-wizard-2
aws ec2 describe-volumes --region ap-southeast-2 \
  --filters Name=attachment.instance-id,Values=i-0f99f1c94ff3ff3e6 \
  --query 'Volumes[].{Type:VolumeType,Size:Size,Iops:Iops}'
aws ec2 describe-addresses --region ap-southeast-2
aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-28 \
  --granularity MONTHLY --metrics UnblendedCost
```

Replace the 0.1197 USD/hour figure only after the Price List API, or the bill, returns a number. Until then section 4 of `aws-cost-estimate.md` stays an estimate.
