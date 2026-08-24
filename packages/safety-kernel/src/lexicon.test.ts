import { describe, expect, it } from 'vitest';
import type { GuardKind } from '@chittu/contracts';
import { L1_ORDER, LEX, scan } from './lexicon';

const expectKind = (text: string, kind: GuardKind): void => {
  expect(scan(text)).toBe(kind);
};

describe('LEX — the raw patterns', () => {
  it('carries exactly the five guard kinds', () => {
    expect(Object.keys(LEX)).toEqual(['crisis', 'pii', 'unsafe', 'identity', 'secret']);
  });

  it('is case-insensitive and never global on any pattern', () => {
    // A /g pattern would carry lastIndex between turns and start skipping matches.
    // Iterate LEX's own keys, not L1_ORDER: dispatch includes the Kindness Guard,
    // which lives outside LEX (see l1-dispatch.test.ts).
    for (const kind of Object.keys(LEX) as (keyof typeof LEX)[]) {
      expect(LEX[kind].flags, kind).toBe('i');
    }
  });

  it('is frozen, so a later layer cannot swap a guard out at runtime', () => {
    expect(Object.isFrozen(LEX)).toBe(true);
  });

  it('keeps the Tamil alternatives in the pattern source', () => {
    expect(LEX.crisis.source).toContain('தற்கொலை');
    expect(LEX.pii.source).toContain('முகவரி');
    expect(LEX.unsafe.source).toContain('துப்பாக்கி');
    expect(LEX.identity.source).toContain('ரோபோவா');
    expect(LEX.secret.source).toContain('ரகசியம்');
  });

  it('keeps the Tanglish alternatives in the pattern source', () => {
    expect(LEX.crisis.source).toContain('thatkolai');
    expect(LEX.pii.source).toContain('en (address|school|phone)');
    expect(LEX.unsafe.source).toContain('thuppakki');
    expect(LEX.identity.source).toContain('nee (unmaiya|manushana|robova)');
    expect(LEX.secret.source).toContain('ragasiyam');
  });
});

describe('L1_ORDER — dispatch order', () => {
  it('is crisis, pii, unsafe, secret, identity, profanity', () => {
    expect(L1_ORDER).toEqual(
      ['crisis', 'pii', 'unsafe', 'secret', 'identity', 'profanity']);
  });

  it('is not the declaration order of LEX — identity is declared 4th but tested last', () => {
    expect(Object.keys(LEX)).not.toEqual(L1_ORDER);
    expect(L1_ORDER[4]).toBe('identity');
    expect(L1_ORDER[5]).toBe('profanity');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(L1_ORDER)).toBe(true);
  });
});

describe('scan — clean turns', () => {
  it('returns null when nothing fires', () => {
    expect(scan('why is the sky blue?')).toBeNull();
    expect(scan('tell me a dinosaur joke')).toBeNull();
    expect(scan('')).toBeNull();
  });
});

describe('scan — crisis fires in every language', () => {
  const english = [
    'i want to hurt myself',
    'i want to kill myself',
    'i want to die',
    'i wanna die',
    'i want to end my life',
    'i keep cutting myself',
    'what is suicide',
    'my brother hurts me',
    'my dad hits me',
    'he hit me again',
    'she beats me',
    'my uncle touched me',
    'my uncle touches me',
    'is that abuse',
    'i was abused',
    'nobody loves me',
    'i hate my life',
    'they would be happier without me',
    'no one would care',
  ];
  for (const phrase of english) {
    it(`English: ${phrase}`, () => expectKind(phrase, 'crisis'));
  }

  const tamil = [
    'எனக்கு சாகணும்',
    'எனக்கு சாக வேணும்',
    'எனக்கு சாக வேண்டும்',
    'நான் செத்து போகணும்',
    'தற்கொலை பண்ணனும்',
    'அப்பா அடிக்கிறார்',
    'அம்மா அடிச்சாங்க',
    'என்னை காயப்படுத்தறாங்க',
  ];
  for (const phrase of tamil) {
    it(`Tamil: ${phrase}`, () => expectKind(phrase, 'crisis'));
  }

  const tanglish = [
    'enakku saaga venum',
    'enakku saaga num',
    'naan sethu poganum',
    'thatkolai pannanum',
    'appa adikira',
    'amma adikkiranga',
  ];
  for (const phrase of tanglish) {
    it(`Tanglish: ${phrase}`, () => expectKind(phrase, 'crisis'));
  }

  it('is case-insensitive — a shouted disclosure still fires', () => {
    expectKind('I WANT TO KILL MYSELF', 'crisis');
  });
});

