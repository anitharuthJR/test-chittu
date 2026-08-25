-- migrate:up
-- =============================================================================
-- 0008_automated_id_check — the first automated parental-consent rail.
--
-- G1 has been red since the backend existed: only `dev_stub` completes, and
-- every real rail is blocked on something outside this repo. This adds the
-- method value for a vendor-hosted ID + liveness + face-match check, which is
-- the first one that can actually verify a stranger.
--
-- WHY THE VALUE IS NOT NAMED FOR THE VENDOR
--
-- `consent_verification.provider` already carries the vendor ('didit'). Baking
-- a vendor name into an enum makes a provider switch a migration plus a rewrite
-- of historical rows, and it says the wrong thing to a regulator reading the
-- ledger: what matters legally is that an automated document check happened,
-- not whose API served it.
--
-- WHY NOT REUSE `gov_id_review`
--
-- That value means a HUMAN reviewed a voluntarily provided ID (DPDP r.10), and
-- its adapter is blocked on an ops runbook for exactly that review. No human
-- looks at anything on this path. Two different facts need two different values,
-- or the ledger claims a review nobody performed.
-- =============================================================================

ALTER TYPE consent_method ADD VALUE IF NOT EXISTS 'automated_id_check';

-- Bounded retries for the name check, counted SERVER-side.
--
-- A parent whose ID reads KARTHIK RAJENDRAN may well have typed "R. Karthik",
-- and the normaliser handles that — but married names and transliteration
-- variants it cannot handle, so the parent gets to correct what they typed and
-- re-match against the SAME verification session (no re-capture, no second
-- charge). Three attempts, then the flow falls back to signed_form_review.
--
-- The counter lives here rather than in the request because a client-supplied
-- attempt count is not a bound. It is also a weak name-guessing oracle against
-- a stolen session, which is the other reason it is capped at all.
ALTER TABLE consent_record
  ADD COLUMN IF NOT EXISTS verify_attempts smallint NOT NULL DEFAULT 0;

ALTER TABLE consent_record
  DROP CONSTRAINT IF EXISTS verify_attempts_sane;
ALTER TABLE consent_record
  ADD CONSTRAINT verify_attempts_sane CHECK (verify_attempts >= 0 AND verify_attempts <= 3);
