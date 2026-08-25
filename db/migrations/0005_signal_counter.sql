-- migrate:up
-- =============================================================================
-- 0005_signal_counter — the k-anonymity counter, and a constraint that was wrong.
--
-- WHY THIS FILE EXISTS AT ALL, given db/README's rule that nothing is deployed
-- yet and 0001 is regenerated from docs/chittu-schema.sql.
--
-- That rule is right for the compliance artifact and useless for a database
-- that already exists. `pnpm db:migrate` keeps a ledger and SKIPS a file it has
-- applied, so editing 0001 reaches a fresh boot and never reaches a Postgres
-- somebody started last week. Both changes below are in 0001 as well; this is
-- the replay for anything already past it, and it is written to be a no-op on a
-- database that came from the new 0001.
--
-- WHAT CHANGED IN 0001
--
-- 1. `training_signal.shape_is_abstracted` was `^[a-z0-9 <>_?'-]+$`, which reads
--    like a filter and is not one. `0-9` is in that class, so '9876543210' — a
--    ten-digit Indian mobile, the highest-value thing a child could type — was
--    accepted. The same class has no `A-Z`, so the worked example in the
--    comment above the column ('my <PET> died…') could not be inserted into the
--    column it documented. Neither was noticed because the table has had zero
--    writers since it was written.
--
-- 2. `signal_counter` and `signal_contributor` are new. See the comments in
--    chittu-schema.sql: `shape` is NULL until 25 distinct sessions have produced
--    it, so below the floor there is nothing in the database to render or leak.
-- =============================================================================

ALTER TABLE training_signal DROP CONSTRAINT IF EXISTS shape_is_abstracted;
ALTER TABLE training_signal ADD CONSTRAINT shape_is_abstracted
  CHECK (shape ~ '^([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>)( ([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>))*$'
         AND length(shape) BETWEEN 1 AND 300);

CREATE TABLE IF NOT EXISTS signal_counter (
  shape_hash      bytea PRIMARY KEY,
  shape           text,
  k_sessions      integer NOT NULL DEFAULT 0 CHECK (k_sessions >= 0),
  sightings       integer NOT NULL DEFAULT 0 CHECK (sightings >= 0),

  observed_layer  pipeline_layer,
  observed_token  text CHECK (observed_token IN ('CRISIS','SPINE','UNSAFE','PII','NONE')),
  failure_class   failure_class,
  band            band,
  country         jurisdiction,

  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  promoted_to     uuid REFERENCES training_signal(id) ON DELETE SET NULL,

  CONSTRAINT shape_only_above_floor CHECK (shape IS NULL OR k_sessions >= 25),
  CONSTRAINT counter_shape_is_abstracted
    CHECK (shape IS NULL OR (shape ~ '^([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>)( ([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>))*$'
                            AND length(shape) BETWEEN 1 AND 300))
);
CREATE INDEX IF NOT EXISTS signal_counter_ready_idx ON signal_counter(k_sessions DESC)
  WHERE promoted_to IS NULL AND shape IS NOT NULL;

CREATE TABLE IF NOT EXISTS signal_contributor (
  shape_hash   bytea NOT NULL,
  contributor  bytea NOT NULL,
  PRIMARY KEY (shape_hash, contributor)
);

-- The runtime COUNTS shapes and does not promote them: promotion writes
-- training_signal, which chittu_app is granted nothing on. That absence is the
-- control keeping the runtime out of the training corpus.
GRANT SELECT, INSERT, UPDATE ON signal_counter TO chittu_app;
GRANT SELECT, INSERT ON signal_contributor TO chittu_app;
GRANT SELECT ON signal_counter TO chittu_ops;
