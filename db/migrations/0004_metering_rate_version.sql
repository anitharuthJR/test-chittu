-- =============================================================================
-- metering.rate_version — which price list produced cost_usd.
--
-- `cost_usd` is DERIVED. The durable record is tokens_in/tokens_out, which is
-- what the vendor actually charged for. Cost is a convenience for the console,
-- computed from a table in `apps/api/src/providers/rates.ts` that no code in
-- this repository can verify against a vendor's pricing page.
--
-- So the table WILL be wrong at some point. prototype/chittu-admin.html has
-- priced every model at sonnet's rate since it was written, which overstates a
-- haiku classifier call several-fold — and nothing in it records that, so there
-- is no way to find the affected rows.
--
-- This column is that way. Re-pricing is `UPDATE ... WHERE rate_version = ...`
-- from columns already stored. Without it, a rate correction is a guess about
-- which rows to touch.
--
-- 'UNPRICED' is written for a model we have no rate for: an honest zero, and
-- findable. Nullable with no default because every row this codebase writes
-- sets it, and a NULL would mean a row from before this migration.
-- =============================================================================

BEGIN;

ALTER TABLE metering ADD COLUMN rate_version text;

COMMENT ON COLUMN metering.rate_version IS
  'Identifier of the rate table that produced cost_usd/cost_inr. Re-price with '
  'UPDATE ... WHERE rate_version = <old>, using tokens_in/tokens_out.';

CREATE INDEX metering_rate_version_idx ON metering(rate_version);

COMMIT;
