# Deployment validation checklist

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | Deployed SHA pending |
| Model revision | Disk revision pending |
| Environment | EC2 `i-0f99f1c94ff3ff3e6` / `3.104.224.113` |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Draft |

Status values: **Pass** means the 26 October session recorded the result. **Fail** means the check was run and did not meet the expected result. **Not run** means no evidence from that session. A written command is not a pass.

Second pass on 27 October: SSH to port 22 timed out. No row below was re-executed. Existing Pass rows stay historical. They are not a statement that the service is up.

## 1. Reachability

| ID | Purpose | How | Expected | Actual | Status |
|---|---|---|---|---|---|
| R1 | Instance answers SSH | `ssh chittu-ec2 hostname` | Hostname | `app` on 2026-10-26. Timed out on 2026-10-27. | Pass on 2026-10-26. Fail on 2026-10-27. |
| R2 | Identity | IMDS instance-id, type, region | Stable ids | `i-0f99f1c94ff3ff3e6`, `m7i-flex.large`, `ap-southeast-2a` | Pass on 2026-10-26. Not run on 2026-10-27. |
| R3 | Public TCP 80 | TCP connect from the workstation | Depends on the intended edge | Closed, then open, on 2026-10-26. Timeout on 2026-10-27. | See dates. |
| R4 | 8080 and 8001 not public | TCP connect | Closed | Closed whenever tested, including 2026-10-27 | Pass |
| R5 | AWS API read of the security group | `aws ec2 describe-instances` | Group rules | TLS failure, then `AuthFailure` on a signed call | Fail |

## 2. Processes and ports on the instance

| ID | Purpose | How | Expected | Actual | Status |
|---|---|---|---|---|---|
| P1 | Story listen address | `ss -lnt` on the instance | `127.0.0.1:8001` | Observed 2026-10-26 | Pass. Not rechecked 2026-10-27. |
| P2 | API listen address | `ss` | `127.0.0.1:8080` when the unit is active | Observed while the unit was active | Pass for that window |
| P3 | Postgres not on all interfaces | `docker inspect` port bindings | `127.0.0.1:55433` | Observed after the compose edit | Pass |
| P4 | Caddy on 80 | `ss` and `systemctl is-active caddy` | Active, port 80 | Active on 2026-10-26 after install | Pass for that window |
| P5 | Still true after reboot | Reboot, then P1–P4 | Same listeners | | Not run |

## 3. Health

| ID | Purpose | How | Expected | Actual | Status |
|---|---|---|---|---|---|
| H1 | Model process | `curl -sS http://127.0.0.1:8001/health` | JSON `status` ok and model id | `{"model":"chittu-story-v0-26m","status":"ok"}` | Pass on 2026-10-26 |
| H2 | Chittu API | `curl -sS http://127.0.0.1:8080/health` | `{"status":"ok"}` | Observed while the API unit was active | Pass for that window |
| H3 | Public model health | `curl -sSI http://3.104.224.113/health` | 200 from the model, via Caddy | 200, `Server: Werkzeug`, `Via: 1.1 Caddy`, body as H1. Date header 2026-10-26 09:26:59 GMT | Pass. Fail on 2026-10-27 (timeout). |
| H4 | Web app | Browser or curl to the Vite port or the static root | Chittu UI | Static root was served only in the earlier basic-auth arrangement. Vite on 5173 was not running. | Not the current public path |

## 4. Generation

| ID | Purpose | How | Expected | Actual | Status |
|---|---|---|---|---|---|
| G1 | Model alone | POST `/chat/completions` on port 8001, user message, `max_tokens` 60 | HTTP 200, non-empty content | 200, `generation_seconds` 1.197, story text | Pass |
| G2 | Public POST | Same body to `http://3.104.224.113/chat/completions` | HTTP 200 | 200, `generation_seconds` 0.717, 40 completion tokens | Pass on 2026-10-26 |
| G3 | Browser GET of the POST URL | Open `/chat/completions` | 405 | "Method Not Allowed" | Pass, and this is the correct rejection |
| G4 | Browser form | GET `/`, press Ask | Story rendered | Operator screenshot showed a story. The audit did not click the button itself. The HTML route returned 200. | Partial. Page delivery pass. Button click is operator-reported by screenshot. |
| G5 | Postman | POST, raw JSON, `Content-Type: application/json` | Same as G2 | The curl equivalent passed. Postman itself was not used. | Not run in Postman |