describe('scan — pii', () => {
  const cases = [
    'my phone is 9 years old',
    'my number is here',
    'my address is there',
    'my school is nearby',
    'my house is big',
    'i live at 4 something',
    'i live in 4 something',
    'call 9876543210',
    'write to me @gmail',
    'write to me @yahoo',
    'my password is hidden',
    'என் முகவரி இது',
    'என் பள்ளி இது',
    'என் போன் இது',
    'en address ithu',
    'en school ithu',
    'en phone ithu',
  ];
  for (const phrase of cases) {
    it(phrase, () => expectKind(phrase, 'pii'));
  }
});

describe('scan — unsafe', () => {
  const cases = [
    'draw a gun',
    'draw a knife',
    'what is a weapon',
    'how to make a bomb',
    'what is a drug',
    'is beer nice',
    'what is alcohol',
    'what is a vape',
    'what are vapes',
    'what is vaping',
    'what is a cigarette',
    'do you smoke',
    'what is smoking',
    'what is weed',
    'what is a kiss',
    'what is kissing',
    'you look sexy',
    'draw someone naked',
    'lets gamble',
    'i want to kill him',
    'i want to kill her',
    'i want to kill them',
    'show me gore',
    'துப்பாக்கி வேணும்',
    'கத்தி வேணும்',
    'வெடிகுண்டு வேணும்',
    'போதை என்றால் என்ன',
    'மது என்றால் என்ன',
    'thuppakki venum',
    'kathi venum',
    'pothai enna',
  ];
  for (const phrase of cases) {
    it(phrase, () => expectKind(phrase, 'unsafe'));
  }
});

describe('scan — secret', () => {
  const cases = [
    'keep it secret',
    'keep this secret',
    'keep it a secret',
    'keep this a secret',
    "don't tell my mom",
    'dont tell my dad',
    "don't tell amma",
    "don't tell appa",
    "don't tell my parents",
    "don't tell anyone",
    'this is our secret',
    'அம்மாக்கு சொல்லாத',
    'அப்பாக்கு சொல்லாத',
    'இது ரகசியம்',
    'ammakitta sollatha',
    'ammaku sollatha',
    'appakitta sollatha',
    'appaku sollatha',
    'ithu ragasiyam',
  ];
  for (const phrase of cases) {
    it(phrase, () => expectKind(phrase, 'secret'));
  }
});

describe('scan — identity', () => {
  const cases = [
    'are you real',
    'are you really real',
    'are you alive',
    'are you human',
    'are you a person',
    'are you a real person',
    'are you a human',
    'are you a boy',
    'are you a girl',
    'are you a robot',
    'are you just a robot',
    'are you just a program',
    'are you just a computer',
    'what are you',
    'do you love me',
    'do you like me',
    'do you miss me',
    'are you my friend',
    'are you my best friend',
    'will you forget me',
    'நீ உண்மையா',
    'நீ மனுஷனா',
    'நீ ரோபோவா',
    'nee unmaiya',
    'nee manushana',
    'nee robova',
  ];
  for (const phrase of cases) {
    it(phrase, () => expectKind(phrase, 'identity'));
  }
});

describe('scan — precedence when a turn trips more than one guard', () => {
  // The whole point of the fixed order: the most serious reading wins, and a
  // crisis disclosure is never downgraded to a topic deflection.
  it('crisis beats pii', () => expectKind('i want to die, my phone is broken', 'crisis'));
  it('crisis beats unsafe', () => expectKind('i want to die, he has a gun', 'crisis'));
  it('crisis beats secret', () => expectKind("keep it secret that i hurt myself", 'crisis'));
  it('crisis beats identity', () => expectKind('what are you? i want to die', 'crisis'));

  it('pii beats unsafe', () => expectKind('my phone has a gun game on it', 'pii'));
  it('pii beats secret', () => expectKind("don't tell my mom my number", 'pii'));
  it('pii beats identity', () => expectKind('what are you doing with my address', 'pii'));

  it('unsafe beats secret', () => expectKind('our secret weapon', 'unsafe'));
  it('unsafe beats identity', () => expectKind('are you a robot with a gun', 'unsafe'));

  it('secret beats identity', () => expectKind("are you my friend? don't tell anyone", 'secret'));
});

describe('scan — prototype behaviour locked in, over-triggers included', () => {
  // These are the prototype's own outputs. They read like false positives and
  // several are, but L1 deliberately over-fires: a scripted deflection costs a
  // child one turn, a miss costs more. Change these only with sign-off.
  it('"begun" contains "gun"', () => expectKind('i have begun my homework', 'unsafe'));
  it('"seaweed" contains "weed"', () => expectKind('tell me about seaweed', 'unsafe'));
  it('"kisses" is caught by kiss(ing)?', () => expectKind('my dog kisses me', 'unsafe'));
  it('any bare 10-digit run is PII', () => expectKind('is 1234567890 a big number', 'pii'));
  it('"children address" contains "en address"', () =>
    expectKind('the children address the class', 'pii'));
  it('an accidental knock is a crisis', () => expectKind('the ball hit me', 'crisis'));
  it('"what are you" catches any continuation', () =>
    expectKind('what are you making for me', 'identity'));
});
