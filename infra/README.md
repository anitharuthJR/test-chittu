# infra/ — Terraform for Chittu

Architecture §14 chose Terraform over CDK for one reason: G4 requires the DPIA to show that
data flows match production, and an auditor can read Terraform. That only holds if the files
here are the truth, so read this section before you read anything else.

## Status: THE PRODUCTION-PATH CONFIGURATION HAS NEVER BEEN APPLIED

No AWS account has been touched by the four modules or `envs/dev`. They have no state
file, no S3 backend, no DynamoDB lock table, and no resource anywhere that they created.
Written 2026-08-25.

(`envs/demo` is a separate, disposable lane with its own status — see its section below.
Nothing in it changes the sentence above.)

**How far it has actually been checked:**

| Check | Ran | Result |
|---|---|---|
| `terraform fmt -recursive -check` | yes | clean |
| `terraform init -backend=false` (each module + env) | yes | clean |
| `terraform validate` (each module + env) | yes | valid, no warnings |
| `terraform plan` | **no** | needs AWS credentials |
| `terraform apply` | **no** | — |

`validate` checks syntax, types, references and the provider schema. It does **not** check
that an IAM policy grants what you meant, that an AMI or engine version exists, that a
quota allows the resource, or that the graph converges on a real account. Treat everything
below as reviewed-but-unexecuted, and expect the first `plan` against a real account to
find things — that is normal and is not evidence the design is wrong.

The first real run should be `plan` against an empty dev account, read line by line by a
human, before any `apply`.

## Layout

```
modules/
  network/        VPC, three subnet tiers, VPC endpoints, optional NAT, flow logs
  data/           RDS Postgres 16, two KMS CMKs, the DB secret
  api/            ECS Fargate service, ALB, WAF, migrate task definition
  observability/  log groups + the data-protection policy that masks at ingest
envs/
  dev/            wires the four together
  demo/           ONE EC2 box for chittu.tulifo.ai — a separate lane, shares no modules
```

## envs/demo — the demo lane

One `t4g.small` in the default VPC running the compose stack from `deploy/demo/`, per
`docs/runbooks/demo-deploy.md`. It deliberately imports none of the four modules: those
describe the Fargate + RDS production topology, and dressing a demo box in them would make
a rehearsal read as the real thing.

- **Status: APPLIED 2026-08-25** into account 430313601196 (`ap-south-1`): instance
  `i-04e0ddcc0b509612d` on the adopted EIP `13.205.39.18`, bootstrap verified over SSH.
  **The state is local and lives in the worktree that applied it** — if that worktree is
  removed, copy `infra/envs/demo/terraform.tfstate` to the surviving checkout first, or
  the env must be re-imported to be managed again.
- **Local state, on purpose.** No resource in this env carries a secret — the box's
  secrets (`CHITTU_DEV_MASTER_KEY`, provider key, Caddy hash) live in on-box files the
  runbook creates, outside Terraform. A hand-bootstrapped S3 backend for a disposable env
  is ceremony without a beneficiary. State is gitignored like all state here.
- **The Elastic IP has two modes** (`eip_allocation_id`): adopt an existing allocation —
  data source + association only, so `destroy` keeps the address and the
  `chittu.tulifo.ai` A record stays valid — or null, where Terraform creates and owns one
  and `destroy` orphans the DNS record until it is repointed.
- Teardown is `terraform -chdir=infra/envs/demo destroy` plus the runbook's teardown
  notes (GoDaddy record, and the EIP if it was the adopted, hand-allocated one).

`staging/` and `prod/` are **not** written. They are the same four modules with different
tfvars, and writing them now would mean inventing values — instance sizes, retention,
certificate ARNs, the SNS topic for the redaction alarm — that nobody has decided. An
env directory full of guesses looks like a decision and is not one.

`model/` and `training/` from §14's layout are **also not written**, for the same reason.
The self-hosted model is not deployed anywhere (see `docs/chittu-local-llm-plan.md`), and
GPU capacity providers, weight buckets and an S3 sha256-verify entrypoint are a design that
has not happened yet. Plausible-looking Terraform for infrastructure nobody has designed is
worse than its absence: it reads as a decision.

## The decisions worth arguing with

**Three subnet tiers, and the database tier has no route to a NAT gateway.** Not a security
group that denies egress — no route. A subnet with no path out cannot exfiltrate a child's
data even if something in it is fully compromised, and that is a claim the DPIA can make
about a route table rather than about our discipline.

**Two KMS keys, not one.** §14 says "child-data, training — separate", and the separation is
the enforcement of Law 06: the training pipeline must be *unable* to decrypt a child's
conversation. One key with two grants is one IAM error away from a corpus of real children's
turns. The training roles are not principals on the child-data key at all, so the failure
mode is `AccessDenied` rather than a dataset.

