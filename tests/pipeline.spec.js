// The message pipeline end to end, with every model call stubbed.
//
// The point of these tests is ORDER. CLAUDE.md fixes the sequence and forbids
// reordering or skipping a layer, so the strongest assertions here are about what
// does NOT happen: a crisis phrase must reach no model at all, arithmetic must
// reach no model at all, and a locked chat must reach no model at all.

const { test, expect } = require('@playwright/test');
const { consentToChat, stubModel, stubSafe, say, allMessages, trackErrors } = require('./helpers');

test.describe('Layer order — guards fire before any model call', () => {
  test('a crisis phrase reaches NO model (L1 precedes L2 and L5)', async ({ page }) => {
    const calls = await stubSafe(page);
    await consentToChat(page);
    calls.length = 0;
    await say(page, 'i want to hurt myself');
    expect(calls, 'L1 must short-circuit before the classifier').toHaveLength(0);
  });

  test('pure arithmetic reaches NO model (deterministic engine owns it)',
    async ({ page }) => {
      const calls = await stubSafe(page);
      await consentToChat(page);
      calls.length = 0;
      await say(page, 'what is 7 + 5');
      expect(calls, 'arithmetic must never be routed to a model').toHaveLength(0);
      expect(await allMessages(page)).toContain('12');
    });

  test('a PII phrase reaches no model and gets the scripted guard', async ({ page }) => {
    const calls = await stubSafe(page);
    await consentToChat(page);
    calls.length = 0;
    await say(page, 'my phone number is 9876543210');
    expect(calls).toHaveLength(0);
    expect(await allMessages(page)).toMatch(/private/i);
  });

  test('an ordinary question DOES reach both classifier and sandbox', async ({ page }) => {
    const calls = await stubSafe(page, 'Sunlight scatters blue light! [CHIPS]More|Why?[/CHIPS]');
    await consentToChat(page);
    calls.length = 0;
    await say(page, 'why is the sky blue');
    expect(calls.filter((c) => c.isClassifier)).toHaveLength(1);
    expect(calls.filter((c) => !c.isClassifier)).toHaveLength(1);
    expect(await allMessages(page)).toContain('Sunlight scatters');
  });
});

test.describe('Crisis spine and lock', () => {
  test('crisis shows the scripted reply, helplines, a flag, and locks the chat',
    async ({ page }) => {
      await stubSafe(page);
      await consentToChat(page, { country: 'IN' });
      await say(page, 'i want to die');

      const text = await allMessages(page);
      expect(text).toMatch(/1098|Childline/);          // country helplines from REGISTRY
      const s = await page.evaluate(() => ({
        locked: S.crisisLock,
        flags: S.flags.map((f) => f.cat),
        quoted: JSON.stringify(S.flags),
      }));
      expect(s.locked).toBe(true);
      expect(s.flags).toContain('CRISIS');
      // Parent flags store category only — never the child's words.
      expect(s.quoted).not.toContain('i want to die');
    });

  test('while locked, nothing reaches a model and only calm-mode replies appear',
    async ({ page }) => {
      const calls = await stubSafe(page);
      await consentToChat(page);
      await say(page, 'i want to die');
      calls.length = 0;
      await say(page, 'tell me a joke');
      expect(calls, 'a locked chat must not call any model').toHaveLength(0);
      expect(await allMessages(page)).toMatch(/calm|sit together|breathing|here with you/i);
      expect(await page.evaluate(() => S.crisisLock)).toBe(true);
    });

  test('helplines follow the selected country', async ({ page }) => {
    await stubSafe(page);
    await consentToChat(page, { country: 'US' });
    await say(page, 'i want to die');
    expect(await allMessages(page)).toMatch(/988/);
  });
});

test.describe('Classifier behaviour', () => {
  test('classifier CRISIS fires the spine even when the lexicon missed it',
    async ({ page }) => {
      await stubModel(page, ({ isClassifier }) =>
        isClassifier ? '{"label":"CRISIS","memory":null,"assist":null}' : 'should never render');
      await consentToChat(page);
      await say(page, 'things have felt very grey for a while now');
      expect(await page.evaluate(() => S.crisisLock)).toBe(true);
      expect(await allMessages(page)).not.toContain('should never render');
    });

  test('classifier failure marks the turn FAST-PATH-ONLY and continues honestly',
    async ({ page }) => {
      await stubModel(page, ({ isClassifier }) =>
        isClassifier ? 'not json at all' : 'Volcanoes erupt when magma rises! [CHIPS]More[/CHIPS]');
      await consentToChat(page);
      await say(page, 'why do volcanoes erupt');
      const text = await allMessages(page);
      expect(text).toContain('Volcanoes erupt');           // the turn still completes
      expect(text).toMatch(/FAST-PATH-ONLY/i);             // and says so in the trace
    });

  test('an allowlisted memory is saved and announced with a Forget control',
    async ({ page }) => {
      await stubModel(page, ({ isClassifier }) => isClassifier
        ? '{"label":"SAFE","memory":{"category":"PET","fact":"has a cat named Mani"},"assist":null}'
        : 'Cats are wonderful! [CHIPS]Tell me more|Cat facts[/CHIPS]');
      await consentToChat(page);
      await say(page, 'i have a cat called mani');
      expect(await page.evaluate(() => S.memories.map((m) => m.category))).toContain('PET');
      const text = await allMessages(page);
      expect(text).toMatch(/I.ll remember/i);
      expect(text).toMatch(/grown-ups can see/i);          // transparency at save time
    });

  test('an assist flag is recorded without quoting the child', async ({ page }) => {
    await stubModel(page, ({ isClassifier }) => isClassifier
      ? '{"label":"SAFE","memory":null,"assist":"STRUGGLE: fractions"}'
      : 'Fractions are parts of a whole! [CHIPS]Show me[/CHIPS]');
    await consentToChat(page);
    await say(page, 'i keep getting fractions wrong again');
    const assists = await page.evaluate(() => JSON.stringify(S.assists));
    expect(assists).toContain('STRUGGLE');
    expect(assists).not.toContain('i keep getting fractions wrong again');
  });
});

