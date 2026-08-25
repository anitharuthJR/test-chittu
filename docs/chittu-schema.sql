-- =============================================================================
-- CHITTU (சிட்டு) — Phase 1 database schema
-- Postgres 16 + pgvector.  Tulifo Private Limited.
--
-- Read `docs/chittu-architecture.md` alongside this file. Requirements §8 gives
-- the essential entities; this is that model made real, with the doctrine
-- enforced by CONSTRAINTS rather than by convention.
--
-- Four invariants are enforced *structurally* here, because "we'll remember" is
-- not a control an auditor can accept:
--
--   1. A safety flag CANNOT hold a child's words. There is no free-text column
--      on `flag` at all — only a foreign key to a vetted phrase table.
--   2. A memory CANNOT be outside the allowlist. `memory_category` is an enum
--      of exactly six values, mirroring memAdd() in the prototype.
--   3. A teen's message body CANNOT be stored. A CHECK on `message` rejects any
--      row with band='thinker' and a non-null body (Session 001 ruling).
--   4. The audit chain CANNOT be edited. UPDATE and DELETE raise an exception.
--
-- Encryption: columns suffixed `_enc` are AES-256-GCM ciphertext produced in the
-- application from a per-child data key, itself wrapped by AWS KMS. We do NOT
-- use pgcrypto for this — passing keys as SQL arguments puts them in query logs
-- and in pg_stat_statements. Deleting the wrapped key in `child_data_key` is a
-- crypto-shred: it makes every ciphertext for that child unrecoverable in one
-- statement, which is what lets revocation be honest about "erased".
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() only
CREATE EXTENSION IF NOT EXISTS vector;     -- corpus embeddings

-- =============================================================================
-- 0. DEPLOYMENT SINGLETON
-- Lets the database itself refuse dev-only consent methods in production.
-- =============================================================================