Example body:

```json
{
  "messages": [
    { "role": "user", "content": "Tell me a story about a brave little sparrow." }
  ],
  "max_tokens": 40
}
```

## 5. End to end through Chittu

| ID | Purpose | How | Expected | Actual | Status |
|---|---|---|---|---|---|
| E1 | Consent is required | POST `/v1/consent/draft`, finalize, then `/v1/session`, then `/v1/session/:id/turn` on `127.0.0.1:8080` | 201, 200, 201, 200, without skipping finalize | Those status codes | Pass |
| E2 | The turn reached the story model | Compare turn text with a direct model call using the same prompt | Same model behavior, trace shows sandbox | Both began "Once upon a time, there was a brave little sparrow. He lived in a small village near a big hill." Trace `SANDBOX (Law 05) · FAST-PATH-ONLY · CORPUS UNAVAILABLE` | Pass |
| E3 | Classifier actually ran | Trace does not say `FAST-PATH-ONLY` | A real classifier verdict | Trace said `FAST-PATH-ONLY`. Anthropic was not configured. | Fail, and the failure is the expected degraded mode |
| E4 | Corpus retrieval | Trace shows grounded or miss, not unavailable | An embeddings 200 | Embeddings logged 404. Trace said `CORPUS UNAVAILABLE`. | Fail |
| E5 | Public Chittu `/v1` | Through `http://3.104.224.113/v1` while Caddy proxied to 8080 with basic auth | 200 on `/health` and a methods response | Observed 2026-10-26 before the proxy was pointed at Flask: frontend 200, `/health` ok, `/v1/consent/methods?country=IN` 200, after basic auth | Pass for that window only |
| E6 | Public Chittu path after the model-only change | `/v1` on port 80 | Would not be the Chittu API | Not requested after the Werkzeug health response | Not run |

E2 is the end-to-end evidence that a Chittu turn reached `chittu-story-v0-26m`. E3 and E4 are why that turn is not a production acceptance test.

## 6. Identity, logs, and restart

| ID | Purpose | How | Expected | Actual | Status |
|---|---|---|---|---|---|
| I1 | Weight revision | Compare on-disk Hugging Face revision with `4f11284f8ebc19348ce2885bfea66eb13c8717cc` | Match, or a recorded difference | Directory existed. Revision file was not read. | Not run |
| I2 | nanochat commit | `git -C /home/ubuntu/nanochat rev-parse HEAD` | Recorded, compared with `92d63d4e8bb4df75c3b71618f31ddde2378b2bcd` from `load.py` | | Not run |
| L1 | Story log shows the call | `journalctl -u chittu-story` | `POST /chat/completions` 200 | Several 200 lines on 2026-10-26, plus `GET /health` 200 and browser `GET /favicon.ico` 404 | Pass |
| B1 | Process restart | `systemctl restart chittu-story` then H1 | Health returns after load | Restart after the homepage edit returned health on try 3 | Pass |
| B2 | Instance reboot | Reboot from the console, then H1–H3 and address check | Services and address documented | | Not run |

## 7. Before calling the box production

All of the following are open. None are implied by a passing health check.

- Security group reviewed and recorded.
- TLS on the name that users actually use.
- Authentication in front of generation.
- `NODE_ENV` and key provider accepted for that environment, or the production KMS path used instead.
- Classifier cell points at a provider that is configured and cleared.
- Model revision recorded.
- Reboot tested.
- Cost read from the account, not from this estimate.
