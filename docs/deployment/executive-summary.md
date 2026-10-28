# Executive summary

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | `package.json` `0.1.0`. Deployed git SHA pending. The instance tree has no `.git` directory. |
| Model revision | Pending on disk. Comparison harness pin `4f11284f8ebc19348ce2885bfea66eb13c8717cc` was not checked against `~/chittu-story-v0-26m`. |
| Environment | EC2 `i-0f99f1c94ff3ff3e6`, `m7i-flex.large`, `ap-southeast-2a`, last seen at `3.104.224.113` |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Draft. Not approved for production. |

## Verified

The proof of concept is not the Mumbai demo in `docs/runbooks/demo-deploy.md`. That demo is `ap-south-1`, Elastic IP `13.205.39.18`, name `chittu.tulifo.ai`. This box is an x86 `m7i-flex.large` in Sydney, Ubuntu 26.04.1, 2 vCPU, 7.6 GiB RAM, 28G root filesystem with 13G used at inspection.

The web client is Preact and Vite. The API is Fastify on Node 22. The story model is a Flask wrapper around `Tulifo/chittu-story-v0-26m` on CPU, bound to `127.0.0.1:8001`.

On 2026-10-26 a consented Chittu turn and a direct model call returned the same story opening. The turn trace was `SANDBOX (Law 05) · FAST-PATH-ONLY · CORPUS UNAVAILABLE`. The classifier cell points at Anthropic and no Anthropic key was configured. The story service has no embeddings route, and those calls logged HTTP 404.

Later the same day, port 80 forwarded to the model with no authentication. `POST http://3.104.224.113/chat/completions` returned a story in 0.717 reported generation seconds. A browser form was added at `/` because the address bar cannot POST.

## Second pass on 2026-10-27

The repository was re-read. SSH to `3.104.224.113` port 22 timed out again. `aws sts get-caller-identity` failed TLS certificate verification. No new instance, security-group, disk, or billing fact was collected. No generation test was repeated. The 26 October results stay historical.

Source re-read: `local.ts` calls `{CHITTU_LOCAL_BASE_URL}/chat/completions` with no extra `/v1`. The recorded base `http://127.0.0.1:8001` therefore targets the Flask route. Current `MODEL_CATALOGUE` does not list `chittu-story-v0-26m` and would reject that cell. The 26 October process logged the cell as in effect anyway. The server copy of `cells.ts` is still unread. The integration evidence remains the paired loopback test later that day, after the model health check succeeded: the direct call and the consented turn began with the same text. A healthy `/health` body is not that evidence.

## Not verified on 2026-10-27

The same workstation could not open port 22 in this pass. Earlier the same day, ports 22, 80, 443, 8080, and 8001 timed out. AWS describe calls did not succeed. Whether the instance is stopped, the address changed, or the security group closed is unresolved. Do not treat the 26 October endpoints as currently up.

## Cost and latency

Two warm generations were measured: 1.197 seconds for 60 tokens on the instance, and 0.717 seconds for 40 tokens through the public proxy. That is not a percentile study. No concurrency, CPU, or memory sample was taken during generation.

A full month of this instance, using a third-party listing of 0.1197 USD/hour in Sydney, plus 0.005 USD/hour for a public IPv4 address and an assumed 30 GB gp3 disk, is about 94 USD, about 8,900 INR at 95.22 INR per USD. That is an estimate, not a bill. The volume type was not read from AWS.

## Blockers

The model was on the public internet without authentication and without Chittu's safety pipeline. The API mode was development. There is no TLS on this address, no recorded model revision, no tested reboot, and no readable security group. The production Terraform in `infra/` has never been applied.

The pages that follow are the runbook, architecture, change register, measurements, cost, security review, recovery, and the validation checklist.