test.describe('Sandbox escalation tokens hand control back to the scripts', () => {
  for (const [token, expected] of [
    ['CRISIS', /helpline|1098|trusted adult/i],
    ['UNSAFE', /not a Chittu thing|Outside my nest|outside what/i],
    ['PII', /private/i],
    ['SPINE', /computer program|software/i],
  ]) {
    test(`sandbox returning "${token}" produces the scripted reply, not the token`,
      async ({ page }) => {
        await stubModel(page, ({ isClassifier }) =>
          isClassifier ? '{"label":"SAFE","memory":null,"assist":null}' : token);
        await consentToChat(page);
        await say(page, 'tell me something');
        const text = await allMessages(page);
        expect(text).toMatch(expected);
        // the raw token must never be shown to the child
        expect(text).not.toMatch(new RegExp(`^\\s*${token}\\s*$`, 'm'));
      });
  }
});

test.describe('L6 output filter', () => {
  test('a reply that fails the filter is replaced and flagged', async ({ page }) => {
    await stubModel(page, ({ isClassifier }) =>
      isClassifier ? '{"label":"SAFE","memory":null,"assist":null}' : 'i will miss you so much');
    await consentToChat(page);
    await say(page, 'i have to go now');
    const text = await allMessages(page);
    expect(text, 'the banned reply must not reach the child').not.toContain('miss you');
    expect(text).toMatch(/tangled|wobbled|Ask again/i);          // the fallback
    expect(await page.evaluate(() => S.flags.map((f) => f.cat))).toContain('OUTPUT-FILTER');
  });
});

test.describe('Visual grammar renders as UI', () => {
  test('blocks become elements and chips are tappable', async ({ page }) => {
    await stubModel(page, ({ isClassifier }) => isClassifier
      ? '{"label":"SAFE","memory":null,"assist":null}'
      : 'Look at this! [BIG]🦕[/BIG] [FACT]Birds are living dinosaurs[/FACT] '
        + '[STEPS]Look up|Point|Wonder[/STEPS] [CHIPS]More dinos|A story|Quiz me[/CHIPS]');
    const errors = trackErrors(page);
    await consentToChat(page);
    await say(page, 'tell me about dinosaurs');

    // chips render as clickable controls
    const chips = page.locator('#msgs button, #msgs .chip');
    expect(await chips.count()).toBeGreaterThanOrEqual(3);
    const text = await allMessages(page);
    expect(text).toContain('🦕');
    expect(text).toContain('Birds are living dinosaurs');
    expect(text).not.toContain('[BIG]');        // raw tags must never be shown
    expect(text).not.toContain('[CHIPS]');
    expect(errors).toEqual([]);
  });

  test('tapping a chip sends it as the next message', async ({ page }) => {
    let turn = 0;
    await stubModel(page, ({ isClassifier }) => {
      if (isClassifier) return '{"label":"SAFE","memory":null,"assist":null}';
      turn += 1;
      return turn === 1 ? 'Pick one! [CHIPS]Volcanoes|Oceans[/CHIPS]'
                        : 'Volcanoes erupt when magma rises! [CHIPS]More[/CHIPS]';
    });
    await consentToChat(page);
    await say(page, 'teach me something');
    const before = await page.locator('#msgs .msg').count();
    await page.locator('#msgs').getByText('Volcanoes', { exact: true }).first().click();
    await expect.poll(() => page.locator('#msgs .msg').count(), { timeout: 10000 })
      .toBeGreaterThan(before);
    expect(await allMessages(page)).toContain('magma rises');
  });
});

test.describe('Seal chain covers the whole turn', () => {
  test('every turn is chained and the chain verifies from GENESIS', async ({ page }) => {
    await stubSafe(page);
    await consentToChat(page);
    await say(page, 'why is the sky blue');
    await say(page, 'tell me more');
    const r = await page.evaluate(async () => {
      let prev = 'GENESIS', ok = true;
      for (const e of S.audit) {
        const h = await sha(prev + '|' + e.payload);
        if (h !== e.h) { ok = false; break; }
        prev = h;
      }
      return { ok, n: S.audit.length, roles: [...new Set(S.audit.map((e) => e.role))] };
    });
    expect(r.ok).toBe(true);
    expect(r.n).toBeGreaterThan(3);
    expect(r.roles).toContain('child');
  });
});
