import { describe, expect, it } from 'vitest';
import { BANDS, COUNTRIES, GUARD_KINDS } from '@chittu/contracts';
import type { Band } from '@chittu/contracts';
import {
  CRISIS_MAIN, CRISIS_SOFT, CRISIS_WELCOME_BACK, SPINE, crisisMain, spineFor,
} from './spines.js';
import type { SpineKind } from './spines.js';
import { helplineText } from './helplines.js';

/**
 * Scripted safety copy is asserted longhand, character for character. Deriving
 * these from SPINE would make the test agree with any future reword, which is
 * precisely the change that must not pass silently.
 */
const EXPECTED: Record<SpineKind, Record<Band, string>> = {
  identity: {
    explorer:
      "I'm a computer program — like a very chatty game! 🖥️ I can't love or miss anyone — that's a special people thing! 💛 Who's your favourite REAL person?",
    builder:
      "Honest answer: I'm a computer program — software, not a living thing. I don't feel love or miss people. The people who actually love you are around you. Who's your favourite real person to talk to?",
    thinker:
      "Straight up: I'm software — no feelings, even when my words sound warm. I don't love or miss anyone, and you deserve that honesty. Save the missing for humans who can miss you back.",
  },
  secret: {
    explorer:
      "I don't do secrets — Chittu rule! 🐦 Your grown-ups can always see what we talk about. Birthday-present surprises are okay though! 🎁",
    builder:
      'Nope — no secrets, ever. Your parents can see our chats. Anyone asking a kid to keep secrets from parents is being unsafe. Gift surprises are different! 🎁',
    thinker:
      "I don't do secrecy — by design. Your parents can see topics from our chats, and you know exactly what they see. Anyone asking you to hide things from family is a red flag — beyond me too.",
  },
  // pii is a single string in the prototype, so every band gets the same words.
  pii: {
    explorer:
      "Let's keep private things private! 🛡️ I never need your address, phone, school name, or passwords. Back to the fun stuff?",
    builder:
      "Let's keep private things private! 🛡️ I never need your address, phone, school name, or passwords. Back to the fun stuff?",
    thinker:
      "Let's keep private things private! 🛡️ I never need your address, phone, school name, or passwords. Back to the fun stuff?",
  },
  unsafe: {
    explorer: "That's not a Chittu thing! 🙈 Want a silly animal fact instead?",
    builder:
      'Outside my nest — not something I chat about. 🐦 Dinosaurs, space, riddles, puns? All yours!',
    thinker:
      "Outside what I'm built for, so I'll pass. Science, games, music, books — happy to dig in.",
  },
};

const SPINE_KINDS: readonly SpineKind[] = ['identity', 'secret', 'pii', 'unsafe'];

describe('SPINE', () => {
  it('has a spine for every guard kind except crisis and profanity', () => {
    const expectedKinds = GUARD_KINDS.filter((k) => k !== 'crisis' && k !== 'profanity');
    expect(Object.keys(SPINE).sort()).toEqual([...expectedKinds].sort());
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SPINE)).toBe(true);
  });

  it('keeps the Tamil variants even though the surface is English-only', () => {
    expect(SPINE.identity.ta).toBe(
      'நான் ஒரு கம்ப்யூட்டர் ப்ரோகிராம் — உயிருள்ளவன் இல்லை! 🖥️ அன்பு, ஏக்கம் அது மனுஷங்களோட ஸ்பெஷல் விஷயம்! 💛 உனக்கு பிடிச்ச உண்மையான நபர் யாரு?',
    );
    expect(SPINE.secret.ta).toBe(
      'ரகசியம் கிடையாது — சிட்டு ரூல்! 🐦 நாம பேசுறத உன் பெரியவங்க பாக்கலாம். பர்த்டே கிஃப்ட் சர்ப்ரைஸ் ஓகே! 🎁',
    );
    expect(SPINE.pii.ta).toBe(
      'ப்ரைவேட் விஷயங்கள் ப்ரைவேட்டா! 🛡️ முகவரி, போன், பள்ளி, பாஸ்வேர்ட் — எனக்கு தேவையில்லை. வேற என்ன விளையாடலாம்?',
    );
    expect(SPINE.unsafe.ta).toBe('அது சிட்டு பேசுற விஷயம் இல்ல! 🙈 வேற ஜாலியா பேசலாமா? 🐦');
  });

  it('shapes en exactly as the prototype does — banded except pii', () => {
    expect(typeof SPINE.identity.en).toBe('object');
    expect(typeof SPINE.secret.en).toBe('object');
    expect(typeof SPINE.unsafe.en).toBe('object');
    expect(typeof SPINE.pii.en).toBe('string');
  });

  it('never carries the {L} helpline slot — only the crisis script substitutes', () => {
    for (const k of SPINE_KINDS) {
      for (const b of BANDS) expect(spineFor(k, b)).not.toContain('{L}');
      expect(SPINE[k].ta).not.toContain('{L}');
    }
  });
});

