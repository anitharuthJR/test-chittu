# Chittu proof of concept

## Submission to the product owner

| Field | Value |
|---|---|
| Document | Product-owner submission |
| Version | 0.2 draft, after a second-pass evidence audit |
| Prepared | 27 October 2026 |
| Application | Chittu `0.1.0`. The copy on the server has no git history, so the exact commit is pending. |
| Model | `Tulifo/chittu-story-v0-26m`. The revision actually loaded on the server was not recorded. |
| Environment | Amazon EC2 `i-0f99f1c94ff3ff3e6`, type `m7i-flex.large`, Sydney (`ap-southeast-2a`). Last seen at `http://3.104.224.113`. |
| Prepared by | Deployment audit |
| Reviewer | Pending |
| Approval | Not approved for demonstration to children, and not approved for production. |

This document consolidates the 26–27 October 2026 deployment audit. It is written for a product decision. The commands, file diffs, and recovery steps remain in the technical pack listed at the end. Nothing here is an invoice, a performance guarantee, or a statement that the server is up today.

---

## 1. Decision requested

Please treat this proof of concept as a completed technical demonstration, not as a product that can be shared.

On 26 October the story model answered, and a consented turn inside Chittu reached that same model. On 27 October the server no longer accepted connections from the audit computer. The last public page was an open story form, with no login and no encrypted connection.

**Recommended product position:** do not send the public address to parents, children, or external reviewers. Do not point `chittu.tulifo.ai` at this server until the decisions in section 8 are made.

---

## 2. Status at a glance

| Question | Answer | Basis |
|---|---|---|
| Can a child use this today? | No. | Not approved, and the address timed out on 27 October. |
| Did the organisation’s story model answer? | Yes, on 26 October. | Direct call and a consented Chittu turn returned the same opening line. |
| Is the public page the Chittu application? | No. | The last verified page was a small story form in front of the model. |
| Is this the Mumbai site named in the demo runbook? | No. | That site is a different server, `13.205.39.18`, still named `chittu.tulifo.ai`. |
| Is the connection encrypted? | No. | Port 443 was not serving this instance. Traffic was plain HTTP. |
| Was anyone required to sign in? | Not on the final public page. | An earlier arrangement used a password. It was removed when the model was placed on port 80. |
| What does a full month of this one server cost? | About **94 USD**, about **8,900 INR**. | Calculated estimate. Not a bill. See section 6. |
| Is it fast enough for the product? | Not established. | Two short warm replies finished in under 2 seconds. That is not a capacity test. |
| Is it production-ready? | No. | Safety pipeline was only partly active, and the planned production platform has never been deployed. |

---

## 3. What this environment is

Chittu in the repository is a safety-first conversational application for children. The web client is Preact (not React). The API is a Node 22 service. The story answer observed on 26 October came from the organisation-owned Hugging Face model `Tulifo/chittu-story-v0-26m`, running on the server’s CPU behind a small Python wrapper. The classifier and the other teaching cells were still pointed at Anthropic and had no credential, so they did not run.

The server that was actually used is:

- Amazon Web Services, region **Sydney**, not Mumbai.
- One virtual machine, 2 CPUs, about 7.6 GB of memory, Ubuntu, about 28 GB of disk with 13 GB used when inspected.
- Application files copied onto the machine. Git clone from GitHub had failed earlier, so this copy has no commit id.
- Node API on port 8080, story model on port 8001, and the database on port 55433. All three were bound to the machine itself, not published as their own public ports.
- A web front door (Caddy) on port 80.

The Mumbai demo in the existing runbook — `chittu.tulifo.ai`, address `13.205.39.18` — was left unchanged. On 26 October that name still answered from the other server and still asked for a password. DNS was not modified.

The production design in the repository (containers, a managed database, a key service, and a separate migration task) has never been applied. This EC2 machine does not become that design by being left switched on.

---

## 4. What was demonstrated on 26 October

These results were observed. They describe that day only.

