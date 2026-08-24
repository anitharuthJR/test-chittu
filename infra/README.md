# infra/ — Terraform for Chittu

Architecture §14 chose Terraform over CDK for one reason: G4 requires the DPIA to show that
data flows match production, and an auditor can read Terraform. That only holds if the files
here are the truth, so read this section before you read anything else.

## Status: NOTHING HERE HAS EVER BEEN APPLIED

No AWS account has been touched. There is no state file, no S3 backend, no DynamoDB lock
table, and no resource anywhere that this configuration created. Written 2026-08-25.

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
```

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
2. Write `envs/dev/backend.tf` pointing at them. It is deliberately absent so that
   `init -backend=false` works with no account.
3. `terraform plan` and read every line.
4. `apply` only after a human approves the plan — §14 is explicit that nothing is created by
   hand in the console, and equally that apply is gated on human approval.

Note that the service will **refuse to start** in dev without `provider_key_secret_arn`: the
image runs `NODE_ENV=production`, and `main.ts` will not serve children through the stub
router, which classifies every turn SAFE. That refusal is deliberate. Supply a key or expect
the task to exit.
