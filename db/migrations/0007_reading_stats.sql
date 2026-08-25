-- migrate:up
-- =============================================================================
-- 0007_reading_stats — three counters for D5's "reading accuracy" stat.
--
-- The reading coach (D2 RM→RC) scores a read-aloud attempt server-side with a
-- deterministic local scorer. What the dashboard needs from that is an
-- accuracy figure, and these columns are the ONLY thing the feature stores
-- beyond the ordinary message rows: an attempt count, a word count, a hit
-- count. Aggregates, not words — there is no path from here back to what a
-- child read or misread, which is why they can live beside msg_count rather
-- than inside runtime_enc.
--
-- Incremented, never set (the msg_count pattern), so a concurrent turn cannot
-- clobber a sibling's update.
--
-- The audio behind these numbers never existed server-side: the browser
-- transcribes and discards, and only text reaches the API.
-- =============================================================================

ALTER TABLE session
  ADD COLUMN read_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN read_words    integer NOT NULL DEFAULT 0,
  ADD COLUMN read_hits     integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN session.read_attempts IS
  'Reading-coach attempts scored in this session. Guarded turns never count.';
COMMENT ON COLUMN session.read_words IS
  'Total passage words across scored attempts. Never the words themselves.';
COMMENT ON COLUMN session.read_hits IS
  'Passage words the local scorer marked heard. read_hits <= read_words.';
