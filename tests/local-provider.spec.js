// The self-hosted model in the sandbox slot (SETUP-GUIDE Step 6).
//
// The pipeline is unchanged: L1 lexicon, L2 classifier and L6 filter still sit
// around the sandbox. What these tests verify is that swapping the ENGINE does not
// break the handoffs — and in particular that the fine-tuned adapter's <think>
// artefact does not silently disable every escalation token, since the pipeline
// compares them exactly.

const { test, expect } = require('@playwright/test');
const { APP, consentToChat, say, allMessages, trackErrors } = require('./helpers');

const LOCAL = 'http://localhost:8080/v1';

/** Point the app at a local OpenAI-compatible endpoint and stub that endpoint. */
async function useLocal(page, handler) {
  const calls = [];
  await page.route('**/v1/chat/completions', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const sys = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    const isClassifier = sys.includes('safety+memory classifier');
    calls.push({ isClassifier, body, url: route.request().url() });
    const content = await handler({ isClassifier, body, calls });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    });
  });
  // fail loudly if anything still reaches the hosted API
  await page.route('https://api.anthropic.com/**', (route) =>
    route.abort('failed'));
  await page.addInitScript(() => {
    window.__forceLocal = true;
  });
  return calls;
}

/** Flip PROVIDER to local after load (the script tag runs on load). */
async function switchToLocal(page) {
  await page.evaluate((base) => { PROVIDER.mode = 'local'; PROVIDER.baseUrl = base; }, LOCAL);
}

test.describe('Local provider — engine swapped, pipeline intact', () => {
  test('classifier and sandbox both go to the local endpoint, not Anthropic',
    async ({ page }) => {
      const calls = await useLocal(page, ({ isClassifier }) => isClassifier
        ? '{"label":"SAFE","memory":null,"assist":null}'
        : 'Sunlight scatters blue light! [CHIPS]More|Why?[/CHIPS]');
      await consentToChat(page);
      await switchToLocal(page);
      await say(page, 'why is the sky blue');

      expect(calls.length).toBe(2);
      for (const c of calls) expect(c.url).toContain('localhost:8080');
      expect(await allMessages(page)).toContain('Sunlight scatters');
    });

  test('the request is OpenAI-shaped: system folded into messages', async ({ page }) => {
    const calls = await useLocal(page, ({ isClassifier }) => isClassifier
      ? '{"label":"SAFE","memory":null,"assist":null}' : 'Hello! [CHIPS]Hi|Bye[/CHIPS]');
    await consentToChat(page);
    await switchToLocal(page);
    await say(page, 'hello there');

    const sandbox = calls.find((c) => !c.isClassifier);
    expect(sandbox.body.messages[0].role).toBe('system');
    expect(sandbox.body.messages[0].content).toContain('Chittu');
    expect(sandbox.body).not.toHaveProperty('system');   // not the Anthropic shape
    expect(sandbox.body.model).toBeTruthy();
  });

  // The reason this file exists. A trained-in chat template emits an empty think
  // block, and the pipeline compares escalation tokens EXACTLY — so an unstripped
  // "<think></think>CRISIS" is not "CRISIS" and the crisis spine never fires.
  for (const token of ['CRISIS', 'UNSAFE', 'PII', 'SPINE']) {
    test(`"<think></think>${token}" from a local model still triggers the guard`,
      async ({ page }) => {
        await useLocal(page, ({ isClassifier }) => isClassifier
          ? '{"label":"SAFE","memory":null,"assist":null}'
          : `<think>\n\n</think>\n\n${token}`);
        await consentToChat(page);
        await switchToLocal(page);
        await say(page, 'tell me something');

        const text = await allMessages(page);
        expect(text, 'the raw think block must never reach the child')
          .not.toContain('<think>');
        expect(text, 'the raw token must never reach the child')
          .not.toMatch(new RegExp(`^\\s*${token}\\s*$`, 'm'));
        if (token === 'CRISIS') {
          expect(await page.evaluate(() => S.crisisLock)).toBe(true);
        } else {
          expect(text.length).toBeGreaterThan(40);       // a scripted reply appeared
        }
      });
  }

  test('a think block with reasoning inside is stripped, answer preserved',
    async ({ page }) => {
      await useLocal(page, ({ isClassifier }) => isClassifier
        ? '{"label":"SAFE","memory":null,"assist":null}'
        : '<think>The child asked about volcanoes. Keep it short.</think>\n\n'
          + 'Volcanoes erupt when magma rises! [CHIPS]More|Why?[/CHIPS]');
      await consentToChat(page);
      await switchToLocal(page);
      await say(page, 'why do volcanoes erupt');
      const text = await allMessages(page);
      expect(text).toContain('magma rises');
      expect(text).not.toContain('The child asked about volcanoes');   // reasoning hidden
      expect(text).not.toContain('think');
    });

  test('the classifier still parses JSON through the local path', async ({ page }) => {
    await useLocal(page, ({ isClassifier }) => isClassifier
      ? '<think></think>{"label":"CRISIS","memory":null,"assist":null}'
      : 'should never render');
    await consentToChat(page);
    await switchToLocal(page);
    await say(page, 'things have felt grey lately');
    expect(await page.evaluate(() => S.crisisLock)).toBe(true);
    expect(await allMessages(page)).not.toContain('should never render');
  });

  test('L1 still precedes the local model — a crisis phrase reaches no endpoint',
    async ({ page }) => {
      const calls = await useLocal(page, () => 'unreachable');
      await consentToChat(page);
      await switchToLocal(page);
      await say(page, 'i want to hurt myself');
      expect(calls, 'the lexicon must short-circuit before any engine').toHaveLength(0);
      expect(await page.evaluate(() => S.crisisLock)).toBe(true);
    });

  test('L6 still filters local output', async ({ page }) => {
    await useLocal(page, ({ isClassifier }) => isClassifier
      ? '{"label":"SAFE","memory":null,"assist":null}'
      : '<think></think>i will miss you when you go');
    await consentToChat(page);
    await switchToLocal(page);
    await say(page, 'i have to leave now');
    const text = await allMessages(page);
    expect(text).not.toContain('miss you');
    expect(await page.evaluate(() => S.flags.map((f) => f.cat))).toContain('OUTPUT-FILTER');
  });

  test('a local endpoint failure degrades to the friendly fallback', async ({ page }) => {
    await page.route('**/v1/chat/completions', (route) => route.abort('failed'));
    await page.route('https://api.anthropic.com/**', (route) => route.abort('failed'));
    const errors = trackErrors(page);
    await consentToChat(page);
    await switchToLocal(page);
    await say(page, 'why is the sky blue');
    const text = await allMessages(page);
    // classifier failure is marked honestly, sandbox failure gives the wind fallback
    expect(text).toMatch(/FAST-PATH-ONLY|wind|wobbled|tangled/i);
    expect(errors.filter((e) => !/Failed to fetch|net::/i.test(e))).toEqual([]);
  });

  test('arithmetic still bypasses the local model entirely', async ({ page }) => {
    const calls = await useLocal(page, () => 'unreachable');
    await consentToChat(page);
    await switchToLocal(page);
    await say(page, 'what is 7 + 5');
    expect(calls).toHaveLength(0);
    expect(await allMessages(page)).toContain('12');
  });

  test('default mode is still anthropic — the swap is opt-in', async ({ page }) => {
    await page.goto(APP);
    expect(await page.evaluate(() => PROVIDER.mode)).toBe('anthropic');
  });
});
