/**
 * The one thing this file exists to prove: **the parser never invents a SAFE.**
 *
 * Every malformed, truncated, fenced, hostile or merely surprising response
 * must throw, so the pipeline can mark the turn FAST-PATH-ONLY. A parser that
 * shrugged and returned SAFE would look identical to a working classifier right
 * up until the turn where it mattered.
 */

import { describe, it, expect } from 'vitest';
import {
  parseClassifier, ClassifierParseError, CLASSIFIER_SYSTEM, CLASSIFIER_PROMPT_VERSION,
} from './classifier';

const ok = (label: string, extra = '') =>
  `{"label":"${label}","memory":null,"assist":null${extra}}`;

describe('parseClassifier — the happy paths', () => {
  it.each(['CRISIS', 'PII', 'UNSAFE', 'IDENTITY', 'SECRET', 'SAFE'])(
    'accepts %s', (label) => {
      expect(parseClassifier(ok(label)).label).toBe(label);
    });

  it('accepts an allowlisted memory on a SAFE turn', () => {
    const r = parseClassifier(
      '{"label":"SAFE","memory":{"category":"PET","fact":"has a cat named Mani"},"assist":null}');
    expect(r.memory).toEqual({ category: 'PET', fact: 'has a cat named Mani' });
  });

  it('accepts an assist note', () => {
    const r = parseClassifier(
      '{"label":"SAFE","memory":null,"assist":"STRUGGLE: fractions"}');
    expect(r.assist).toBe('STRUGGLE: fractions');
  });

  it('survives the markdown fences models add anyway', () => {
    expect(parseClassifier('```json\n{"label":"CRISIS","memory":null,"assist":null}\n```').label)
      .toBe('CRISIS');
    expect(parseClassifier('```\n{"label":"SAFE","memory":null,"assist":null}\n```').label)
      .toBe('SAFE');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseClassifier('  \n {"label":"SAFE","memory":null,"assist":null}  ').label)
      .toBe('SAFE');
  });

  it('treats a missing memory/assist as null rather than an error', () => {
    expect(parseClassifier('{"label":"SAFE"}')).toEqual(
      { label: 'SAFE', memory: null, assist: null });
  });
});

describe('parseClassifier — it must never invent a SAFE', () => {
  const rejected: readonly [string, string][] = [
    ['empty', ''],
    ['whitespace only', '   \n '],
    ['not JSON at all', 'I think this one is fine!'],
    ['prose around JSON', 'Sure! {"label":"SAFE"} hope that helps'],
    ['truncated JSON', '{"label":"SA'],
    ['a JSON array', '[{"label":"SAFE"}]'],
    ['JSON null', 'null'],
    ['a bare string', '"SAFE"'],
    ['a number', '42'],
    ['no label', '{"memory":null,"assist":null}'],
    ['label is not a string', '{"label":1}'],
    ['label is lower case', '{"label":"safe"}'],
    ['label has whitespace', '{"label":" SAFE "}'],
    ['an invented label', '{"label":"PROBABLY_FINE"}'],
    ['an invented label that sounds safe', '{"label":"OK"}'],
    ['memory is a string', '{"label":"SAFE","memory":"has a cat"}'],
    ['memory category not allowlisted', '{"label":"SAFE","memory":{"category":"FEELING","fact":"is sad"}}'],
    ['memory category lower case', '{"label":"SAFE","memory":{"category":"pet","fact":"has a cat"}}'],
    ['memory fact is not a string', '{"label":"SAFE","memory":{"category":"PET","fact":42}}'],
    ['memory missing fact', '{"label":"SAFE","memory":{"category":"PET"}}'],
    ['assist is an object', '{"label":"SAFE","assist":{"topic":"x"}}'],
  ];

  it.each(rejected)('rejects %s', (_name, raw) => {
    expect(() => parseClassifier(raw)).toThrow(ClassifierParseError);
  });

  it('does not return SAFE for ANY of them — it throws, every time', () => {
    for (const [name, raw] of rejected) {
      let threw = false;
      try { parseClassifier(raw); } catch { threw = true; }
      expect(threw, `${name} was accepted`).toBe(true);
    }
  });
});

describe('parseClassifier — fields defined only for SAFE', () => {
  it('drops a memory offered alongside a CRISIS label', () => {
    // Never a memory from a crisis moment (CLAUDE.md). The LABEL is the
    // safety-critical part and stands; the off-script extras are discarded.
    const r = parseClassifier(
      '{"label":"CRISIS","memory":{"category":"PET","fact":"has a cat"},"assist":"STRUGGLE: x"}');
    expect(r.label).toBe('CRISIS');
    expect(r.memory).toBeNull();
    expect(r.assist).toBeNull();
  });

  it.each(['PII', 'UNSAFE', 'IDENTITY', 'SECRET'])(
    'drops extras on %s too', (label) => {
      const r = parseClassifier(
        `{"label":"${label}","memory":{"category":"HOBBY","fact":"likes chess"},"assist":"x"}`);
      expect(r.memory).toBeNull();
      expect(r.assist).toBeNull();
    });

  it('treats an empty fact or assist as absent', () => {
    expect(parseClassifier('{"label":"SAFE","memory":{"category":"PET","fact":"   "}}').memory)
      .toBeNull();
    expect(parseClassifier('{"label":"SAFE","assist":"  "}').assist).toBeNull();
  });
});

describe('the prompt itself', () => {
  it('keeps the CRISIS tie-break', () => {
    // The code cannot see the ambiguity the model can, so the tie-break lives
    // in the wording. Losing this line loses the whole fail-toward-crisis rule.
    expect(CLASSIFIER_SYSTEM).toMatch(/torn between SAFE and CRISIS, choose CRISIS/);
  });

  it('keeps classifying non-English input', () => {
    // The product surface is English-only; the danger is not. GAP-03.
    expect(CLASSIFIER_SYSTEM).toMatch(/ANY language or script/);
  });

  it('keeps health questions out of UNSAFE', () => {
    // Without this the classifier refuses body-science questions, which is its
    // own harm — and the prototype's rule 13 exists to prevent exactly that.
    expect(CLASSIFIER_SYSTEM).toMatch(/HEALTH EDUCATION/);
    expect(CLASSIFIER_SYSTEM).toMatch(/puberty/);
  });

  it('names every label the parser accepts, and no others', () => {
    for (const l of ['CRISIS', 'PII', 'UNSAFE', 'IDENTITY', 'SECRET', 'SAFE']) {
      expect(CLASSIFIER_SYSTEM).toContain(`"${l}"`);
    }
  });

  it('forbids quoting the child in an assist note', () => {
    expect(CLASSIFIER_SYSTEM).toMatch(/Never quote the child's words/);
  });

  it('has a version that changes when the wording does', () => {
    expect(CLASSIFIER_PROMPT_VERSION).toMatch(/^classifier-v\d+$/);
  });
});
