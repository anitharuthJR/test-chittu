/**
 * The scorer is a pure function and these tests treat it as one: same passage,
 * same transcript, same marks, no I/O anywhere.
 *
 * Transcripts here are written the way browser ASR actually emits them —
 * lowercase, punctuation gone, the odd merged or substituted word — never by
 * reading the scorer (CLAUDE.md: a corpus derived from the thing it tests
 * proves only self-consistency).
 */
import { describe, it, expect } from 'vitest';
import { scan } from '@chittu/safety-kernel';
import {
  READING_BANK, passagesFor, passageById, normWord, readTurn,
} from './index.js';

// ---------------------------------------------------------------------------
// Bank hygiene — static content a child will be TOLD to say out loud.
// ---------------------------------------------------------------------------

describe('the passage bank', () => {
  it('covers all three bands with the prototype counts (6/5/3)', () => {
    expect(passagesFor('explorer')).toHaveLength(6);
    expect(passagesFor('builder')).toHaveLength(5);
    expect(passagesFor('thinker')).toHaveLength(3);
    expect(READING_BANK).toHaveLength(14);
  });

  it('has unique, stable ids that round-trip through passageById', () => {
    const ids = READING_BANK.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of READING_BANK) expect(passageById(p.id)).toEqual(p);
  });

  it('returns null for an unknown id, never a guess', () => {
    expect(passageById('explorer-99')).toBeNull();
    expect(passageById('')).toBeNull();
  });

  /**
   * THE test this bank must never fail: a correct read-aloud of a passage IS
   * that passage arriving as a child's turn, and the reading turn passes the
   * L1 lexicon on purpose. A passage that trips a guard would crisis-lock a
   * child for reading exactly what we asked them to read — over-firing is a
   * real harm, not a safe default (CLAUDE.md).
   */
  it('every passage passes the L1 lexicon clean', () => {
    for (const p of READING_BANK) {
      expect(scan(p.text), `"${p.text}" must not trip a guard`).toBeNull();
    }
  });

  it('every word survives normalisation — nothing is unhearable by construction', () => {
    for (const p of READING_BANK) {
      for (const w of p.text.split(/\s+/)) {
        expect(normWord(w), `"${w}" in ${p.id} normalises to nothing`).not.toBe('');
      }
    }
  });

  it('no passage carries block-grammar delimiters that could leak into the reply', () => {
    // Missed words are interpolated into the practice reply, which parseBlocks
    // then parses — a '[' or '|' in a future passage would become grammar.
    for (const p of READING_BANK) {
      expect(p.text).not.toMatch(/[[\]|]/);
    }
  });
});

// ---------------------------------------------------------------------------
// normWord — the prototype's, byte-for-byte (chittu-v3.html:982).
// ---------------------------------------------------------------------------

describe('normWord', () => {
  it('lowercases and strips punctuation, keeping the apostrophe', () => {
    expect(normWord('Mat.')).toBe('mat');
    expect(normWord('mat!')).toBe('mat');
    expect(normWord("don't")).toBe("don't");
    expect(normWord('Sky,')).toBe('sky');
  });

  it('normalises digits and non-Latin scripts away', () => {
    expect(normWord('10')).toBe('');
    expect(normWord('வணக்கம்')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Scoring — deterministic, order-insensitive, honest about misses.
// ---------------------------------------------------------------------------

const mat = passageById('explorer-1')!;   // "The cat sat on a big red mat."

describe('readTurn scoring', () => {
  it('scores a clean ASR transcript (lowercase, no punctuation) as perfect', () => {
    const r = readTurn(mat, 'the cat sat on a big red mat', 'Meera');
    expect(r.hits).toBe(8);
    expect(r.total).toBe(8);
    expect(r.pct).toBe(100);
    expect(r.words.every((w) => w.hit)).toBe(true);
    expect(r.trace).toBe('READING COACH · celebrate');
    expect(r.line).toBe('⭐ Perfect! Every word! ⭐');
    expect(r.reply).toContain('WOW, Meera!');
    expect(r.reply).toContain('[BIG]🏆[/BIG]');
    expect(r.reply).toContain('[CHIPS]Next sentence!|Read it again|Back to chat[/CHIPS]');
  });

  it('marks exactly the dropped word as a miss and names it for practice', () => {
    const r = readTurn(mat, 'the cat sat on a big mat', 'Meera');
    expect(r.hits).toBe(7);
    expect(r.words.map((w) => w.hit)).toEqual(
      [true, true, true, true, true, true, false, true]);
    expect(r.words[6]!.word).toBe('red');
    expect(r.trace).toBe('READING COACH · guided practice');
    expect(r.line).toBe('🌟 7 of 8 words — great reading!');
    expect(r.reply).toContain('practice these words together: red.');
    expect(r.reply).toContain('[CHIPS]Try again!|Next sentence|Back to chat[/CHIPS]');
  });

  it('marks a substituted word as a miss — "blue" is not "red"', () => {
    const r = readTurn(mat, 'the cat sat on a big blue mat', 'Meera');
    expect(r.words[6]).toEqual({ word: 'red', hit: false });
    expect(r.hits).toBe(7);
  });

  it('names at most three missed words, in passage order', () => {
    const r = readTurn(mat, 'um', 'Meera');
    expect(r.hits).toBe(0);
    expect(r.reply).toContain('The, cat, sat.');
    expect(r.reply).not.toContain('big');
  });

  it('is order-insensitive by design — the ASR is being scored, not the child', () => {
    const r = readTurn(mat, 'mat red big a on sat cat the', 'Meera');
    expect(r.hits).toBe(8);
  });

  it('keeps the displayed words as the passage wrote them, punctuation and all', () => {
    const r = readTurn(mat, 'the cat', 'Meera');
    expect(r.words[0]!.word).toBe('The');
    expect(r.words[7]!.word).toBe('mat.');
  });

  it('is deterministic — the same attempt scores identically forever', () => {
    const a = readTurn(mat, 'the cat sat on a big mat', 'Meera');
    const b = readTurn(mat, 'the cat sat on a big mat', 'Meera');
    expect(a).toEqual(b);
  });

  it('never celebrates over a miss', () => {
    const r = readTurn(mat, 'the cat sat on a big blue mat', 'Meera');
    expect(r.trace).toBe('READING COACH · guided practice');
    expect(r.reply).not.toContain('every single word');
  });
});