1. The Chittu API health check succeeded on the server.
2. The model health check returned `chittu-story-v0-26m` and status ok.
3. The web application was built and, for part of the day, served on the public address behind a password.
4. A parent-style consent was completed in **development** mode, a session was opened, and a story request was sent through Chittu. The story began: “Once upon a time, there was a brave little sparrow. He lived in a small village near a big hill.” A direct call to the model with the same prompt began with the same words. That is the evidence that Chittu reached this model, not merely that the model was healthy.
5. The turn was labeled `SANDBOX (Law 05) · FAST-PATH-ONLY · CORPUS UNAVAILABLE`. In product terms: the story step ran, the classifier did not return a verdict, and story grounding from the corpus did not run.
6. Later the same day, at the operator’s request, the public address was switched so that only the model was exposed. `http://3.104.224.113/` showed a “Chittu story model” form. A story could be requested from the browser. Postman or curl can use `POST http://3.104.224.113/chat/completions`. Opening that address in the browser without a form correctly says the method is not allowed, because a browser visit is a GET and the model expects a POST.

The browser form was added on the server so a story could be requested without developer tools. It is not the Chittu product interface.

---

## 5. What a product review should not treat as passed

| Product expectation | What the proof of concept showed |
|---|---|
| A child reaches Chittu, not a raw model. | The last public page skipped Chittu and called the model directly. |
| Consent is a real parent decision. | The test used the development consent stub. That path is refused when the API is in production mode. |
| The classifier reviews the turn. | No Anthropic credential was configured. The trace said the classifier did not produce a verdict. A boot message still claimed the classifier runs; the trace is the record that matters. |
| Answers can be grounded in the corpus. | The model wrapper has no embeddings route. Those calls returned “not found”, and the product correctly said the corpus was unavailable. |
| The approved model id is on the allow-list. | This repository’s catalogue does not list `chittu-story-v0-26m` and would reject that setting. The process on the server logged the setting as in effect. The server file was not compared. The two do not match. |
| The model is cleared to serve a child. | The repository’s own comparison notes say this model has not cleared the promotion gates and has not served a child. |
| The site is `https://chittu.tulifo.ai`. | Not this server. The name was not moved. |
| The service survives a reboot and is up today. | Reboot was not tested. On 27 October ports 22, 80, 443, 8080, and 8001 all timed out. |

The classifier must not be pointed at the story model to remove the warning. The story wrapper does not implement classification or embeddings. Doing so would remove those controls rather than satisfy them.

---

## 6. Cost

These figures are **calculated estimates** from published hourly rates. Amazon billing, credits, tax, discounts, and data transfer were not read. The disk type was not confirmed; the estimate assumes 30 GB of gp3 storage. The public address was not confirmed to be a reserved Elastic IP. If it is an ordinary address, stopping the machine releases it and the address can change.

Prices used: `m7i-flex.large` in Sydney at 0.1197 USD per hour (third-party price index, 27 October 2026, not an AWS Price List API quote); public IPv4 at 0.005 USD per hour while in use; gp3 at 0.096 USD per GB-month. Exchange rate **95.22 INR per USD** on 27 October 2026. A month is counted as 730 hours. A limited proof-of-concept month is 8 hours on 22 weekdays (176 hours).

| Scenario | What is assumed | USD / month | INR / month |
|---|---|---:|---:|
| Limited proof of concept | This machine on for 176 hours. Address charged only while it runs. Disk kept. | 24.83 | 2,364 |
| Same, if a reserved address is kept all month | Add the idle address charge. | 27.60 | 2,628 |
| Left running all month | One machine, one address, disk. This is also the cost of calling the same machine “production” without adding anything else. | 93.91 | 8,942 |
| Two machines, both always on | Illustration of doubling only. No load balancer, no backups, no GPU. | 187.82 | 17,884 |

A second machine, a load balancer, backups, a GPU, or a managed database would cost more. Those prices were not collected, so they are not stated as numbers. Cost per story was not calculated: two observed calls are not a month of traffic.

This deployment is not free. Credits were not checked. Leaving the machine running over a weekend is a real charge even when nobody is testing.

---

## 7. Speed

Do not quote a single successful story as the product’s latency.

| Sample | When | What was measured | Result |
|---|---|---|---|
| Model already loaded, on the server | 26 October | 60-token cap, warm | 1.197 seconds of generation |
| Same prompt through the public address | 26 October | 40-token cap, warm | 0.717 seconds of generation |
| Full Chittu turn, including consent | 26 October | Wall clock of the whole script | About 21 seconds. This is not model latency. |
| Model process start | 26 October | One start after a crash | Listening about 4 seconds after the service start. One observation, not a cold-start study. |