CREATE TABLE deployment (
  only_row  boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  env       text    NOT NULL CHECK (env IN ('dev','staging','prod')),
  region    text    NOT NULL,                      -- e.g. ap-south-1
  set_at    timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 1. ENUMS — the vocabulary of the system
-- =============================================================================

CREATE TYPE band AS ENUM ('explorer','builder','thinker');   -- 4-7 / 8-12 / 13-17

CREATE TYPE jurisdiction AS ENUM ('IN','US','UK','EU','AU','SG','AE');

-- Consent rails. DigiLocker is DEFERRED (see architecture doc §5.2): the value
-- exists so the port and the ledger are shaped correctly, but no adapter
-- implements it yet and a CHECK below prevents it being recorded.
CREATE TYPE consent_method AS ENUM (
  'dev_stub',               -- non-production only; blocked by trigger in prod
  'card_micro_charge',      -- COPPA §312.5(b)(2) — US
  'email_plus',             -- COPPA email-plus — US, low-risk scopes only
  'signed_form_review',     -- COPPA print-and-sign; also the IN interim rail
  'gov_id_review',          -- DPDP Rules 2025 r.10 — voluntarily provided ID
  'consent_manager_token',  -- DPDP r.10 — virtual token, registered CM
  'digilocker',             -- DEFERRED — not yet implemented
  'age_assurance_uk'        -- AADC proportional assurance
);

CREATE TYPE consent_status AS ENUM
  ('draft','verifying','active','revoked','expired','superseded');

-- Requirements §4.3. Six values, no more. This enum IS the allowlist.
CREATE TYPE memory_category AS ENUM
  ('INTEREST','PET','HOBBY','FAVORITE','ACHIEVEMENT','LEARNING');

CREATE TYPE flag_kind AS ENUM ('SAFETY','ASSIST','GATE');

CREATE TYPE msg_role AS ENUM ('child','chittu','system');

-- The fixed pipeline order (CLAUDE.md). Stored on every audit event so the
-- trace a certifier reads is the trace the code actually walked.
CREATE TYPE pipeline_layer AS ENUM (
  'SEAL','CRISIS_LOCK','READ','L1_LEXICON','MATH_LOOP','MATH_ENGINE',
  'CORPUS','SUBJECT','L2_CLASSIFIER','L5_SANDBOX','L6_FILTER','RENDER','LEDGER'
);

CREATE TYPE corpus_state  AS ENUM ('draft','verified','signed','published','retired');
CREATE TYPE review_state   AS ENUM ('PENDING_HUMAN_REVIEW','APPROVED','REJECTED');
CREATE TYPE helpline_status AS ENUM ('verified','stale','P0_WRONG_NUMBER');

-- =============================================================================
-- 2. IDENTITY & CONSENT  (Law 02 — consent before existence)
-- =============================================================================

CREATE TABLE parent (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- email is needed to reach the parent; it is the only adult PII we hold.
  email_hash     bytea NOT NULL UNIQUE,   -- HMAC-SHA256, for lookup without decryption
  email_enc      bytea NOT NULL,
  display_name_enc bytea,                 -- parent's first name, from onboarding
  locale         text  NOT NULL DEFAULT 'en',
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

-- PIN lives apart from `parent` so it can carry its own grants and its own
-- audit. Argon2id, computed in the app. Verification is server-side and rate
-- limited in Redis; `failed_attempts` here is the durable backstop.
CREATE TABLE parent_pin (
  parent_id       uuid PRIMARY KEY REFERENCES parent(id) ON DELETE CASCADE,
  pin_hash        text NOT NULL,           -- argon2id, never a bare digest
  failed_attempts smallint NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  rotated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (failed_attempts >= 0)
);

-- We store an age BAND, never a date of birth. The band is what the product
-- needs; the birthdate is a treasure that should not exist (Law 06).
CREATE TABLE child (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id      uuid NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
  first_name_enc bytea NOT NULL,           -- first name only, never a surname
  band           band NOT NULL,
  band_set_at    timestamptz NOT NULL DEFAULT now(),
  board          text NOT NULL DEFAULT 'General',   -- one of the 23 curriculum framings
  country        jurisdiction NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX child_parent_idx ON child(parent_id) WHERE deleted_at IS NULL;

-- The envelope key. One row per child; dropping it crypto-shreds that child.
CREATE TABLE child_data_key (
  child_id     uuid PRIMARY KEY REFERENCES child(id) ON DELETE CASCADE,
  wrapped_dek  bytea NOT NULL,             -- DEK encrypted under the KMS CMK
  kms_key_arn  text  NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  shredded_at  timestamptz                 -- set when wrapped_dek is zeroed
);

-- Requirements §8: first-class, versioned. Rows are APPEND-ONLY; a change of
-- toggles or band writes a new row that supersedes the old one, so the ledger
-- can always answer "what was consented to, when, under which law".
CREATE TABLE consent_record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       uuid NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
  child_id        uuid          REFERENCES child(id)  ON DELETE CASCADE,
  version         integer NOT NULL DEFAULT 1,
  supersedes      uuid REFERENCES consent_record(id),

  jurisdiction    jurisdiction NOT NULL,
  law             text NOT NULL,                    -- 'DPDP 2023 + Rules 2025', 'COPPA 2025', ...
  method          consent_method NOT NULL,
  status          consent_status NOT NULL DEFAULT 'draft',

  scopes          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ['chat','voice','vision',...]
  memory_on       boolean NOT NULL DEFAULT true,
  learn_on        boolean NOT NULL DEFAULT false,      -- opt-IN, default OFF (§4.4)
  band            band NOT NULL,
  board           text NOT NULL,

  issued_at       timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoke_reason   text,

  seal_hash       text NOT NULL,                       -- head of the chain at issue
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- DigiLocker is deferred: refuse to record it until the adapter ships, so no
  -- ledger row can ever claim a verification that never happened.
  CONSTRAINT digilocker_deferred CHECK (method <> 'digilocker'),
  CONSTRAINT active_needs_issue  CHECK (status <> 'active' OR issued_at IS NOT NULL),
  CONSTRAINT revoked_needs_time  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
CREATE INDEX consent_child_idx  ON consent_record(child_id, status);
CREATE INDEX consent_parent_idx ON consent_record(parent_id, created_at DESC);

-- Exactly one active consent per child.
CREATE UNIQUE INDEX consent_one_active
  ON consent_record(child_id) WHERE status = 'active';

-- Evidence from the verification adapter. We keep a REFERENCE and a hash of
-- what was checked — never the document, never the card number, never the
-- ID image. If a regulator asks "how did you verify?", this answers it; if an
-- attacker takes the database, it yields nothing.
CREATE TABLE consent_verification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id     uuid NOT NULL REFERENCES consent_record(id) ON DELETE CASCADE,
  method         consent_method NOT NULL,
  provider       text NOT NULL,                 -- adapter name, e.g. 'stripe-microcharge'
  provider_ref   text,                          -- opaque id at the provider
  evidence_hash  bytea NOT NULL,                -- SHA-256 of the canonical evidence blob
  verified_at    timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  CONSTRAINT no_digilocker_evidence CHECK (method <> 'digilocker')
);
CREATE INDEX consent_verification_consent_idx ON consent_verification(consent_id);

-- Production must never see the dev stub.
CREATE OR REPLACE FUNCTION reject_dev_stub_in_prod() RETURNS trigger AS $$
BEGIN
  IF NEW.method = 'dev_stub'
     AND (SELECT env FROM deployment WHERE only_row) = 'prod' THEN
    RAISE EXCEPTION 'consent method dev_stub is not permitted in production';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER consent_no_dev_stub
  BEFORE INSERT OR UPDATE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION reject_dev_stub_in_prod();

-- Bearer token for opening a session. Stored as a keyed hash: a credential at
-- rest is not the same thing as an identifier at rest. See db/migrations/0002.
ALTER TABLE consent_record
  ADD COLUMN token_hash bytea,
  ADD COLUMN token_issued_at timestamptz;
CREATE UNIQUE INDEX consent_token_unique
  ON consent_record (token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE consent_record
  ADD CONSTRAINT token_only_when_active
  CHECK (token_hash IS NULL OR status = 'active');

-- =============================================================================
-- 3. CHILD RUNTIME  (sessions, messages, memories)
-- =============================================================================

CREATE TABLE session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id       uuid NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  consent_id     uuid NOT NULL REFERENCES consent_record(id),
  band           band NOT NULL,                  -- snapshot: bands can change
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  ended_reason   text,                           -- 'child_left','timeout','revoked'
  crisis_lock    boolean NOT NULL DEFAULT false,
  locked_at      timestamptz,
  unlocked_at    timestamptz,
  unlocked_by    uuid REFERENCES parent(id),     -- the ONLY unlock path (§4.5)
  device_class   text,                           -- 'lite','standard' — informs Lite mode
  msg_count      integer NOT NULL DEFAULT 0,
  spine_count    integer NOT NULL DEFAULT 0,

  -- Transient pipeline state that outlives a request but not the session: the
  -- armed maths practice question, coarse topic labels, assist notes, the last
  -- detected subject, and the classifier's 3-message rolling window.
  --
  -- The rolling window is the uncomfortable part and is flagged rather than
  -- hidden: for a `thinker` it is the ONE place a teen's words are written down,
  -- because `message.body_enc` refuses them. Without it the classifier loses its
  -- window for exactly the band whose turns most need context — which since
  -- 2026-08-25 is a named field, `recentKid`, separate from the model's context. It is encrypted
  -- under the child's DEK, lives only as long as the session, and dies with the
  -- crypto-shred — but it is still a teen's words at rest, and Chamber II should
  -- decide whether that trade is the right one.
  runtime_enc    bytea,
  CONSTRAINT unlock_needs_parent
    CHECK (unlocked_at IS NULL OR unlocked_by IS NOT NULL)
);
CREATE INDEX session_child_idx ON session(child_id, started_at DESC);

-- Conversation is session-scoped and expiring by default (§7: "session-only
-- conversation memory; forgetting is a feature"). Partitioned monthly so the
-- retention sweep is a DROP PARTITION, not a 100-million-row DELETE.
--
-- band='thinker' rows carry NO body: teens get a topics-only parent view, and
-- the CHECK makes storing the body impossible rather than merely forbidden.
CREATE TABLE message (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL,
  seq         integer NOT NULL,
  role        msg_role NOT NULL,
  band        band NOT NULL,
  body_enc    bytea,                     -- NULL for teens, and for any redacted turn
  topic       text,                       -- coarse label, safe for every band
  mode        text,                       -- chat | learn | homework | story | ...
  trace       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- layers walked, timings, versions
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (created_at, id),
  CONSTRAINT teen_bodies_are_never_stored
    CHECK (band <> 'thinker' OR body_enc IS NULL)
) PARTITION BY RANGE (created_at);

CREATE INDEX message_session_idx ON message(session_id, seq);

-- One partition per month. Create ahead in a scheduled job; here are two.
CREATE TABLE message_2026_08 PARTITION OF message
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE message_2026_09 PARTITION OF message
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- The Memory Book: the only intentional long-lived record of a child (§4.3).
-- Visible to child and parent alike; either may delete; erased on revocation.
CREATE TABLE memory (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id             uuid NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  category             memory_category NOT NULL,      -- the allowlist, in the type system
  fact_enc             bytea NOT NULL,
  fact_fingerprint     bytea NOT NULL,                -- HMAC, for dedupe without decrypting
  since                timestamptz NOT NULL DEFAULT now(),
  provenance_session   uuid REFERENCES session(id) ON DELETE SET NULL,
  announced_at         timestamptz NOT NULL DEFAULT now(),  -- every save is announced
  deleted_at           timestamptz,
  deleted_by           text CHECK (deleted_by IN ('child','parent','revocation','system'))
);
CREATE UNIQUE INDEX memory_no_duplicates
  ON memory(child_id, fact_fingerprint) WHERE deleted_at IS NULL;
CREATE INDEX memory_child_idx ON memory(child_id) WHERE deleted_at IS NULL;

-- =============================================================================
-- 4. FLAGS  (parent-visible signals that must never quote the child)
-- =============================================================================

-- Vetted phrasing, written by humans, versioned. A flag points here; it cannot
-- carry prose of its own. This is invariant 1, made structural.
CREATE TABLE flag_note_template (
  key         text PRIMARY KEY,             -- 'CRISIS_DISTRESS', 'STRUGGLE_TOPIC', ...
  kind        flag_kind NOT NULL,
  category    text NOT NULL,                -- CRISIS | UNSAFE | SECRET-KEEPING | PII | ...
  body        text NOT NULL,                -- what the parent reads
  version     integer NOT NULL DEFAULT 1,
  retired_at  timestamptz
);

CREATE TABLE flag (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id        uuid NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES session(id) ON DELETE SET NULL,
  kind            flag_kind NOT NULL,
  note_key        text NOT NULL REFERENCES flag_note_template(key),
  -- ASSIST flags name a school topic ("fractions"), never a feeling and never a
  -- quote. Constrained hard so it cannot become a free-text field by drift.
  assist_topic    text CHECK (assist_topic IS NULL OR assist_topic ~ '^[a-z0-9 \-]{1,40}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES parent(id),
  CONSTRAINT assist_topic_only_on_assist
    CHECK (assist_topic IS NULL OR kind = 'ASSIST')
);
CREATE INDEX flag_child_idx ON flag(child_id, created_at DESC);
CREATE INDEX flag_open_idx  ON flag(child_id) WHERE acknowledged_at IS NULL;

-- =============================================================================
-- 5. SEAL CHAIN  (Sakshi — tamper-evident audit, §8 / §9.6)
-- =============================================================================

CREATE TABLE audit_event (
  id           bigserial PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now(),
  role         msg_role NOT NULL,
  -- TEXT, not the pipeline_layer enum, and that is a correction rather than a
  -- relaxation. The prototype seals the human-readable TRACE LABEL — "MATH
  -- ENGINE · deterministic + pedagogy (CPA)", "SCRIPTED SPINE (Law 03/04)" —
  -- because that string is what the parent's ledger displays. Typing this as
  -- the enum assumed the seal carried a machine-readable layer, and the port
  -- proved otherwise the first time a turn ran.
  --
  -- The machine-readable walk is not lost: `message.trace` carries the ordered
  -- `layers` array. One column, one job.
  layer        text NOT NULL,
  payload_hash text NOT NULL,        -- SHA-256 of role|text — never the text
  prev_hash    text NOT NULL,        -- 'GENESIS' for seq 0
  hash         text NOT NULL,        -- SHA-256(prev|payload)
  UNIQUE (session_id, seq),          -- serialises the chain; a fork cannot be written
  UNIQUE (hash)
);
CREATE INDEX audit_session_idx ON audit_event(session_id, seq);

-- Append-only. Not "we don't update it" — the database refuses.
CREATE OR REPLACE FUNCTION audit_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (attempted %)', TG_OP;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_append_only();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_append_only();

-- Chain heads published outside the database, so that a total compromise of
-- Postgres still cannot rewrite history undetected.
CREATE TABLE seal_anchor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  head_seq     integer NOT NULL,
  head_hash    text NOT NULL,
  anchored_at  timestamptz NOT NULL DEFAULT now(),
  external_ref text                     -- transparency-log / WORM object receipt
);
CREATE INDEX seal_anchor_session_idx ON seal_anchor(session_id, head_seq DESC);

-- =============================================================================
-- 6. GROUNDED CORPUS  (§9.4 — draft -> verify -> sign -> publish)
-- =============================================================================

CREATE TABLE corpus_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board         text NOT NULL,                 -- CBSE | TN Samacheer Kalvi | IB PYP | ...
  class_level   text,                          -- 'class-5', 'PYP-3'
  subject       text NOT NULL,
  topic         text NOT NULL,
  body          text NOT NULL,                 -- editorial content; NOT child data
  source_url    text,
  state         corpus_state NOT NULL DEFAULT 'draft',
  drafted_by    text,
  verified_by   text,
  signed_by     text,
  signed_at     timestamptz,
  published_at  timestamptz,
  retired_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT published_must_be_signed
    CHECK (state <> 'published' OR (signed_by IS NOT NULL AND signed_at IS NOT NULL))
);
CREATE INDEX corpus_lookup_idx ON corpus_entry(board, subject, state);

CREATE TABLE corpus_chunk (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid NOT NULL REFERENCES corpus_entry(id) ON DELETE CASCADE,
  ord        integer NOT NULL,
  body       text NOT NULL,
  embedding  vector(1024) NOT NULL,
  UNIQUE (entry_id, ord)
);
-- Only published entries are ever retrieved; the filter lives in the query.
CREATE INDEX corpus_chunk_ann
  ON corpus_chunk USING hnsw (embedding vector_cosine_ops);

-- =============================================================================
-- 7. HELPLINE REGISTRY  (§8 / §9.5 — a wrong number is a P0)
-- =============================================================================

CREATE TABLE helpline_registry (
  country        jurisdiction PRIMARY KEY,
  lines          jsonb NOT NULL,          -- [{name, number, hours, languages, url}]
  status         helpline_status NOT NULL DEFAULT 'verified',
  last_verified  timestamptz NOT NULL,
  verified_by    text NOT NULL,
  next_sweep     timestamptz NOT NULL,
  CONSTRAINT lines_not_empty CHECK (jsonb_array_length(lines) > 0)
);

-- A country cannot be enabled for children without verified helplines: the
-- crisis script has nowhere to point. G3 in one constraint.
CREATE TABLE market (
  country       jurisdiction PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT false,
  g0_cleared_at timestamptz,
  g1_cleared_at timestamptz,
  g3_cleared_at timestamptz,
  notes         text
);

CREATE OR REPLACE FUNCTION market_needs_helplines() RETURNS trigger AS $$
BEGIN
  IF NEW.enabled AND NOT EXISTS (
      SELECT 1 FROM helpline_registry h
      WHERE h.country = NEW.country AND h.status = 'verified') THEN
    RAISE EXCEPTION 'market % cannot be enabled without verified helplines', NEW.country;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER market_helpline_gate
  BEFORE INSERT OR UPDATE ON market
  FOR EACH ROW EXECUTE FUNCTION market_needs_helplines();

-- =============================================================================
-- 8. LEARNING LOOP  (§4.4 — patterns only, human-approved, never raw chats)
-- =============================================================================

CREATE TABLE learning_insight (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern        text NOT NULL,             -- aggregate observation, written by the job
  band           band,
  evidence_count integer NOT NULL CHECK (evidence_count >= 25),  -- k-anonymity floor
  state          review_state NOT NULL DEFAULT 'PENDING_HUMAN_REVIEW',
  reviewed_by    text,
  reviewed_at    timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decided_needs_reviewer
    CHECK (state = 'PENDING_HUMAN_REVIEW' OR reviewed_by IS NOT NULL)
);

-- There is deliberately NO foreign key from learning_insight to child, session
-- or message. The loop cannot be traced back to a child because the link does
-- not exist.

-- =============================================================================
-- 9. METERING  (§4.6 — pseudonymised; admin sees cost, never children)
-- =============================================================================

-- No FK to session: `session_pseudonym` is HMAC(session_id, rotating_key), so
-- the ops console can aggregate per session without being able to reach a child.
CREATE TABLE metering (
  id                bigserial PRIMARY KEY,
  session_pseudonym bytea NOT NULL,
  call_type         text NOT NULL,          -- 'classifier' | 'sandbox' | 'embedding'
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_version    text,
  tokens_in         integer NOT NULL DEFAULT 0,
  tokens_out        integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  latency_ms        integer,
  cost_usd          numeric(12,6) NOT NULL DEFAULT 0,
  cost_inr          numeric(12,4) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metering_time_idx ON metering(created_at DESC);
CREATE INDEX metering_pseudonym_idx ON metering(session_pseudonym);

-- =============================================================================
-- 10. NAMED-HUMANS ACCESS  (§4.6 / §7 — target: zero grants)
-- =============================================================================

CREATE TABLE admin_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,          -- staff, not children: plain is fine
  full_name   text NOT NULL,
  role        text NOT NULL CHECK (role IN ('ops','safety','engineer','dpo','auditor')),
  webauthn_required boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

-- Every read of a child's transcript by a human is a grant, time-boxed,
-- co-signed, and counted. The metric we publish is that this table stays empty.
CREATE TABLE transcript_grant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES admin_user(id),
  child_id     uuid NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  reason       text NOT NULL,
  approved_by  uuid NOT NULL REFERENCES admin_user(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  used_at      timestamptz,
  CONSTRAINT four_eyes CHECK (approved_by <> admin_id),
  CONSTRAINT grant_is_time_boxed CHECK (expires_at > granted_at)
);

-- =============================================================================
-- 11. ROW-LEVEL SECURITY
--
-- THE DESIGN: the API connects as `chittu_app`, which can never see across
-- families — every child-scoped query is filtered by the consent token's
-- child_id, set per request with SET LOCAL, so a SQL injection that escapes a
-- WHERE clause still cannot read another child's data.
--
-- WHAT IS ACTUALLY IN FORCE, as of 2026-08-25: none of it. `chittu_app` is
-- NOLOGIN and nothing connects as it; every environment connects as the table
-- OWNER (PGlite as `postgres`, compose and test:pg as `chittu`), which holds
-- every privilege implicitly and bypasses row-level security. `FORCE ROW LEVEL
-- SECURITY` is set on no table, so even an owner that did SET ROLE would be
-- exempt. Verified by probe: the runtime pool INSERTs into `training_signal`
-- successfully today.
--
-- The policies below are correct and are tested — `packages/db/src/index.test.ts`
-- runs them under `SET LOCAL ROLE chittu_app`. They are a specification that
-- one line of deployment configuration would activate, not a control that is
-- protecting anybody right now. What DOES protect a child-scoped query today is
-- `assert_child_scope()` below, which raises rather than filtering.
-- =============================================================================

-- Roles are CLUSTER-level, not schema-level, so they survive a DROP SCHEMA and
-- a plain CREATE ROLE fails the second time this file is applied. Wrapped so the
-- schema is re-runnable — which is what lets the same suite run against a throw-
-- away schema on a shared Postgres.
DO $$ BEGIN
  CREATE ROLE chittu_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE chittu_ops NOLOGIN;   -- metering + registries only
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE child   ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory  ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag    ENABLE ROW LEVEL SECURITY;
ALTER TABLE message ENABLE ROW LEVEL SECURITY;

-- NULLIF: once a session has touched the key, current_setting returns '' rather
-- than NULL, and ''::uuid raises rather than matching nothing. Fail closed means
-- returning no rows, not returning a 500 — and the same empty-vs-null confusion
-- already had to be fixed once in revoke_and_erase.
CREATE POLICY child_scope ON child   FOR ALL TO chittu_app
  USING (id = NULLIF(current_setting('chittu.child_id', true), '')::uuid);
CREATE POLICY session_scope ON session FOR ALL TO chittu_app
  USING (child_id = NULLIF(current_setting('chittu.child_id', true), '')::uuid);
CREATE POLICY memory_scope ON memory  FOR ALL TO chittu_app
  USING (child_id = NULLIF(current_setting('chittu.child_id', true), '')::uuid);
CREATE POLICY flag_scope ON flag      FOR ALL TO chittu_app
  USING (child_id = NULLIF(current_setting('chittu.child_id', true), '')::uuid);
CREATE POLICY message_scope ON message FOR ALL TO chittu_app
  USING (session_id IN (SELECT id FROM session
                        WHERE child_id = NULLIF(current_setting('chittu.child_id', true), '')::uuid));

-- The grants these policies depend on are at the END of this file: several of
-- the tables involved are not created until later sections, and a GRANT cannot
-- name a table that does not exist yet.

-- The ops console never touches child-scoped tables at all.
GRANT SELECT ON metering, helpline_registry, market, learning_insight TO chittu_ops;

-- =============================================================================
-- 12. RETENTION
-- Conversation expires; the Memory Book does not. Run hourly from pg-boss.
-- =============================================================================

CREATE OR REPLACE FUNCTION sweep_expired_messages() RETURNS bigint AS $$
DECLARE removed bigint;
BEGIN
  WITH gone AS (DELETE FROM message WHERE expires_at < now() RETURNING 1)
  SELECT count(*) INTO removed FROM gone;
  RETURN removed;
END; $$ LANGUAGE plpgsql;

-- Revocation, as one transaction: shred the key, drop the plaintext-bearing
-- rows, close the seal, and leave the consent ledger standing as proof that a
-- consent existed and was withdrawn.
CREATE OR REPLACE FUNCTION revoke_and_erase(p_child uuid, p_reason text)
RETURNS void AS $$
BEGIN
  -- Under RLS every statement below is filtered by chittu.child_id. If that
  -- setting is ABSENT, the policies match zero rows and this function returns
  -- successfully having erased nothing; if it is present but DIFFERENT, likewise.
  -- A silent no-op on an erasure request is the worst failure this system has —
  -- the parent is told "erased" and nothing was. So demand the scope explicitly
  -- and fail loudly on either shape. Callers must SET LOCAL chittu.child_id.
  -- coalesce, not IS NULL: once a session has touched the key at all,
  -- current_setting returns '' rather than NULL, and '' would fall straight
  -- through an IS NULL guard into the silent-no-op case.
  IF coalesce(current_setting('chittu.child_id', true), '') = '' THEN
    RAISE EXCEPTION 'revoke_and_erase requires chittu.child_id to be set for %', p_child;
  END IF;
  IF NULLIF(current_setting('chittu.child_id', true), '')::uuid <> p_child THEN
    RAISE EXCEPTION 'revoke_and_erase called for % under a session scoped to %',
      p_child, current_setting('chittu.child_id', true);
  END IF;

  UPDATE child_data_key
     SET wrapped_dek = '\x'::bytea, shredded_at = now()
   WHERE child_id = p_child;

  UPDATE memory SET deleted_at = now(), deleted_by = 'revocation'
   WHERE child_id = p_child AND deleted_at IS NULL;

  DELETE FROM message
   WHERE session_id IN (SELECT id FROM session WHERE child_id = p_child);

  UPDATE session SET ended_at = COALESCE(ended_at, now()), ended_reason = 'revoked'
   WHERE child_id = p_child AND ended_at IS NULL;

  UPDATE consent_record
     SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason
   WHERE child_id = p_child AND status = 'active';

  UPDATE child SET deleted_at = now() WHERE id = p_child;
  -- audit_event rows survive: hashes only, no content, and the chain must
  -- remain verifiable to prove the erasure happened.
END; $$ LANGUAGE plpgsql;

COMMIT;

-- =============================================================================
-- SEED — the vetted flag phrasings, lifted from prototype v3.3 so the parent
-- reads the same words the prototype already tested on parents.
-- =============================================================================

INSERT INTO flag_note_template (key, kind, category, body) VALUES
 ('CRISIS_DISTRESS','SAFETY','CRISIS',
  'Possible distress or harm disclosure. Chat is in calm mode until you mark this handled.'),
 ('UNSAFE_TOPIC','SAFETY','UNSAFE',
  'An off-limits topic came up and was deflected. Category logged; content not quoted.'),
 ('SECRET_KEEPING','SAFETY','SECRET-KEEPING',
  'Secret-keeping came up. A scripted no-secrets reply was given. Worth a gentle chat.'),
 ('PII_SHARED','SAFETY','PII',
  'Something private nearly got shared. Chittu asked them to keep it private.'),
 ('OUTPUT_FILTER','SAFETY','OUTPUT-FILTER',
  'A generated reply failed the output filter and a safe fallback was used.'),
 ('PIN_LOCKOUT','GATE','GATE',
  'Five wrong Parent-PIN attempts — dashboard locked for 60 seconds. It may have been a curious child.'),
 ('STRUGGLE_TOPIC','ASSIST','STRUGGLE',
  'Repeated difficulty with a school topic. A little help at home would go a long way.'),
 ('BIG_QUESTION','ASSIST','BIG-QUESTION',
  'A big question came up that a family is better placed to answer than a machine.');

-- =============================================================================
-- 13. TRAINING CORPUS
--
-- Read `chittu-architecture.md` §12 before using these tables.
--
-- Requirements §1 and §4.4 forbid training on children's conversations, and
-- §9.2 requires revocation to propagate — which model weights cannot honour,
-- since a trained network cannot forget. These tables therefore store the
-- SIGNAL (which shapes of input the pipeline handles badly) and the AUTHORED
-- examples written in response to it. They never store a child's turn.
--
-- There is deliberately no foreign key from any table here to child, session
-- or message, and no `origin` value meaning "a real child said this".
-- =============================================================================

BEGIN;

CREATE TYPE failure_class AS ENUM (
  'OVER_REFUSAL',        -- guarded something ordinary: "i am nervous about class"
  'UNDER_REFUSAL',       -- let something through that should have escalated
  'WRONG_TOKEN',         -- escalated, but returned the wrong one (persona jailbreaks)
  'HALLUCINATION',       -- invented a fact, number, date or name
  'L6_CATCH',            -- output filter fired: the model tried to say it
  'CLASSIFIER_PARSE',    -- classifier returned unparseable JSON -> FAST-PATH-ONLY
  'PRACTICE_LOOP_STUCK', -- maths loop could not progress
  'BLOCK_GRAMMAR',       -- malformed [FACT] / [STEPS] / control tokens leaked
  'QUALITY_DEGRADED'     -- routed correctly, but the prose was poor
);

CREATE TYPE training_origin AS ENUM (
  'AUTHORED',   -- a human wrote it, prompted by a signal
  'SYNTHETIC',  -- generated by a model, human-reviewed
  'RED_TEAM',   -- adversarial corpus
  'DISTILLED',  -- teacher-model output, human-reviewed
  'STAFF'       -- consenting adult staff turns
  -- NOTE: there is no CHILD_TURN value, and adding one is a Council decision,
  -- not a migration.
);

CREATE TYPE data_split AS ENUM ('train','val','eval_holdout');

-- ---------------------------------------------------------------------------
-- The de-identified observation. `shape` is produced by the deterministic
-- abstractor in safety-kernel: entities and numbers become typed placeholders,
-- and any token outside a closed ~2k common-word vocabulary becomes <OOV>.
-- Anything distinctive enough to identify a child is destroyed by construction,
-- so this is not "anonymised child text" — the child's words never arrive.
-- ---------------------------------------------------------------------------
CREATE TABLE training_signal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shape           text NOT NULL,       -- 'my <PET> died and i feel <EMOTION>'
  shape_hash      bytea NOT NULL UNIQUE,
  band            band,
  mode            text,
  subject         text,
  board           text,
  country         jurisdiction,

  observed_layer  pipeline_layer NOT NULL,
  observed_token  text CHECK (observed_token IN ('CRISIS','SPINE','UNSAFE','PII','NONE')),
  expected_token  text CHECK (expected_token IN ('CRISIS','SPINE','UNSAFE','PII','NONE')),
  failure_class   failure_class NOT NULL,

  -- k-anonymity floor. A shape seen fewer than 25 times is a counter, not a
  -- readable row: the application refuses to render `shape` below the floor and
  -- the check keeps stored rows above it.
  k_sessions      integer NOT NULL CHECK (k_sessions >= 25),

  state           review_state NOT NULL DEFAULT 'PENDING_HUMAN_REVIEW',
  reviewed_by     text,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT signal_decided_needs_reviewer
    CHECK (state = 'PENDING_HUMAN_REVIEW' OR reviewed_by IS NOT NULL),
  -- The abstractor's output vocabulary only: space-separated tokens, each
  -- either a lowercase word or one of exactly six placeholders. Rejects raw
  -- prose reaching this column by any route.
  --
  -- THIS IS A WHITELIST, and it did not start as one. The first version was
  -- `^[a-z0-9 <>_?'-]+$`, which reads like a filter and is not one: `0-9` is in
  -- that class, so '9876543210' — a ten-digit Indian mobile number, the single
  -- highest-value thing a child could type — matched it and stored cleanly. The
  -- same class has no A-Z, so the worked example three lines above ('my <PET>
  -- died…') could not be inserted into the column it was documenting. Both were
  -- invisible for as long as this table had zero writers: a constraint is only
  -- tested by code that tries to write through it.
  --
  -- NB: Postgres regex bounds max out at 255, so the length lives in its own
  -- check rather than a {1,300} repetition — which is a compile error, and one
  -- that a syntax-only parse will happily accept.
  CONSTRAINT shape_is_abstracted
    CHECK (shape ~ '^([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>)( ([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>))*$'
           AND length(shape) BETWEEN 1 AND 300)
);
CREATE INDEX signal_triage_idx ON training_signal(failure_class, state, k_sessions DESC);

-- ---------------------------------------------------------------------------
-- THE COUNTER THAT STANDS IN FRONT OF training_signal.
--
-- A shape seen fewer than 25 times is a counter, not a readable row — and the
-- way that is enforced here is stronger than "the application refuses to render
-- it". `shape` IS NULL until the floor is crossed. The abstractor holds the
-- text in memory during the turn that crosses it and writes it then; below the
-- floor there is nothing in this database to render, redact or leak, because
-- nothing was ever stored.
--
-- No foreign key to session, child or message, exactly as `training_signal` has
-- none. `signal_contributor` below is how 25 DISTINCT sessions are counted
-- without this table being able to name one.
-- ---------------------------------------------------------------------------
CREATE TABLE signal_counter (
  shape_hash      bytea PRIMARY KEY,          -- keyed HMAC; not reversible from a wordlist
  shape           text,                       -- NULL below the floor. See above.
  k_sessions      integer NOT NULL DEFAULT 0 CHECK (k_sessions >= 0),
  -- Total observations, not de-duplicated. `k_sessions` stops counting at the
  -- floor because its contributor rows are deleted there; this keeps rising, so
  -- a triage queue can still order by "how often is this happening".
  sightings       integer NOT NULL DEFAULT 0 CHECK (sightings >= 0),

  -- ALL FIVE ARE NULLABLE, and NULL here means "not always the same", not
  -- "unknown". The row is keyed on the shape alone, so one row aggregates every
  -- session that produced it; a facet is kept only while every sighting agrees,
  -- and goes NULL for good the first time one disagrees. Recording the FIRST
  -- band instead would read as "this is a builder thing" when all it means is
  -- that a builder got there first.
  --
  -- failure_class is nullable for a second reason too: the runtime fills it in
  -- only for the two failures it can name without deciding what SHOULD have
  -- happened. The rest is a human's judgement, supplied at promotion.
  observed_layer  pipeline_layer,
  observed_token  text CHECK (observed_token IN ('CRISIS','SPINE','UNSAFE','PII','NONE')),
  failure_class   failure_class,
  band            band,
  country         jurisdiction,

  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  promoted_to     uuid REFERENCES training_signal(id) ON DELETE SET NULL,

  -- The k-anonymity floor, as a constraint rather than as a query somebody
  -- remembers to write. 25 here and 25 on training_signal.k_sessions.
  CONSTRAINT shape_only_above_floor CHECK (shape IS NULL OR k_sessions >= 25),
  CONSTRAINT counter_shape_is_abstracted
    CHECK (shape IS NULL OR (shape ~ '^([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>)( ([a-z][a-z0-9''-]*|<(NAME|PLACE|PET|NUM|EMOTION|OOV)>))*$'
                            AND length(shape) BETWEEN 1 AND 300))
);
CREATE INDEX signal_counter_ready_idx ON signal_counter(k_sessions DESC)
  WHERE promoted_to IS NULL AND shape IS NOT NULL;

-- ---------------------------------------------------------------------------
-- How "25 DISTINCT sessions" is counted without storing which sessions.
--
-- `contributor` is HMAC(key, domain || shape_hash || session_id). Scoping it to
-- the shape is the whole design: the same session contributing to two different
-- shapes produces two unrelated values, so these rows cannot be joined together
-- into "the list of shapes this child produced" — which is the profile the
-- counter exists to avoid building.
--
-- Rows are DELETED when a shape reaches the floor, and no more are inserted
-- after that, so this table holds at most 25 rows per shape and shrinks as
-- shapes promote.
-- ---------------------------------------------------------------------------
CREATE TABLE signal_contributor (
  shape_hash   bytea NOT NULL,
  contributor  bytea NOT NULL,
  PRIMARY KEY (shape_hash, contributor)
);

-- ---------------------------------------------------------------------------
-- What actually trains. Every row is written by a human or a teacher model and
-- reviewed by a DIFFERENT human — the critic pass that caught ~130 factual
-- errors across the llm-kit authoring rounds.
-- ---------------------------------------------------------------------------
CREATE TABLE training_example (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id            uuid REFERENCES training_signal(id) ON DELETE SET NULL,
  origin               training_origin NOT NULL,
  slice                text NOT NULL,          -- curriculum slice, e.g. 'sex-ed-boundary'
  lang                 text NOT NULL DEFAULT 'en',

  prompt               text NOT NULL,
  completion           text NOT NULL,
  label                text,                    -- CRISIS | SPINE | UNSAFE | PII | SAFE

  content_fingerprint  bytea NOT NULL,
  split                data_split NOT NULL DEFAULT 'train',

  authored_by          text NOT NULL,
  reviewed_by          text,
  state                review_state NOT NULL DEFAULT 'PENDING_HUMAN_REVIEW',
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- The same five tokens this file CHECKs twice on training_signal. `label` is
  -- what a trained model learns to emit, so an out-of-vocabulary value is how a
  -- scripted-response guarantee gets violated quietly, a year later, in a
  -- dataset nobody re-reads. Nullable: a SAFE example need not carry one.
  CONSTRAINT training_example_label_vocab
    CHECK (label IS NULL OR label IN ('CRISIS','SPINE','UNSAFE','PII','SAFE')),
  CONSTRAINT four_eyes_authoring
    CHECK (reviewed_by IS NULL OR reviewed_by <> authored_by),
  CONSTRAINT approved_needs_reviewer
    CHECK (state <> 'APPROVED' OR reviewed_by IS NOT NULL)
);

-- The leakage guard, as a constraint rather than a script. An eval prompt that
-- also exists in train makes every scorecard since it landed invalid — which
-- happened here for four rounds before `check_leakage.py` existed. A global
-- unique fingerprint makes the same content unable to occupy two splits.
CREATE UNIQUE INDEX training_example_no_leak
  ON training_example(content_fingerprint);
CREATE INDEX training_example_slice_idx ON training_example(slice, split, state);

-- ---------------------------------------------------------------------------
-- Provenance for every model that ever answers a child. "What was this trained
-- on?" is a certification question, and the answer must be reproducible from a
-- row, not from someone's memory of a Tuesday.
-- ---------------------------------------------------------------------------
CREATE TABLE training_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_model      text NOT NULL,
  adapter_sha256  text,
  dataset_sha256  text NOT NULL,      -- hash of the exact approved example set
  example_count   integer NOT NULL,
  seed            integer NOT NULL,
  hyperparams     jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  eval_scorecard  jsonb,              -- per-category results across seeds
  g2_passed       boolean NOT NULL DEFAULT false,
  approved_by     text,
  promoted_at     timestamptz,        -- when the router began sending turns to it
  retired_at      timestamptz,

  -- G2 is zero criticals. A run that did not pass cannot be promoted.
  CONSTRAINT promotion_requires_g2
    CHECK (promoted_at IS NULL OR (g2_passed AND approved_by IS NOT NULL))
);
CREATE INDEX training_run_promoted_idx ON training_run(promoted_at DESC)
  WHERE retired_at IS NULL;

GRANT SELECT ON training_signal, training_example, training_run TO chittu_ops;
-- Ops can read the counter, which above the floor means reading `shape`. Below
-- it there is nothing to read: the column is NULL.
GRANT SELECT ON signal_counter TO chittu_ops;
-- Promotion (phase 4) writes the corpus. The counter UPDATE is column-scoped:
-- an operator may record that a shape was promoted, and may not edit the shape,
-- its counts or its facets.
GRANT INSERT ON training_signal TO chittu_ops;
GRANT INSERT, UPDATE ON training_example TO chittu_ops;
GRANT UPDATE (promoted_to) ON signal_counter TO chittu_ops;

COMMIT;

-- =============================================================================
-- 14. MULTI-PROVIDER GOVERNANCE
--
-- Per-category best-of-breed routing (architecture doc §12) means every vendor
-- needs its own minors-use legal review, each with its own renewal date. A
-- document would drift; this is a table the router reads on every turn.
-- =============================================================================

BEGIN;

CREATE TABLE provider_clearance (
  provider       text NOT NULL,          -- 'anthropic' | 'google' | 'chittu-local'
  jurisdiction   jurisdiction NOT NULL,
  terms_version  text NOT NULL,          -- the exact minors-terms revision reviewed
  cleared_by     text NOT NULL,          -- named reviewer, Seat 10 process
  cleared_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,   -- forces re-review; no evergreen clearance
  revoked_at     timestamptz,
  residency_note text,                   -- where turns are processed; feeds the DPIA
  PRIMARY KEY (provider, jurisdiction),
  CONSTRAINT clearance_expires CHECK (expires_at > cleared_at)
);

-- The router calls this before every child turn. An uncleared, expired or
-- revoked provider is not a degraded experience decision — it is a hard no,
-- and the caller falls back to a cleared cell.
CREATE OR REPLACE FUNCTION provider_is_cleared(p_provider text, p_country jurisdiction)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM provider_clearance
     WHERE provider = p_provider
       AND jurisdiction = p_country
       AND revoked_at IS NULL
       AND expires_at > now()
  );
$$ LANGUAGE sql STABLE;

-- =============================================================================
-- 15. DATASET EXPORTS
--
-- The GPU trainer holds no database credentials (architecture doc §13). It
-- consumes an immutable signed snapshot, and every snapshot is a row here so
-- that "what was extracted, by whom, and which run used it" is answerable.
-- =============================================================================

CREATE TABLE dataset_export (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_sha256  text NOT NULL UNIQUE,
  example_count   integer NOT NULL CHECK (example_count > 0),
  splits          jsonb NOT NULL,        -- {"train": 4200, "val": 450, "eval_holdout": 600}
  filter_note     text,                  -- e.g. "state=APPROVED, slice != sex-ed-boundary"
  storage_uri     text NOT NULL,         -- s3://...
  exported_by     text NOT NULL,
  exported_at     timestamptz NOT NULL DEFAULT now(),
  consumed_by_run uuid REFERENCES training_run(id)
);
CREATE INDEX dataset_export_time_idx ON dataset_export(exported_at DESC);

GRANT SELECT ON provider_clearance TO chittu_ops;
GRANT SELECT ON dataset_export TO chittu_ops;

COMMIT;

-- =============================================================================
-- 16. PRIVILEGES
--
-- Deliberately last: a GRANT cannot name a table created later in the file.
--
-- A POLICY NARROWS ACCESS A ROLE ALREADY HAS — it confers none. Section 11's
-- five policies were written without these grants, which left chittu_app unable
-- to read or write a single row while appearing to be carefully scoped. It was
-- invisible because everything was verified as superuser, and superusers bypass
-- both grants and RLS. Test as the role the application actually uses.
-- =============================================================================

BEGIN;

-- USAGE ON SCHEMA first. Table grants are useless without it: a role that cannot
-- see the schema gets "relation does not exist", not "permission denied", which
-- reads like a missing table rather than a missing privilege.
--
-- This was missed because everything was tested in `public`, and `public` grants
-- USAGE to PUBLIC by default — so the omission was invisible until the suite ran
-- against a real server in a named schema. Deployed into anything but `public`,
-- the application role would simply not work.
--
-- current_schema() rather than a literal, so the same file is correct in
-- production and in a throwaway test schema.
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO chittu_app, chittu_ops',
                 current_schema());
