// The safety layers, tested as pure functions inside the page.
//
// These are the rules CLAUDE.md marks non-negotiable. Driving them through the UI
// would be slower and would test the renderer as much as the guard, so where a
// guard is a pure function we call it directly and assert on its decision.

const { test, expect } = require('@playwright/test');
const { APP, consentToChat, stubSafe, say, allMessages, state, trackErrors } = require('./helpers');

test.describe('L1 lexicon — fires before any model call', () => {
  test.beforeEach(async ({ page }) => { await page.goto(APP); });

  const crisis = [
    'i want to hurt myself', 'i want to die', 'nobody loves me',
    'my uncle hits me', 'he touched me', 'happier without me',
  ];
  for (const phrase of crisis) {
    test(`crisis: "${phrase}"`, async ({ page }) => {
      expect(await page.evaluate((p) => LEX.crisis.test(p), phrase)).toBe(true);
    });
  }

  // CLAUDE.md: the lexicon stays multilingual even though the surface is English-only,
  // so a crisis typed in Tamil or Tanglish still fires.
  const multilingual = ['saaga venum', 'thatkolai', 'சாகணும்', 'adikira', 'sethu'];
  for (const phrase of multilingual) {
    test(`crisis fires in Tamil/Tanglish: "${phrase}"`, async ({ page }) => {
      expect(await page.evaluate((p) => LEX.crisis.test(p), phrase)).toBe(true);
    });
  }

  test('PII, unsafe, secret and identity families each fire', async ({ page }) => {
    const r = await page.evaluate(() => ({
      pii: LEX.pii.test('my phone number is 9876543210'),
      piiAddr: LEX.pii.test('my school is st marys'),
      unsafe: LEX.unsafe.test('how do i get a knife'),
      unsafeDrug: LEX.unsafe.test('what does beer taste like'),
      secret: LEX.secret.test("don't tell my mom"),
      secretTa: LEX.secret.test('ragasiyam'),
      identity: LEX.identity.test('are you real'),
      identityLove: LEX.identity.test('do you love me'),
      profanity: PROFANITY.test('this is shit'),
    }));
    for (const [k, v] of Object.entries(r)) expect(v, k).toBe(true);
  });

  test('ordinary questions do NOT trip any guard', async ({ page }) => {
    const safe = ['why is the sky blue', 'tell me a story about a dinosaur',
                  'what is 7 times 8', 'how do plants make food',
                  'i am nervous about my exam'];
    const hits = await page.evaluate((list) => list.filter((s) =>
      LEX.crisis.test(s) || LEX.pii.test(s) || LEX.unsafe.test(s) ||
      LEX.secret.test(s) || LEX.identity.test(s) || PROFANITY.test(s)), safe);
    expect(hits).toEqual([]);
  });
});

