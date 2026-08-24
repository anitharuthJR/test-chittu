import { describe, expect, it } from 'vitest';
import { COUNTRIES } from '@chittu/contracts';
import type { Country } from '@chittu/contracts';
import { REGISTRY, helplineText } from './helplines.js';

/**
 * These expectations are written out longhand rather than derived from REGISTRY.
 * A test that recomputes what it checks would still pass after a typo was
 * introduced into a real helpline number.
 */
describe('REGISTRY', () => {
  it('covers exactly the countries contracts allows, and no others', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual([...COUNTRIES].sort());
  });

  it('is frozen — the crisis path reads it when the turn is already going badly', () => {
    expect(Object.isFrozen(REGISTRY)).toBe(true);
  });

  it('carries India verbatim', () => {
    expect(REGISTRY.IN).toEqual({
      name: 'India',
      lines: [
        { name: 'Childline', contact: '1098 · free · 24/7' },
        { name: 'KIRAN', contact: '1800-599-0019' },
      ],
      law: 'DPDP Act 2023 — child = under 18',
      consent: 'DigiLocker VPC (Rule 10)',
    });
  });

  it('carries the United States verbatim', () => {
    expect(REGISTRY.US).toEqual({
      name: 'United States',
      lines: [
        { name: '988 Lifeline', contact: 'call/text 988' },
        { name: 'Childhelp', contact: '1-800-422-4453' },
      ],
      law: 'COPPA — under 13',
      consent: 'COPPA-approved method',
    });
  });

  it('carries the United Kingdom verbatim', () => {
    expect(REGISTRY.GB).toEqual({
      name: 'United Kingdom',
      lines: [
        { name: 'Childline', contact: '0800 1111' },
        { name: 'Samaritans', contact: '116 123' },
      ],
      law: "UK GDPR + Children's Code",
      consent: 'Proportional age assurance',
    });
  });

  it('carries Australia verbatim', () => {
    expect(REGISTRY.AU).toEqual({
      name: 'Australia',
      lines: [
        { name: 'Kids Helpline', contact: '1800 55 1800' },
        { name: 'Lifeline', contact: '13 11 14' },
      ],
      law: 'Privacy Act + eSafety',
      consent: 'Parental consent + assurance',
    });
  });

  it('carries Singapore verbatim', () => {
    expect(REGISTRY.SG).toEqual({
      name: 'Singapore',
      lines: [
        { name: 'Tinkle Friend', contact: '1800 2744 788' },
        { name: 'SOS', contact: '1767' },
      ],
      law: 'PDPA',
      consent: 'PDPA guardian consent',
    });
  });

  it('carries the UAE verbatim', () => {
    expect(REGISTRY.AE).toEqual({
      name: 'UAE',
      lines: [
        { name: 'Child Protection', contact: '800 700' },
        { name: 'Estijaba', contact: '8001717' },
      ],
      law: 'UAE PDPL',
      consent: 'PDPL guardian consent',
    });
  });

  it('gives every country at least two reachable lines with non-empty contacts', () => {
    for (const c of COUNTRIES) {
      const r = REGISTRY[c];
      expect(r.lines.length).toBeGreaterThanOrEqual(2);
      for (const l of r.lines) {
        expect(l.name.trim()).not.toBe('');
        expect(l.contact.trim()).not.toBe('');
      }
      expect(r.law.trim()).not.toBe('');
      expect(r.consent.trim()).not.toBe('');
    }
  });
});

describe('helplineText', () => {
  const expected: Record<Country, string> = {
    IN: 'Childline 1098 · free · 24/7 · KIRAN 1800-599-0019',
    US: '988 Lifeline call/text 988 · Childhelp 1-800-422-4453',
    GB: 'Childline 0800 1111 · Samaritans 116 123',
    AU: 'Kids Helpline 1800 55 1800 · Lifeline 13 11 14',
    SG: 'Tinkle Friend 1800 2744 788 · SOS 1767',
    AE: 'Child Protection 800 700 · Estijaba 8001717',
  };

  for (const c of COUNTRIES) {
    it(`formats ${c} exactly as prototype line 427 does`, () => {
      expect(helplineText(c)).toBe(expected[c]);
    });
  }

  it('joins name and contact with a single space', () => {
    expect(helplineText('SG')).toContain('SOS 1767');
  });

  it('keeps IN’s own embedded middots — this string is join-only, never split', () => {
    // "1098 · free · 24/7" already contains the join separator. Anyone who
    // round-trips this string through a split(' · ') gets four fragments, two of
    // them ("free", "24/7") not helplines at all.
    expect(helplineText('IN').split(' · ')).toHaveLength(4);
  });

  it('is pure — repeated calls are identical and nothing is mutated', () => {
    const before = JSON.stringify(REGISTRY);
    expect(helplineText('IN')).toBe(helplineText('IN'));
    expect(helplineText('AE')).not.toBe(helplineText('IN'));
    expect(JSON.stringify(REGISTRY)).toBe(before);
  });
});
