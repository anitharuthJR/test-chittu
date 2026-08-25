-- 0009 — the ops console can see and correct a family, and every time it does
-- there is a row saying who and why.
--
-- 0001 said, in a comment above its GRANT block: "The ops console never touches
-- child-scoped tables at all." That was true when it was written and is not any
-- more. `/ops/users` lists families — parent name and email, child first name,
-- band, and counts — and lets an operator correct a record or erase one.
--
-- THIS IS A DELIBERATE WIDENING AND IT SHOULD BE ARGUED WITH. Until now the
-- console could see aggregates and shapes; it could not see a person. Support
-- and debugging need to see a person, so it now can. What has NOT changed:
-- there is still no transcript, no memory fact, no flag note and no message
-- body anywhere on the console, `message` is still a table no ops query names,
-- and the k-anonymity floor on `/ops/signals` is untouched. The line moved from
-- "the console cannot identify a family" to "the console can identify a family
-- and cannot read what a child said".
--
-- WHAT THIS CHANGES IN PRACTICE TODAY: nothing about access. Every environment
-- still connects as the table owner, `chittu_ops` is still NOLOGIN, and `FORCE
-- ROW LEVEL SECURITY` is set nowhere — so the grants below are inert, exactly as
-- CLAUDE.md says. They are here because the GRANT block is a SPECIFICATION of
-- what a deployment would switch on, and a specification that no longer
-- describes the code is worse than none.
--
-- COLUMN-LEVEL, NOT TABLE-LEVEL. `GRANT SELECT ON parent` followed by
-- `REVOKE SELECT (col)` does NOT do what it reads like: Postgres keeps the
-- table-level privilege and warns that nothing could be revoked. So a column
-- the console has no use for is never granted in the first place. `email_hash`
-- is the one that matters: it is a blind index, and a role that can read one can
-- test a guessed email against every family. It is absent below, and the console
-- has no search box for the same reason.
--
-- `count(*)` still works: Postgres accepts it for a role holding SELECT on any
-- column of the table.
--
-- WHAT IS DELIBERATELY ABSENT ENTIRELY. No grant on `message` — `/ops/users`
-- never names that table, because turn counts come from the `session.msg_count`
-- counter instead. None on `parent_pin`, `consent_verification` or
-- `audit_event` either: an operator must not be able to read a PIN hash, and
-- must not be able to touch the seal chain. The absence is the control, the same
-- way `chittu_app` having nothing on `training_signal` is.

GRANT SELECT (id, created_at, locale, deleted_at, email_enc, display_name_enc)
  ON parent TO chittu_ops;
GRANT UPDATE (email_enc, email_hash, display_name_enc, locale)
  ON parent TO chittu_ops;

GRANT SELECT (id, parent_id, band, band_set_at, board, country, created_at,
              deleted_at, first_name_enc)
  ON child TO chittu_ops;
GRANT UPDATE (first_name_enc, band, band_set_at, board, country)
  ON child TO chittu_ops;

-- SELECT and INSERT, never UPDATE of a decided field: the ledger is append-only
-- and a band change writes a NEW version that supersedes the old row. The one
-- UPDATE the console needs is the supersession itself.
GRANT SELECT (id, parent_id, child_id, version, supersedes, jurisdiction, law,
              method, status, scopes, memory_on, learn_on, band, board, issued_at,
              expires_at, revoked_at, seal_hash, created_at, token_issued_at)
  ON consent_record TO chittu_ops;
GRANT INSERT ON consent_record TO chittu_ops;
GRANT UPDATE (status, token_hash, token_issued_at) ON consent_record TO chittu_ops;

-- The DEK, so a name can be decrypted for display and re-encrypted after an
-- edit. `wrapped_dek` is useless without the KMS CMK; the grant is what a
-- deployment would switch on, and the CMK policy is the control that matters.
GRANT SELECT ON child_data_key TO chittu_ops;

GRANT SELECT (id, child_id, consent_id, band, started_at, ended_at, ended_reason,
              crisis_lock, locked_at, unlocked_at, device_class, msg_count,
              spine_count, read_attempts, read_words, read_hits)
  ON session TO chittu_ops;

GRANT SELECT (id, child_id, category, since, announced_at, deleted_at, deleted_by)
  ON memory TO chittu_ops;

GRANT SELECT (id, child_id, session_id, kind, note_key, assist_topic, created_at,
              acknowledged_at)
  ON flag TO chittu_ops;

-- =============================================================================
-- The ops action log.
-- =============================================================================
--
-- WHY A TABLE AND NOT A LOG LINE. `provider_cell` already established the shape:
-- an operator change carries `changed_by` from the SESSION and a `reason` the
-- database refuses to accept as blank, because the reason is the field an
-- incident review reads. Editing or erasing a family is a larger act than
-- changing a routing cell and deserves at least the same record. A log line
-- rotates; this does not.
--
-- APPEND-ONLY BY GRANT: `chittu_ops` may INSERT and SELECT, and holds no UPDATE
-- and no DELETE. An operator cannot edit their own trail.
--
-- WHAT IT DOES NOT STORE: the old value or the new value. An audit row that
-- carried "email changed from a@… to b@…" would be a plaintext copy of the one
-- adult identifier we hold, sitting in a table with no DEK and no shred path —
-- so revoking a family would leave their email behind in the audit. The row
-- says WHICH FIELDS changed, not what they became. `subject_id` is a uuid, and
-- the erase path leaves it pointing at a row that no longer exists, which is
-- the correct residue: proof an erasure happened, and nothing about who it was.
CREATE TABLE ops_action (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,                 -- the operator TOKEN's name, never a form field
  action      text NOT NULL,
  subject     text NOT NULL,                 -- 'parent' | 'child'
  subject_id  uuid NOT NULL,
  fields      text[] NOT NULL DEFAULT '{}',  -- which fields moved, never their values
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_action_known    CHECK (action IN ('EDIT_PARENT','EDIT_CHILD','ERASE_CHILD')),
  CONSTRAINT ops_action_subject  CHECK (subject IN ('parent','child')),
  -- Same floor as provider_cell.reason. Eight characters is not a good reason,
  -- but it is enough to stop the empty string, and the empty string is what a
  -- hurried operator types.
  CONSTRAINT ops_action_reasoned CHECK (length(btrim(reason)) >= 8),
  CONSTRAINT ops_action_actor    CHECK (length(btrim(actor)) > 0)
);
CREATE INDEX ops_action_recent_idx ON ops_action (created_at DESC, id DESC);
CREATE INDEX ops_action_subject_idx ON ops_action (subject_id, created_at DESC);

GRANT SELECT, INSERT ON ops_action TO chittu_ops;
GRANT USAGE, SELECT ON SEQUENCE ops_action_id_seq TO chittu_ops;