**The TASK role gets `kms:GenerateDataKey` and `kms:Decrypt`, and that is the one exception
to "the task role is nearly empty".** It earns it. Without the grant the service falls back
to a process-local master key — which is a *different* key in every task and is discarded on
restart, so a child's name is written once and readable by nobody, including the task that
wrote it after a redeploy. `kms:Encrypt` is deliberately absent: `GenerateDataKey` returns
both halves, so nothing encrypts under the CMK directly.

**The blind-index key is a hand-created secret, not a Terraform resource.** `parent.email_hash`
is an HMAC, and its key has to be byte-identical in every task forever or a parent cannot be
found by email from any task but the one that wrote the row. KMS has no "same bytes twice"
operation, so it cannot come from KMS — and generating it here with `random_bytes` would put a
value that reverses every family's email hash into the state file. So it is created once, by
hand, and referenced by ARN. There is no default and no fallback: `index_key_secret_arn` is a
required variable and the service refuses to start without it.

**`sampled_requests_enabled = false` on every WAF rule.** This is not a cost choice. WAF
request sampling stores the request, body included, where it can be read from the console —
a sampled `POST /v1/session/:id/turn` is a child's sentence sitting in a second system that
§2.2's redaction never touches.

**`log_statement = none` on the database.** `all` or `mod` writes SQL text to the Postgres
log, and this schema's INSERTs carry a child's turn as a bind parameter. §2.2's rule holds
at the database too, not only in the application logger.

**The log groups carry a data-protection policy that masks at ingest**, so matched values
are never stored — as opposed to a metric filter that alerts on a leak already sitting in
the group. It is the *second* wall. The first is `apps/api/src/logging.ts`, and it stays the
primary control: no pattern can recognise a child's sentence as free prose in an unexpected
field, because "i want to die" is not distinguishable by pattern from ordinary text.

**The WAF rate limit is generous (3000 / 5 min / IP)** and `SizeRestrictions_BODY` is set to
count rather than block. A shared school or household NAT hitting a tight limit means
"Chittu is broken" to a nine-year-old with no support path, and a long pasted homework
question is a legitimate request.

**Migrations are a separate task definition, run to completion before the service updates.**
`bootstrapDb()` deliberately does not migrate the Postgres path: a service that migrates on
boot runs N times concurrently the moment it scales past one task. This module provides the
task definition and does *not* wire it to a trigger, because "migrate, then deploy" is an
ordering a human or a pipeline owns.

**One rule lives in `envs/dev/main.tf` rather than a module** — the Postgres ingress from the
API tasks. `data` needs the API's security group and `api` needs `data`'s secret ARN; as
module edges that is a cycle Terraform rejects. The root knows both. Moving it back into
either module reintroduces the cycle.

## Running the checks

```bash
terraform fmt -recursive -check infra
for d in infra/modules/* infra/envs/*; do
  terraform -chdir="$d" init -backend=false >/dev/null && terraform -chdir="$d" validate
done
```

There is no `plan` step in that loop on purpose: it needs credentials, and this repository
has never had any.

## Before the first apply

1. Create the S3 state bucket and DynamoDB lock table **by hand, once**, in an account that
   holds nothing else. Bootstrapping state with the thing that needs state is a chicken-and-egg
   nobody has solved cleanly; one documented exception is better than a clever one.
1. Create the **blind-index key secret**, by hand, once per environment — the second
   documented exception, for the reason given above:

   ```bash
   openssl rand -base64 32 | tr -d '\n' | aws secretsmanager create-secret \
     --name chittu/dev/index-key --secret-string file:///dev/stdin
   ```

   Keep the ARN; it is `index_key_secret_arn`. **Losing it is not recoverable** — every
   `parent.email_hash` and `memory.fact_fingerprint` already written becomes unmatchable.
   Rotating it needs a re-index that nothing here implements yet.
2. Write `envs/dev/backend.tf` pointing at them. It is deliberately absent so that
   `init -backend=false` works with no account.
3. `terraform plan` and read every line.
4. `apply` only after a human approves the plan — §14 is explicit that nothing is created by
   hand in the console, and equally that apply is gated on human approval.

Note that the service will **refuse to start** in dev without `provider_key_secret_arn`: the
image runs `NODE_ENV=production`, and `main.ts` will not serve children through the stub
router, which classifies every turn SAFE. That refusal is deliberate. Supply a key or expect
the task to exit.

It refuses on a missing `CHITTU_INDEX_KEY` for the same reason, and both refusals are checked
above the database connection — config first, so the specific error is the one you see rather
than a connection timeout that hides it.
