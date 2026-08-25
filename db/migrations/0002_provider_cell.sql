-- =============================================================================
-- provider_cell — which model serves which routing category, changeable
-- without a deploy.
--
-- §12.3 makes `route()` the single place a vendor is chosen. Until now the
-- assignment was a compiled constant (DEFAULT_CELLS), so changing which model
-- answers children needed a code change and a release. `provider_clearance`
-- could already turn a vendor OFF for a market at runtime; nothing could move
-- traffic between two cleared vendors.
--
-- WHAT THIS TABLE CANNOT DO, and it matters more than what it can:
--
--   * It cannot introduce a model. `apps/api/src/providers/cells.ts` holds a
--     compiled MODEL_CATALOGUE and a row naming anything outside it is rejected
--     and reported. The row selects; it never injects. A compromised row can
--     pick the wrong REVIEWED model; it cannot pick an unreviewed one.
--   * It cannot set a prompt version. That is derived from the code that owns
--     the prompt, so a cell can never claim a version it is not running.
--   * It cannot make an uncleared vendor callable. `route()` checks
--     provider_clearance after this, and refuses.
--
-- WHY THE CATALOGUE IS NOT A CHECK CONSTRAINT HERE. It would be defence in
-- depth, and it would also mean a migration every time a model is added — and
-- migrations are strictly additive, so that is permanent churn in the schema for
-- a list that lives in code and is enforced there with tests. The category enum
-- IS checked, because RouterCategory is stable.
--
-- APPEND-ONLY. The newest row per category wins. An UPDATE-in-place table would
-- have made "who pointed the classifier at the cheap model in March" unanswerable,
-- and routing changes are exactly the kind of thing an incident review asks about.
-- =============================================================================

BEGIN;

CREATE TABLE provider_cell (
  id          bigserial PRIMARY KEY,
  category    text NOT NULL,
  provider    text NOT NULL,
  model       text NOT NULL,

  -- Not optional, and not free text for its own sake: an unexplained routing
  -- change is not reviewable, and this is the field an incident review reads.
  changed_by  text NOT NULL,
  reason      text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cell_category CHECK (
    category IN ('classifier','sandbox','homework','curriculum','vision','embedding')),
  CONSTRAINT cell_reason_meaningful CHECK (length(btrim(reason)) >= 8),
  CONSTRAINT cell_changed_by_named  CHECK (length(btrim(changed_by)) >= 2)
);

-- The read is "newest row per category", so this is the index that serves it.
CREATE INDEX provider_cell_current_idx ON provider_cell(category, changed_at DESC);

-- Append-only in the grant, not only by convention: the runtime never writes
-- here at all, and ops writes through a reviewed path.
GRANT SELECT ON provider_cell TO chittu_app;
GRANT SELECT, INSERT ON provider_cell TO chittu_ops;
GRANT USAGE, SELECT ON SEQUENCE provider_cell_id_seq TO chittu_ops;

COMMIT;
