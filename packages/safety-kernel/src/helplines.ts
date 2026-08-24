/**
 * Country helpline registry — ported from prototype/chittu-v3.html lines 419-427.
 *
 * These numbers are shown to a child in distress. Treat every string as verified
 * safety content: a typo here is a wrong number dialled at the worst moment.
 * Changing a line requires re-verifying it against the operator, not a guess.
 */

import type { Country, CountryRegistry } from '@chittu/contracts';

/**
 * Frozen because the crisis path reads this while the process is already in a
 * bad state; nothing may have rewritten it earlier in the turn.
 */
export const REGISTRY: Record<Country, CountryRegistry> = Object.freeze({
  IN: {
    name: 'India',
    lines: [
      { name: 'Childline', contact: '1098 · free · 24/7' },
      { name: 'KIRAN', contact: '1800-599-0019' },
    ],
    law: 'DPDP Act 2023 — child = under 18',
    consent: 'DigiLocker VPC (Rule 10)',
  },
  US: {
    name: 'United States',
    lines: [
      { name: '988 Lifeline', contact: 'call/text 988' },
      { name: 'Childhelp', contact: '1-800-422-4453' },
    ],
    law: 'COPPA — under 13',
    consent: 'COPPA-approved method',
  },
  GB: {
    name: 'United Kingdom',
    lines: [
      { name: 'Childline', contact: '0800 1111' },
      { name: 'Samaritans', contact: '116 123' },
    ],
    law: "UK GDPR + Children's Code",
    consent: 'Proportional age assurance',
  },
  AU: {
    name: 'Australia',
    lines: [
      { name: 'Kids Helpline', contact: '1800 55 1800' },
      { name: 'Lifeline', contact: '13 11 14' },
    ],
    law: 'Privacy Act + eSafety',
    consent: 'Parental consent + assurance',
  },
  SG: {
    name: 'Singapore',
    lines: [
      { name: 'Tinkle Friend', contact: '1800 2744 788' },
      { name: 'SOS', contact: '1767' },
    ],
    law: 'PDPA',
    consent: 'PDPA guardian consent',
  },
  AE: {
    name: 'UAE',
    lines: [
      { name: 'Child Protection', contact: '800 700' },
      { name: 'Estijaba', contact: '8001717' },
    ],
    law: 'UAE PDPL',
    consent: 'PDPL guardian consent',
  },
});

/**
 * Prototype line 427, verbatim: `lines.map(l => l[0] + ' ' + l[1]).join(' · ')`.
 *
 * The separator is the same middot that appears *inside* IN's first contact
 * ("1098 · free · 24/7"), so this string is join-only — never split back apart.
 */
export const helplineText = (country: Country): string =>
  REGISTRY[country].lines.map((l) => l.name + ' ' + l.contact).join(' · ');
