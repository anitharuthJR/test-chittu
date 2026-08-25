-- =============================================================================
-- provider_cell gains band and country.
--
-- Routing keyed only on category could not express the two things anyone
-- actually needs it for:
--
--   * COUNTRY — residency and clearance. §14's Phase 2 is per-market residency,
--     and `provider_clearance` is already per-jurisdiction. Until now the router
--     could not act on either, because it did not know the country of the turn
--     it was routing. `readClearance` says so in a comment and PORT-REVIEW
--     records it as a real limitation.
--   * BAND — a five-year-old and a sixteen-year-old do not need the same model,
--     and the band is already the axis everything else in this product varies on.
--
-- NULL MEANS "ANY", so every existing row keeps working unchanged: an unscoped
-- row applies to every band in every country, which is exactly what it meant
-- before these columns existed.
--
-- Resolution is most-specific-wins, and COUNTRY OUTRANKS BAND. Country is where
-- a turn may lawfully be processed; band is a judgement about what suits a
-- nine-year-old. When they disagree, the legal constraint is not the one to
-- lose. That order lives in `cellFor` and is tested there.
-- =============================================================================

BEGIN;

ALTER TABLE provider_cell
  ADD COLUMN band    text,
  ADD COLUMN country text;

-- Validated in code against BANDS/COUNTRIES too, and rejected loudly there. This
-- is the cheaper half of the same statement, made where a bad row cannot land.
ALTER TABLE provider_cell
  ADD CONSTRAINT cell_band CHECK (band IS NULL OR band IN ('explorer','builder','thinker')),
  ADD CONSTRAINT cell_country CHECK (country IS NULL OR country IN ('IN','US','GB','AU','SG','AE'));

-- The read is "newest row per (category, band, country)", so the index has to
-- match the new grouping or it stops serving the query it was built for.
DROP INDEX IF EXISTS provider_cell_current_idx;
CREATE INDEX provider_cell_current_idx
  ON provider_cell(category, band, country, changed_at DESC);

COMMIT;