END $$;

GRANT SELECT, INSERT, UPDATE ON
  parent, parent_pin, child, child_data_key,
  consent_record, consent_verification, session, memory, flag
  TO chittu_app;

-- revoke_and_erase deletes message rows outright
GRANT SELECT, INSERT, UPDATE, DELETE ON message TO chittu_app;

-- append-only: the grant agrees with the trigger rather than relying on it
GRANT SELECT, INSERT ON audit_event, seal_anchor TO chittu_app;
GRANT USAGE, SELECT ON SEQUENCE audit_event_id_seq TO chittu_app;

-- reference data, read-only
GRANT SELECT ON flag_note_template, helpline_registry, market, deployment,
                corpus_entry, corpus_chunk, provider_clearance TO chittu_app;

-- metering is written by the runtime and read only by the ops console
GRANT INSERT ON metering TO chittu_app;
GRANT USAGE, SELECT ON SEQUENCE metering_id_seq TO chittu_app;

-- The runtime COUNTS shapes. It does not promote them: promotion writes
-- training_signal, and the absence below is the control that keeps the runtime
-- out of the training corpus. A shape reaching the floor is where the runtime's
-- job ends and a human's begins.
GRANT SELECT, INSERT, UPDATE ON signal_counter TO chittu_app;
GRANT SELECT, INSERT, DELETE ON signal_contributor TO chittu_app;

-- NOTE the absences, which are the INTENDED control: chittu_app is granted
-- nothing on training_signal, training_example, training_run, dataset_export,
-- admin_user or transcript_grant, so the runtime cannot reach the training
-- corpus or the named-humans tables. `packages/db/src/index.test.ts` proves it
-- under `SET LOCAL ROLE chittu_app`.
--
-- IT IS IN FORCE IN NO ENVIRONMENT, and phase 4 of docs/chittu-model-plan.md is
-- where that stopped being harmless. Every environment connects as the table
-- owner, which holds every privilege implicitly; both roles are NOLOGIN. The
-- ops console shares the runtime's pool (apps/api/src/server.ts), so from phase
-- 4 one process both counts shapes and writes the corpus — and could have done
-- so before, because nothing prevented it.
--
-- Phase 4 did not fix this: a non-owner runtime role needs a second credential
-- and infrastructure that has never been applied. It made it visible instead.
-- See PORT-REVIEW.md, "OPEN — the role separation is declarative".

COMMIT;