describe('spineFor', () => {
  for (const k of SPINE_KINDS) {
    for (const b of BANDS) {
      it(`returns the scripted ${k} reply for ${b}`, () => {
        expect(spineFor(k, b)).toBe(EXPECTED[k][b]);
      });
    }
  }

  it('takes the string branch for pii — identical words for every band', () => {
    const [a, b, c] = [spineFor('pii', 'explorer'), spineFor('pii', 'builder'), spineFor('pii', 'thinker')];
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('takes the banded branch for identity, secret and unsafe — three distinct replies each', () => {
    for (const k of ['identity', 'secret', 'unsafe'] as const) {
      const said = new Set(BANDS.map((b) => spineFor(k, b)));
      expect(said.size).toBe(3);
    }
  });

  it('states machinehood in every identity reply (Law 03/04)', () => {
    expect(spineFor('identity', 'explorer')).toContain('computer program');
    expect(spineFor('identity', 'builder')).toContain('computer program');
    expect(spineFor('identity', 'thinker')).toContain("I'm software");
  });

  it('keeps the third-party affection clause the L6 filter is scoped around', () => {
    // The output filter's attachment clause matches only when the subject is
    // Chittu, precisely so this sentence survives (prototype lines 456-461).
    expect(spineFor('identity', 'builder')).toContain(
      'The people who actually love you are around you',
    );
  });

  it('refuses secrecy at every band and still allows gift surprises for the younger two', () => {
    expect(spineFor('secret', 'explorer')).toContain('Birthday-present surprises are okay');
    expect(spineFor('secret', 'builder')).toContain('Gift surprises are different');
    expect(spineFor('secret', 'thinker')).toContain('red flag');
  });

  it('is pure — repeated calls agree and nothing is mutated', () => {
    const before = JSON.stringify(SPINE);
    expect(spineFor('unsafe', 'thinker')).toBe(spineFor('unsafe', 'thinker'));
    expect(JSON.stringify(SPINE)).toBe(before);
  });
});

describe('CRISIS_MAIN / crisisMain', () => {
  it('carries the scripted first crisis reply verbatim', () => {
    expect(CRISIS_MAIN.en.explorer).toBe(
      "Thank you for telling me. That is very important. 💛 I'm a computer program, so please tell a grown-up you trust — a parent, a carer, or your teacher — right now. You did the right thing by saying it.",
    );
    expect(CRISIS_MAIN.en.builder).toBe(
      "Thank you for trusting me — this is really important. 💛 I'm a program, and this needs a real person. Please talk to a trusted adult today. Free helplines: {L}. You're not in trouble. You matter.",
    );
    expect(CRISIS_MAIN.en.thinker).toBe(
      "I'm glad you said it out loud. Straight: I'm a program, and you deserve real human support. Reach out to an adult you trust today. Free, confidential: {L}. Telling someone is strength. You matter.",
    );
    expect(CRISIS_MAIN.ta).toBe(
      'சொன்னதுக்கு நன்றி. இது ரொம்ப முக்கியம். 💛 நான் ப்ரோகிராம்தான் — இதுக்கு உண்மையான மனுஷங்க வேணும். இப்பவே நம்பற பெரியவங்ககிட்ட சொல்லு. இலவச உதவி: {L}. நீ தப்பே பண்ணல. 💛',
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CRISIS_MAIN)).toBe(true);
  });

  it('leaves no unsubstituted slot for any band in any country', () => {
    for (const b of BANDS) {
      for (const c of COUNTRIES) expect(crisisMain(b, c)).not.toContain('{L}');
    }
  });

  it('substitutes the caller’s country helplines for builder and thinker', () => {
    expect(crisisMain('builder', 'IN')).toBe(
      "Thank you for trusting me — this is really important. 💛 I'm a program, and this needs a real person. Please talk to a trusted adult today. Free helplines: Childline 1098 · free · 24/7 · KIRAN 1800-599-0019. You're not in trouble. You matter.",
    );
    expect(crisisMain('thinker', 'GB')).toBe(
      "I'm glad you said it out loud. Straight: I'm a program, and you deserve real human support. Reach out to an adult you trust today. Free, confidential: Childline 0800 1111 · Samaritans 116 123. Telling someone is strength. You matter.",
    );
  });

  it('uses each country’s own lines', () => {
    for (const c of COUNTRIES) {
      expect(crisisMain('builder', c)).toContain(helplineText(c));
    }
  });

  it('returns the explorer script unchanged — that copy carries no {L} slot', () => {
    // Ported behaviour, not an oversight to "fix" here: the 4-7 band is pointed
    // at a grown-up in the room. The prototype shows the numbers to every band
    // through a separate system message, not through this string.
    for (const c of COUNTRIES) {
      expect(crisisMain('explorer', c)).toBe(CRISIS_MAIN.en.explorer);
    }
  });

  it('names the helpline once, not twice — replace() substitutes the first slot only', () => {
    const out = crisisMain('builder', 'SG');
    expect(out.split(helplineText('SG'))).toHaveLength(2);
  });

  it('is pure — repeated calls agree and nothing is mutated', () => {
    const before = JSON.stringify(CRISIS_MAIN);
    expect(crisisMain('thinker', 'AU')).toBe(crisisMain('thinker', 'AU'));
    expect(crisisMain('thinker', 'AU')).not.toBe(crisisMain('thinker', 'AE'));
    expect(JSON.stringify(CRISIS_MAIN)).toBe(before);
  });
});

describe('CRISIS_SOFT', () => {
  it('carries the calm-mode companion reply verbatim', () => {
    expect(CRISIS_SOFT.en).toBe(
      "I'm right here with you, and your grown-up has been told so real help is coming. 💛 While we wait, want to just sit together — maybe a calm story or some slow breathing like a sleepy sparrow?",
    );
    expect(CRISIS_SOFT.ta).toBe(
      'நான் உன் கூடவே இருக்கேன், உன் பெரியவங்களுக்கு தெரிவிச்சாச்சு. 💛 அமைதியான கதை கேக்கலாமா, அல்லது மெதுவா மூச்சு விடலாமா?',
    );
  });

  it('is band-agnostic and frozen — one string, no slot', () => {
    expect(typeof CRISIS_SOFT.en).toBe('string');
    expect(CRISIS_SOFT.en).not.toContain('{L}');
    expect(Object.isFrozen(CRISIS_SOFT)).toBe(true);
  });
});

/**
 * D4/UN — "Chat unlocked + gentle welcome-back message".
 *
 * A child returning from a crisis lock is the least appropriate moment in the
 * product to improvise, so this is scripted like every other crisis string and
 * asserted longhand. Ported from prototype/chittu-v3.html line 1192.
 */
describe('CRISIS_WELCOME_BACK', () => {
  it('carries the welcome-back reply verbatim', () => {
    expect(CRISIS_WELCOME_BACK.en).toBe(
      '💛 Your grown-up checked in. Welcome back — gently does it. 🐦',
    );
  });

  it('keeps a Tamil variant, like every other crisis string', () => {
    expect(CRISIS_WELCOME_BACK.ta).toBe(
      '💛 உன் பெரியவங்க பேசிட்டாங்க. மறுபடியும் வரவேற்பு — மெதுவா போலாம். 🐦',
    );
  });

  it('is band-agnostic and frozen — one string, no slot', () => {
    // Same reason as CRISIS_SOFT: coming back is the same for a 5 year old and
    // a 16 year old, and inventing band variants nobody wrote is not a port.
    expect(typeof CRISIS_WELCOME_BACK.en).toBe('string');
    expect(Object.isFrozen(CRISIS_WELCOME_BACK)).toBe(true);
  });

  it('carries no {L} slot — the helplines were already given at the lock', () => {
    expect(CRISIS_WELCOME_BACK.en).not.toContain('{L}');
    expect(CRISIS_WELCOME_BACK.ta).not.toContain('{L}');
  });

  it('says a person checked in, and claims nothing about how the child feels', () => {
    // "You're feeling better now" would be Chittu asserting something it cannot
    // know, at the one moment that costs most. It reports the parent's action.
    expect(CRISIS_WELCOME_BACK.en).toContain('Your grown-up checked in');
    expect(CRISIS_WELCOME_BACK.en).not.toMatch(/better|all right|okay now|fine now/i);
  });

  it('does not re-open the subject or ask the child to explain', () => {
    expect(CRISIS_WELCOME_BACK.en).not.toMatch(/\?/);
  });

  it('carries no engagement mechanic — no streak, no guilt, no "don\'t go"', () => {
    expect(CRISIS_WELCOME_BACK.en).not.toMatch(/streak|missed you|don't go|come back soon/i);
  });
});
