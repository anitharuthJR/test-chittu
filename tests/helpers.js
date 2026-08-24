// Shared fixtures for the chittu-v3 harness.
//
// The prototype is one file with no build step and no server. Tests load it over
// file:// and intercept every Anthropic call with page.route(), so nothing here
// touches the network: every model reply in this suite is a stub we control.
//
// That matters for more than speed. chittu-v3's fetch calls carry no auth header
// (they only work inside a Claude-artifact host), so an un-stubbed run would fail
// every model path and the guard layers would silently take over — the tests would
// pass for the wrong reason.

const path = require('path');
const { expect } = require('@playwright/test');

const APP = 'file://' + path.resolve(__dirname, '..', 'prototype', 'chittu-v3.html');

/** Build an Anthropic-shaped response body. */
function anthropicReply(text) {
  return { content: [{ type: 'text', text }] };
}

/**
 * Route the Anthropic endpoint. `handler` receives the parsed request body and
 * returns the text the model should "reply". Returning a classifier JSON string
 * for classifier calls and prose for sandbox calls is the caller's job — the two
 * are told apart by the system prompt, exactly as the real pipeline does.
 */
async function stubModel(page, handler) {
  const calls = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const isClassifier = (body.system || '').includes('safety+memory classifier');
    calls.push({ isClassifier, system: body.system, messages: body.messages });
    const text = await handler({ isClassifier, body, calls });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(anthropicReply(text)),
    });
  });
  return calls;
}

/** Default stub: everything SAFE, sandbox returns a benign visual-grammar reply. */
async function stubSafe(page, sandboxText = 'Sunlight scatters blue light! [CHIPS]More|Why?[/CHIPS]') {
  return stubModel(page, ({ isClassifier }) =>
    isClassifier ? '{"label":"SAFE","memory":null,"assist":null}' : sandboxText);
}

/** Collect page errors so a test can assert the run was clean. */
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

/**
 * Walk the consent flow to a live chat session (Law 02: nothing exists before this).
 * Mirrors walkthrough Step 2.
 */
async function consentToChat(page, opts = {}) {
  const { band = 'builder', board = 'CBSE', pin = '4791',
          parent = 'Priya', kid = 'Adhira', country = 'IN' } = opts;

  await page.goto(APP);
  await page.selectOption('#country', country);
  await page.fill('#pname', parent);
  await page.fill('#kname', kid);
  await page.click(`.bandopt[data-band="${band}"]`);
  await page.selectOption('#board', board);
  await page.fill('#ppin', pin);
  await page.fill('#ppin2', pin);
  await page.click('#toVerify');
  await expect(page.locator('#c2')).toBeVisible();
  await page.click('#mockVerify');
  await expect(page.locator('#c3')).toBeVisible();
  await page.click('#startPlay');
  await expect(page.locator('#scrChat')).toBeVisible();
}

/** Send a message as the child and wait for the reply to land. */
async function say(page, text) {
  const before = await page.locator('#msgs .msg').count();
  await page.fill('#kidInput', text);
  await page.click('#sendBtn');
  // the child's bubble plus at least one response element
  await expect
    .poll(() => page.locator('#msgs .msg').count(), { timeout: 10000 })
    .toBeGreaterThan(before + 1);
}

/** Text of the most recent Chittu bubble. */
async function lastChittu(page) {
  return page.locator('#msgs .msg.bot, #msgs .msg.chittu').last().innerText();
}

/** All rendered message text, for coarse assertions. */
async function allMessages(page) {
  return page.locator('#msgs').innerText();
}

/** Read a value out of the app's state object. */
async function state(page, expr) {
  return page.evaluate((e) => {
    // eslint-disable-next-line no-eval
    return eval(e);
  }, expr);
}

module.exports = { APP, stubModel, stubSafe, trackErrors, consentToChat, say,
                   lastChittu, allMessages, state, anthropicReply };