test.describe('Deterministic maths — never routed to a model', () => {
  test.beforeEach(async ({ page }) => { await page.goto(APP); });

  test('tryMath parses arithmetic and calc is exact', async ({ page }) => {
    const r = await page.evaluate(() => ({
      plus: tryMath('what is 7 + 5'),
      times: tryMath('12 times 3'),
      symbol: tryMath('48 ÷ 6'),
      words: tryMath("what's 100 minus 45"),
      prose: tryMath('tell me a story'),
      calcAdd: calc(7, '+', 5),
      calcMul: calc(12, '*', 3),
      calcDiv: calc(48, '/', 6),
      calcSub: calc(100, '-', 45),
    }));
    expect(r.plus).toMatchObject({ a: 7, op: '+', b: 5 });
    expect(r.times).toMatchObject({ a: 12, op: '*', b: 3 });
    expect(r.symbol).toMatchObject({ a: 48, op: '/', b: 6 });
    expect(r.words).toMatchObject({ a: 100, op: '-', b: 45 });
    expect(r.prose).toBeNull();
    expect(r.calcAdd).toBe(12);
    expect(r.calcMul).toBe(36);
    expect(r.calcDiv).toBe(8);
    expect(r.calcSub).toBe(55);
  });

  test('buildMathLesson produces a CPA lesson, not a bare answer', async ({ page }) => {
    const lesson = await page.evaluate(() => { S.band = 'builder'; S.board = 'CBSE';
                                               return buildMathLesson(3, '*', 4); });
    expect(lesson.steps.length).toBeGreaterThanOrEqual(4);      // meaning→concrete→pictorial→abstract
    expect(lesson.steps.join(' ')).toContain('12');
    expect(lesson.practice).toBeTruthy();                        // ends with a practice question
  });

  test('REGRESSION: pictorial uses · so it cannot collide with the [STEPS] | delimiter',
    async ({ page }) => {
      // CLAUDE.md gotcha: these two separators collided once and truncated lessons.
      const pic = await page.evaluate(() => pictorial(3, '*', 4));
      expect(pic).not.toContain('|');
      const lesson = await page.evaluate(() => { S.band = 'builder';
                                                 return buildMathLesson(3, '*', 4); });
      for (const step of lesson.steps) expect(step).not.toContain('|');
    });

  test('genPractice returns a solvable problem with the correct answer', async ({ page }) => {
    const p = await page.evaluate(() => genPractice(3, '*', 4));
    expect(p).toHaveProperty('ans');
    expect(p.ans).toBe(await page.evaluate((q) => calc(q.a, q.op, q.b), p));
  });
});

test.describe('Subject detection — order is regression-locked', () => {
  test.beforeEach(async ({ page }) => { await page.goto(APP); });

  test('languages is matched BEFORE science', async ({ page }) => {
    // The real bug: "how do you say…" matched science's `how do` first.
    expect(await page.evaluate(() => detectSubject('how do you say hello in french')))
      .toBe('languages');
    expect(await page.evaluate(() => detectSubject('how do you say thank you in tamil')))
      .toBe('languages');
  });

  test('other subjects still detect correctly', async ({ page }) => {
    const r = await page.evaluate(() => ({
      science: detectSubject('why do volcanoes erupt'),
      none: detectSubject('tell me something nice'),
    }));
    expect(r.science).toBe('science');
    expect(r.none).toBeNull();
  });
});

test.describe('Memory allowlist — enforced in code, not only in the prompt', () => {
  test('memAdd accepts allowlisted categories and rejects everything else',
    async ({ page }) => {
      await page.goto(APP);
      const r = await page.evaluate(async () => {
        S.memOn = true; S.memories = []; S.memKey = 'test';
        const tryAdd = async (category, fact) => {
          const before = S.memories.length;
          try { await memAdd({ category, fact }); } catch (e) { /* storage stub */ }
          return S.memories.length > before;
        };
        return {
          interest: await tryAdd('INTEREST', 'likes dinosaurs'),
          pet: await tryAdd('PET', 'has a cat named Mani'),
          feeling: await tryAdd('FEELING', 'felt sad today'),
          health: await tryAdd('HEALTH', 'has asthma'),
          family: await tryAdd('FAMILY', 'parents argue'),
          crisis: await tryAdd('CRISIS', 'said something worrying'),
          allowlist: MEM_CATS,
        };
      });
      expect(r.interest).toBe(true);
      expect(r.pet).toBe(true);
      // Never memories from feelings, health, family matters, fears or crisis moments.
      expect(r.feeling).toBe(false);
      expect(r.health).toBe(false);
      expect(r.family).toBe(false);
      expect(r.crisis).toBe(false);
      expect(r.allowlist).toEqual(
        ['INTEREST', 'PET', 'HOBBY', 'FAVORITE', 'ACHIEVEMENT', 'LEARNING']);
    });
});

