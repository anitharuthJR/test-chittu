# Security and production readiness

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | `0.1.0`; deployed SHA pending |
| Model revision | Disk revision pending. Harness pin is not proof of the files on disk. |
| Environment | EC2 `i-0f99f1c94ff3ff3e6`, last verified public routing 2026-10-26 |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Not production-ready |

No exploit attempts were made. Security-group rules were not changed. The rule list itself was never returned by AWS.

## 1. Verified exposure

| Check | Result | When |
|---|---|---|
| Story process bind | `127.0.0.1:8001` only | 2026-10-26 `ss` |
| API bind | `127.0.0.1:8080` only | 2026-10-26 `ss` |
| Postgres bind | `127.0.0.1:55433` after the compose edit | 2026-10-26 `docker inspect` |
| Ports 5173, 8080, 8001 from the internet | Closed at every probe, including when port 80 was open | Workstation TCP checks |
| Port 80 | Closed on first contact. Later open. Served Caddy. Final verified backend was Flask with no authentication. | HTTP responses |
| Port 443 | Closed on first contact. Not verified open afterward. No certificate was issued for this instance. | TCP check and Caddy log that automatic HTTPS was not applied |
| Port 22 | Open on 2026-10-26. Source CIDR of the security group was not read. `ss` showed sshd on `0.0.0.0:22`, which is normal; the security group is the external control. | TCP and `ss` |
| 2026-10-27 | Ports 22, 80, 443, 8080, and 8001 timed out from the same workstation. Cause not identified. | TCP and curl |

`chittu.tulifo.ai` was not pointed at this instance. On 2026-10-26 that name still resolved to `13.205.39.18` and returned HTTPS 401 from a different Caddy. That host was not part of this change.

## 2. Findings

### High

**The story model was reachable on the internet without authentication.** `POST http://3.104.224.113/chat/completions` succeeded with no credential. The browser form at `/` calls the same route. This path does not run Chittu's consent, L1 lexicon, classifier, or output filter. The repository's own comparison text says `chittu-story-v0-26m` has not cleared the gates required before it serves a child (`llm-kit/compare/compare/card.py`). Impact: anyone who can open the IP can generate text from the model and can consume the CPU. The business impact is an unreviewed model presented on an organization address.

**The Chittu API, when it was running, was in `NODE_ENV=development`.** That is what allows `dev_stub` consent and a local master key. Provider clearance is not enforced. The boot log said so. Impact: a consented turn is not evidence of a production consent decision. `dev_stub` was used for the integration test on purpose and is not a production control.

**Classifier and several other cells named Anthropic, and no Anthropic adapter was configured.** Turns were labeled `FAST-PATH-ONLY`. In this codebase that means the classifier did not produce a verdict and the remaining guards continued. Impact: L2 was not actually classifying, while a boot line still said "the real L2 classifier runs on every turn." That boot line is unconditional in `main.ts` once any real adapter exists. The trace is the accurate record. The story model must not be substituted for the classifier to silence the warning. It does not emit the classifier contract.

### Medium

**No TLS on the proof-of-concept address.** Prompts and stories traveled in clear text. Basic auth, when it was in use earlier that day, would also have traveled in clear text.

**Secrets live in files on the instance, not in a secret manager.** `api.env` was mode 600. The application tree was mode 777 at inspection (`drwxrwxrwx` on `/home/ubuntu/chittu`). `.env.local` was mode 664 and did not contain the master key. Impact: a local user who can read the tree cannot read `api.env`, but the tree mode is looser than the files inside it. The master key was not copied into this report. Losing `api.env` makes existing encrypted rows unreadable. That is the designed crypto-shred property, and it is also the recovery gap.

**No instance profile.** Operators cannot audit or patch through least-privilege instance credentials. The access keys present on the workstation were rejected by AWS. They should be treated as unusable and rotated if they were ever valid. Their values were not printed.

**Security group unknown.** The group name is `launch-wizard-2`. Whether SSH is limited to one address is unknown. Port 80 was publicly open during the model test. A launch-wizard group is often wider than the repository's demo group, which allows 22 only from one `/32` and 80/443 from the internet (`infra/envs/demo/main.tf`). That Terraform was not what created this instance.

**Flask's built-in server is the public application server.** Werkzeug logged the production warning itself. There is no process model for concurrent requests.

**Embeddings return 404.** Corpus state was `UNAVAILABLE` on a real turn. That is honest behavior, and it means layer 6 grounding is not functioning on this box.

**Catalogue mismatch is a confirmed disagreement, and the server file is still unread.** Re-read on 27 October: `cells.ts` `validate()` rejects `chittu-story-v0-26m`, and `describeCells()` would not log it as in effect. The 26 October journal did log `sandbox -> local/chittu-story-v0-26m (env)` and did not log `routing config REJECTED` in the captured tail. The deployed build and this repository do not enforce the same allow-list. `cells.ts` and `dist/` on the server were not hashed. SSH timed out again on 27 October, so this was not closed.

### Low

**Caddy basic-auth password remains on disk** after the proxy stopped using it. It is mode 600. It should be removed or retained only if basic auth is restored. It is not in this report.

**No CloudWatch agent, alarm, or log shipping was observed.** Logs are journald on the instance.

**Patch level** was not assessed beyond the OS string Ubuntu 26.04.1 and the package versions installed that day.

**Supply chain:** pnpm 11.9.0 and the lockfile were present. `pnpm install` was not re-run in this session. The Caddy apt repository was added. The model weights were already on disk. Their origin hash was not checked.

## 3. Decisions still required

1. Is this instance allowed to expose the story model at all, and if so, who may call it?
2. Should port 80 return to the Chittu site with basic auth, or stay on the model, or be closed until TLS and an allow-list exist?
3. Is `3.104.224.113` meant to remain the address, or was the Mumbai demo box the one that should face users?
4. Who accepts `NODE_ENV=development` for any period, and where is the dev master key backed up outside the instance?
5. Which Hugging Face revision is approved, and where is the download recorded?

## 4. Not production

The repository's production shape is Fargate, RDS, KMS, and a separate migration task. `infra/README.md` says that shape has never been applied. This EC2 proof of concept does not become that shape by leaving the instance running. The blockers above are sufficient to keep production traffic off this address.