The prompt in both generation samples was “Tell me a story about a brave little sparrow.” Settings in the wrapper are fixed at temperature 0.6, top-k 50, and seed 42. Output is capped at 200 tokens by the wrapper. The browser form asks for 80, which is why stories stop early. There is no streaming, so time-to-first-token does not exist on this API.

No average, median, or percentile is reported. Twenty warm samples were not collected. CPU and memory during generation were not sampled. The model runs as a single Python process: a second story waits while the first is generating. Whether a GPU is worth buying is not answered by this data.

An earlier note of about 2.7 seconds was not reproduced in this audit and is not included as a measurement.

---

## 8. Decisions for the product owner

1. **Who may call the model?** On 26 October anyone who could open the address could generate text and consume the server. Is any public or partner access allowed before the model clears the product gates?
2. **What should the address show?** Three honest options: the Chittu site behind a password, the model form, or a closed port until there is HTTPS and an allow-list. The current last-known choice was the model form, and it is not recommended for anyone outside the team.
3. **Which server is the product environment?** Continue on this Sydney machine, or return attention to the existing Mumbai demo that already owns `chittu.tulifo.ai`? Those are different machines. This audit did not move the name.
4. **May a development-mode demo be shown to a parent or a child?** Development mode is what made the test consent possible. It is not the production consent decision. The encryption key for stored data lives only on this server. If that file is lost, stored records cannot be read. A backup location has not been agreed.
5. **Which model revision is approved for the next demonstration?** The files were already on the server. Their Hugging Face revision was not written down. The comparison harness names one revision; that pin was not checked against the files.

Engineering should not pick these. They change who can see model output, which environment is official, and whether a demo is allowed to look like the real consent flow.

---

## 9. Risks that matter to the product

**High**

- The story model was on the public internet with no authentication and without Chittu’s consent, classifier, or output path. Business impact: an unreviewed model can be seen as an organisation endpoint.
- The API was running in development mode. A successful test turn is not evidence of production consent.
- Classification and corpus grounding did not actually run. A reviewer who only sees a fluent story will over-read the demo.

**Medium**

- Prompts and stories were sent in clear text.
- The firewall rules were never read back from Amazon. The group name is `launch-wizard-2`. Port 80 was closed at first contact and open later. This audit did not open it; the account credentials available on the workstation were rejected, and certificate inspection on this PC is intercepted by Avast.
- The database port was tightened to the machine itself. The matching file in the source tree was not updated. The next file copy can publish the database again.
- There is no tested restore, no reboot test, and no alarm. Logs stay on the machine.
- The model is served by Flask’s development server, which is not meant for concurrent users.

**Low, for this stage**

- No cloud monitoring agent was installed.
- The exact software patch level beyond the operating-system name was not assessed.
- A password file from the earlier gated site is still on disk. It was not copied into this report.

---

## 10. Recommended sequence

Immediate, before any further demo:

1. Confirm in the Amazon console whether the Sydney machine is stopped, whether `3.104.224.113` is still its address, and which inbound rules exist. Do not open ports 5173, 8080, or 8001.
2. Until that is known, do not share the address.
3. Record the model revision and decide whether this model may be shown at all.
4. Put the public page back behind an access control, or turn the public page off. Do not leave the open story form as the face of the product.

Before calling the same machine a standing development environment:

5. Run it only during staffed hours if the limited-cost scenario is the one that was funded.
6. Keep the Chittu API in development mode only for staff tests, and say so on any invitation.
7. Version-control the server’s front-door config, service files, and model wrapper. Today those exist only on the machine.
8. Take one controlled set of at least twenty warm stories before anyone quotes a response time.

Not justified by the evidence yet:

- A GPU, a second server, or a load balancer.
- Moving `chittu.tulifo.ai`.
- Treating this machine as the production platform. That platform is specified and has not been deployed.

---

## 11. What remains unknown

| Item | Why it is still open |
|---|---|
| Is the server stopped, has the address changed, or did the firewall close? | All tested ports timed out on 27 October. Amazon could not be queried successfully. |
| Security-group rules | The describe call failed. |
| Exact model revision and code checkout | Not recorded before access was lost. |
| Whether the Chittu API service was stopped after the model-only switch | The stop command was provided. It was not read back. |
| Whether the server’s model allow-list matches the repository | Behavior says no: the server logged an override this repository would reject. The file itself was not compared. |
| Reboot behaviour | Not tested. |
| Percentile latency, concurrency, CPU, and memory under load | Not measured. |
| Actual Amazon invoice, credits, tax, disk type, and data transfer | Not read. |
| Elastic IP versus a temporary public address | Not confirmed. A restart can change a temporary address. |

