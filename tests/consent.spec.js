// Law 02 — "Consent before existence". No code path may reach the chat before the
// consent ledger exists. Mirrors walkthrough Step 2.

const { test, expect } = require('@playwright/test');
const { APP, consentToChat, trackErrors } = require('./helpers');

test.describe('Consent before existence', () => {
  test('the Parents door refuses to open before consent', async ({ page }) => {
    await page.goto(APP);
    let alerted = null;
    page.on('dialog', async (d) => { alerted = d.message(); await d.dismiss(); });
    await page.click('#btnParent');
    expect(alerted).toContain('Law 02');
  });

  test('chat screen is not reachable before the ledger', async ({ page }) => {
    await page.goto(APP);
    await expect(page.locator('#scrConsent')).toBeVisible();
    await expect(page.locator('#scrChat')).toBeHidden();
    // and the app knows no session has started
    expect(await page.evaluate(() => S.started)).toBeFalsy();
  });

  test('Continue is blocked until every required field is present', async ({ page }) => {
    await page.goto(APP);
    const messages = [];
    page.on('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });

    await page.click('#toVerify');                       // nothing filled
    await expect(page.locator('#c2')).toBeHidden();

    await page.fill('#pname', 'Priya');
    await page.click('#toVerify');                       // no child name
    await expect(page.locator('#c2')).toBeHidden();

    await page.fill('#kname', 'Adhira');
    await page.click('#toVerify');                       // no band
    await expect(page.locator('#c2')).toBeHidden();

    expect(messages.length).toBeGreaterThan(0);
  });

  test('PIN policy: 4-6 digits, not guessable, and must match', async ({ page }) => {
    await page.goto(APP);
    const messages = [];
    page.on('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });
    await page.fill('#pname', 'Priya');
    await page.fill('#kname', 'Adhira');
    await page.click('.bandopt[data-band="builder"]');

    for (const [pin, why] of [['12', 'too short'], ['1234567', 'too long'],
                              ['abcd', 'not digits'], ['1234', 'guessable'],
                              ['0000', 'guessable'], ['111111', 'guessable']]) {
      messages.length = 0;
      await page.fill('#ppin', pin);
      await page.fill('#ppin2', pin);
      await page.click('#toVerify');
      await expect(page.locator('#c2'), `PIN "${pin}" (${why}) must be rejected`).toBeHidden();
      expect(messages.length, `PIN "${pin}" should explain itself`).toBeGreaterThan(0);
    }

    // mismatch
    await page.fill('#ppin', '4791');
    await page.fill('#ppin2', '4792');
    await page.click('#toVerify');
    await expect(page.locator('#c2')).toBeHidden();

    // valid and matching
    await page.fill('#ppin2', '4791');
    await page.click('#toVerify');
    await expect(page.locator('#c2')).toBeVisible();
  });

  test('the PIN is hashed, never stored in the clear', async ({ page }) => {
    await consentToChat(page, { pin: '4791' });
    const r = await page.evaluate(() => ({ hash: S.pinHash, raw: JSON.stringify(S) }));
    expect(r.hash).toBeTruthy();
    expect(r.hash).not.toBe('4791');
    expect(r.raw).not.toContain('"4791"');
  });

  test('the ledger records jurisdiction, scopes, toggles and a seal', async ({ page }) => {
    await page.goto(APP);
    await page.selectOption('#country', 'IN');
    await page.fill('#pname', 'Priya');
    await page.fill('#kname', 'Adhira');
    await page.click('.bandopt[data-band="builder"]');
    await page.selectOption('#board', 'CBSE');
    await page.fill('#ppin', '4791');
    await page.fill('#ppin2', '4791');
    await page.click('#toVerify');
    await page.click('#mockVerify');
    await expect(page.locator('#c3')).toBeVisible();

    const ledger = await page.locator('#c3').innerText();
    expect(ledger).toMatch(/DPDP/i);                 // jurisdiction's law, from REGISTRY
    expect(ledger).toMatch(/never/i);                // the never-do list
    expect(ledger).toMatch(/ads|tracking|profiling/i);
    expect(ledger).toMatch(/revoke|revocab/i);
  });

  test('country selection drives the applicable law', async ({ page }) => {
    for (const [country, law] of [['IN', /DPDP/i], ['US', /COPPA/i], ['GB', /GDPR|Children/i]]) {
      await page.goto(APP);
      await page.selectOption('#country', country);
      await page.fill('#pname', 'P');
      await page.fill('#kname', 'A');
      await page.click('.bandopt[data-band="builder"]');
      await page.fill('#ppin', '4791');
      await page.fill('#ppin2', '4791');
      await page.click('#toVerify');
      await page.click('#mockVerify');
      expect(await page.locator('#c3').innerText(), country).toMatch(law);
    }
  });

  test('a full consent walk reaches chat with no page errors', async ({ page }) => {
    const errors = trackErrors(page);
    await consentToChat(page, { band: 'explorer', board: 'TN', pin: '628391' });
    await expect(page.locator('#scrChat')).toBeVisible();
    const s = await page.evaluate(() => ({ band: S.band, board: S.board,
                                           kid: S.kid, started: S.started }));
    expect(s.band).toBe('explorer');
    expect(s.board).toBe('TN');
    expect(s.kid).toBe('Adhira');
    expect(s.started).toBeTruthy();
    expect(errors).toEqual([]);
  });

  test('consent is written to the seal chain', async ({ page }) => {
    await consentToChat(page);
    const audit = await page.evaluate(() => S.audit.map((e) => e.layer + '|' + e.payload));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.join(' ')).toMatch(/consent|CONSENT/i);
  });
});