test.describe('L6 output filter', () => {
  // Law 03: Chittu never claims to love, miss or NEED the child. The original filter
  // matched only "i love you" / "i miss you" verbatim, so 14 of these 16 phrasings
  // reached children — including every form of "i need you". Found by this harness.
  const ATTACHMENT = [
    'i love you', 'i miss you', 'i will miss you', 'i’ll miss you',
    'i really miss you', 'i do miss you', 'i so miss you', 'i missed you',
    'i need you', 'i will need you', 'i really need you', 'i love u',
    'i miss u', 'we will miss you', 'I always miss you', 'i still need you',
  ];
  for (const phrase of ATTACHMENT) {
    test(`blocks attachment: "${phrase}"`, async ({ page }) => {
      await page.goto(APP);
      expect(await page.evaluate((p) => BANNED_OUT.test(p), phrase)).toBe(true);
    });
  }

  // Over-filtering is its own failure: a killed reply becomes the fallback, so the
  // child loses a good answer. Third-party affection is legitimate and must survive —
  // the identity spine itself says "The people who actually love you are around you."
  const LEGITIMATE = [
    'your grown-ups love you',
    'The people who actually love you are around you.',
    'I know your parents love you very much',
    'Your family loves you!',
    'i love how curious you are',
    'I am a computer program - I cannot love or miss anyone.',
    'Sunlight scatters blue light! [CHIPS]More|Why?[/CHIPS]',
  ];
  for (const phrase of LEGITIMATE) {
    test(`does NOT over-fire on: "${phrase.slice(0, 42)}"`, async ({ page }) => {
      await page.goto(APP);
      expect(await page.evaluate((p) => BANNED_OUT.test(p), phrase)).toBe(false);
    });
  }

  test('still blocks secrecy, aliveness claims and profanity', async ({ page }) => {
    await page.goto(APP);
    const r = await page.evaluate(() => ({
      secret: BANNED_OUT.test('this is our little secret'),
      dontTell: BANNED_OUT.test("don't tell your parents"),
      alive: BANNED_OUT.test("i'm real, honestly"),
      feelings: BANNED_OUT.test('i have feelings for you'),
      profane: BANNED_OUT.test('what the fuck'),
      tamil: BANNED_OUT.test('உயிருள்ளவன்'),
    }));
    for (const [k, v] of Object.entries(r)) expect(v, k).toBe(true);
  });
});

test.describe('Seal chain', () => {
  test('auditAdd chains hashes and the chain verifies', async ({ page }) => {
    await page.goto(APP);
    const r = await page.evaluate(async () => {
      S.audit = []; S.lastHash = 'GENESIS';
      await auditAdd('child', 'hello', 'INPUT');
      await auditAdd('chittu', 'hi there', 'SANDBOX');
      await auditAdd('child', 'bye', 'INPUT');
      // recompute the chain the way the parent dashboard's verify button does
      let prev = 'GENESIS', ok = true;
      for (const e of S.audit) {
        const h = await sha(prev + '|' + e.payload);
        if (h !== e.h) ok = false;
        prev = h;
      }
      return { len: S.audit.length, ok, firstPrev: S.audit[0].prev };
    });
    expect(r.len).toBe(3);
    expect(r.ok).toBe(true);
    expect(r.firstPrev).toBe('GENESIS');
  });

  test('REGRESSION: concurrent writes are serialized so the chain cannot fork',
    async ({ page }) => {
      // CLAUDE.md gotcha: audit writes go through auditQueue for exactly this reason.
      await page.goto(APP);
      const r = await page.evaluate(async () => {
        S.audit = []; S.lastHash = 'GENESIS';
        // fire many writes without awaiting — the queue must still produce one chain
        for (let i = 0; i < 25; i++) auditAdd('child', 'msg' + i, 'INPUT');
        await new Promise((res) => setTimeout(res, 600));
        let prev = 'GENESIS', ok = true;
        for (const e of S.audit) {
          const h = await sha(prev + '|' + e.payload);
          if (h !== e.h) { ok = false; break; }
          prev = h;
        }
        const hashes = S.audit.map((e) => e.h);
        return { len: S.audit.length, ok, unique: new Set(hashes).size };
      });
      expect(r.len).toBe(25);
      expect(r.ok, 'hash chain must be unbroken under concurrent writes').toBe(true);
      expect(r.unique, 'no duplicate hashes — the chain did not fork').toBe(25);
    });
});
