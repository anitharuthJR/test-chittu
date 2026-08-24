# Database

Migrations are **plain SQL**, applied in filename order. The schema is a compliance
artifact — an auditor reads it directly — so it is authored in SQL rather than generated
from a query builder. Drizzle is used for *typed queries over* this schema, never to
author it.

```bash
pnpm db:migrate          # apply pending migrations
pnpm db:migrate:status   # what is applied, what is pending
```

## Before you alter a table

Four invariants are enforced here rather than in application code, because "we'll
remember" is not a control an auditor accepts:

1. `flag` has **no free-text column** — only an FK to vetted phrasing
2. `memory_category` is an enum of exactly the six allowlisted values
3. `CHECK (band <> 'thinker' OR body_enc IS NULL)` — a teen's message body is unstorable
4. `audit_event` triggers raise on UPDATE and DELETE

Removing one of these is a Guardian Council decision, not a migration.

## Verification

`0001_init.sql` parses against the real Postgres grammar but has **never been executed** —
no Postgres was available when it was written. Run it against a scratch database before
building on it.
