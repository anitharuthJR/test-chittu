-- migrate:up
-- =============================================================================
-- 0006_signal_review — the grants and the one CHECK that phase 4 needs.
--
-- Phase 4 (docs/chittu-model-plan.md) builds /ops/signals, the human triage
-- surface over the k-anonymous counters phase 2 began collecting. Three things
-- had to change before a single row could be written.
--
-- READ THIS FIRST: these GRANTs are a SPECIFICATION, not an enforcement. No
-- environment connects as chittu_app or chittu_ops — both are NOLOGIN, and
-- every deployment connects as the table owner, which holds every privilege
-- implicitly. `packages/db/src/index.test.ts` is the only place the model is
-- exercised, under SET LOCAL ROLE. Keeping the specification correct still
-- matters: it is what a deployment would switch on, and a specification that
-- contradicts the code is worse than none.
-- =============================================================================

-- 1. `signalRepo.observe()` DELETEs contributor rows when a shape reaches the
--    k-anonymity floor. The grant for that was missing, so under the intended
--    role the delete would fail — inside a try/catch that logs and continues,
--    which means the contributors would silently accumulate forever and the one
--    table designed to be bounded would not be.
GRANT DELETE ON signal_contributor TO chittu_app;

-- 2. Promotion writes the corpus, and no role could. `chittu_ops` had SELECT
--    only, while `signalRepo.promote()` INSERTs a training_signal and UPDATEs
--    the counter's `promoted_to`. The UPDATE is column-scoped: an operator may
--    record that a shape was promoted and may not edit the shape itself, its
--    counts, or its facets.
GRANT INSERT ON training_signal TO chittu_ops;
GRANT INSERT, UPDATE ON training_example TO chittu_ops;
GRANT UPDATE (promoted_to) ON signal_counter TO chittu_ops;

-- 3. `training_example.label` was unconstrained free text, in a file that
--    CHECKs this exact token set twice elsewhere (training_signal's
--    observed_token and expected_token). The label is what a future trainer
--    learns to emit, so an out-of-vocabulary value is how a scripted-response
--    guarantee gets violated quietly, a year later, in a dataset nobody
--    re-reads. Nullable stays legal: a SAFE example need not carry one.
ALTER TABLE training_example DROP CONSTRAINT IF EXISTS training_example_label_vocab;
ALTER TABLE training_example ADD CONSTRAINT training_example_label_vocab
  CHECK (label IS NULL OR label IN ('CRISIS','SPINE','UNSAFE','PII','SAFE'));