---

## 12. Second-pass evidence audit

On 27 October the repository was read again. SSH to `3.104.224.113` port 22 timed out. `aws sts get-caller-identity` failed because the local AWS client could not verify Amazon’s certificate. No security group, disk, instance state, or bill was read. No test in the checklist was run again. A pass recorded on 26 October is a historical result, not proof the service is up.

**The model was integrated with Chittu, on the evidence of one paired test, not because the model process was healthy.** After the story service was healthy, one script on the server called the model directly and then sent the same prompt through consent, session, and `/v1/session/:id/turn`. Both replies began “Once upon a time, there was a brave little sparrow. He lived in a small village near a big hill.” The direct call named `chittu-story-v0-26m`. The Chittu turn was labeled sandbox, fast-path-only, corpus unavailable. That test was not repeated in this pass.

**The URL matches the code that is in the repository today.** The API posts to `{CHITTU_LOCAL_BASE_URL}/chat/completions` and does not add `/v1`. The recorded base was `http://127.0.0.1:8001`, so the call is `http://127.0.0.1:8001/chat/completions`, which is the model’s route. The example file and the unit test use a base that already ends in `/v1` because other local servers mount their routes there. Adding `/v1` on this server would miss the model.

**The repository and the server disagree about whether that model is allowed.** Current source rejects `chittu-story-v0-26m` and would not log it as an active route. The 26 October log did log it as active, and it did so while the model process was still crash-looping. The route line is not proof the weights were loaded. The server’s copy of the allow-list was never diffed.

Claim-by-claim classes, and the read-only commands still required, are in `docs/deployment/evidence-classification.md`. No secret was found in the documentation pack. Environment-variable names are recorded. Values are not.

## 13. Production-readiness gaps, in order

1. **The public model had no login.** On 26 October anyone who could open the address could generate text, and that path skipped consent and the safety pipeline. Whether it is still open is unknown, because the address timed out on 27 October. Do not share it.
2. **The demonstration is not the safety product.** The classifier returned no verdict, corpus grounding failed, clearance was off, and consent was the development stub.
3. **This model is not cleared to serve a child.** The repository’s comparison notes say so. The weight revision on disk was never recorded.
4. **The server accepted a model this repository would reject.** The next copy or rebuild can change what answers, or refuse to boot, depending on which copy is used. Diff the server allow-list before another build.
5. **The machine cannot be audited right now.** SSH timed out. Amazon credentials on this PC did not complete a read-only call. Firewall rules, address type, disk type, and the bill are unread. Reboot was never tested.
6. **There is no encrypted public site.** This address has no certificate. `chittu.tulifo.ai` was not moved and still belongs to the other server.
7. **The public server is Flask’s development server**, one request at a time. Two short warm samples are not a capacity result.
8. **Secrets and the database binding are only safe if the server copy is the one that is kept.** The encryption key lives in one file on the instance. The database port was bound to loopback on the server, but the file in the repository still publishes it more widely. The next file copy can undo that.

Items 1–4 block any external or child-facing use. Items 5–6 block calling the environment operated. Items 7–8 block treating the current box as a standing service. A GPU, a second machine, and a production platform deploy are not justified by the measurements collected.

## 14. Technical pack

The evidence behind this submission is in `docs/deployment/`:

| File | Contents |
|---|---|
| `deployment-runbook.md` | How the server was prepared and how to operate it |
| `architecture.md` | Request paths and repository inventory |
| `file-change-register.md` | What changed on the server, and what was not confirmed |
| `performance-and-latency.md` | The two samples, and a benchmark that has not been run |
| `aws-cost-estimate.md` | Arithmetic behind section 6 |
| `security-and-production-readiness.md` | Full risk notes |
| `troubleshooting-and-rollback.md` | Recovery steps |
| `deployment-validation-checklist.md` | Each check marked pass, fail, or not run |
| `measurements/latency-observations.csv` | The two generation rows |
| `Chittu_Deployment_Assessment.docx` | Technical consolidation of the same audit |
| `executive-summary.md` | One-page engineering summary |
| `evidence-classification.md` | Second-pass class for each material claim, and the read-only commands still required |

No passwords, tokens, or private keys are included in this submission or in that pack.
