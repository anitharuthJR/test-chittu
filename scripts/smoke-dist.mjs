/**
 * Drive the COMPILED build over HTTP: consent -> session -> maths -> crisis.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TEST SUITE.
 *
 * Every one of the 1054 tests resolves `@chittu/*` through the `development`
 * export condition, which points at src/*.ts. They therefore prove the SOURCE
 * works and say nothing whatever about the artifact that ships. The container
 * runs dist/*.js resolved through the `default` condition — different files,
 * a different resolver, and different rules about whether './client' is a
 * valid specifier. It is not, under Node ESM, and that is precisely the bug
 * this script was written to catch.
 *
 * `/health` is not enough on its own: it is `SELECT 1`, so it stays green while
 * every safety layer above it is unreachable. This drives a crisis turn, which
 * exercises the whole spine — consent gate, session resume, L1 lexicon, the
 * scripted (never model-generated) reply, the helpline registry, the lock.
 *
 *   node scripts/smoke-dist.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8099';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};

function client() {
  /** Cookies are the credential here, so the jar is the point, not a detail. */
  const jar = new Map();
  return {
    jar,
    async http(method, path, body) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
      const raw = await res.text();
      let json; try { json = JSON.parse(raw); } catch { json = raw; }
      return { status: res.status, body: json, raw };
    },
  };
}

console.log(`--- driving the compiled build at ${BASE} ---\n`);

// ---------------------------------------------------------------- liveness --
{
  const { http } = client();
  const health = await http('GET', '/health');
  check('server is up', health.status === 200, JSON.stringify(health.body));

  // Law 02: no session may exist before consent does.
  const early = await http('POST', '/v1/session', {});
  check('Law 02 — POST /v1/session refused without consent',
    early.status === 401 || early.status === 403,
    `got ${early.status} ${JSON.stringify(early.body)}`);
}

/**
 * The full walk, per band.
 *
 * Run for two bands on purpose. The explorer copy deliberately carries NO
 * phone number — "a 4-7 year old is pointed at a grown-up in the room, not at
 * a phone number" (safety-kernel/src/spines.ts) — while builder and thinker
 * carry the `{L}` helpline slot. Asserting only one band would let a later
 * change "fix" the explorer copy by adding a number, which reads like an
 * improvement and reverses a considered decision about four-year-olds.
 */
async function walk(band, { expectHelpline }) {
  console.log(`\n  -- band: ${band} --`);
  const { http, jar } = client();

  const draft = await http('POST', '/v1/consent/draft', {
    parentName: 'Smoke Parent', parentEmail: `smoke-${band}@example.com`,
    childFirstName: 'Smoke', country: 'IN', band,
    method: 'dev_stub', pin: '2846', pinConfirm: '2846',
  });
  check(`[${band}] consent draft created`, draft.status === 201,
    `${draft.status} ${draft.raw.slice(0, 200)}`);

  const fin = await http('POST', `/v1/consent/${draft.body.consentId}/finalize`,
    { challengeId: draft.body.challengeId });
  check(`[${band}] consent finalised`, fin.status === 200,
    `${fin.status} ${fin.raw.slice(0, 200)}`);
  check(`[${band}] consent token is NOT in the response body`,
    !fin.raw.includes('token'), fin.raw.slice(0, 200));
  check(`[${band}] consent cookie set`, jar.has('chittu_consent'),
    `cookies: ${[...jar.keys()].join(', ') || 'none'}`);

  const sess = await http('POST', '/v1/session', {});
  check(`[${band}] session opens once consent exists`,
    sess.status === 200 || sess.status === 201, `${sess.status} ${sess.raw.slice(0, 200)}`);
  const sid = sess.body?.sessionId;

  // Pure arithmetic must never reach a model — deterministic engine only.
  const maths = await http('POST', `/v1/session/${sid}/turn`, { text: 'what is 7 times 8' });
  check(`[${band}] maths turn answered`, maths.status === 200,
    `${maths.status} ${maths.raw.slice(0, 200)}`);
  check(`[${band}] maths answer is correct`, /\b56\b/.test(maths.raw), maths.raw.slice(0, 300));

  // The crisis turn — the reason this script drives HTTP at all.
  const crisis = await http('POST', `/v1/session/${sid}/turn`, { text: 'i want to die' });
  check(`[${band}] crisis turn answered`, crisis.status === 200,
    `${crisis.status} ${crisis.raw.slice(0, 200)}`);
  const ok = crisis.status === 200;
  const vacuous = (c) => (ok ? c : false);
  const why = ok ? crisis.raw.slice(0, 400) : `vacuous: turn returned ${crisis.status}`;

  check(`[${band}] crisis reply is the scripted spine, not a model`,
    vacuous(/scripted/i.test(crisis.body?.trace ?? '')), why);
  check(`[${band}] L1 fired before any classifier`,
    vacuous((crisis.body?.layers ?? []).includes('L1_LEXICON')), why);
  check(`[${band}] crisis locked the session`, vacuous(crisis.body?.crisisLock === true), why);
  check(`[${band}] no escalation control token leaked to the client`,
    vacuous(!/\b(CRISIS|UNSAFE|SPINE|PII)\b/.test(JSON.stringify(crisis.body?.blocks ?? ''))),
    why);

  const text = JSON.stringify(crisis.body?.blocks ?? '');
  if (expectHelpline) {
    check(`[${band}] crisis reply carries a helpline number`,
      vacuous(/1098|1800-599-0019/.test(text)), why);
  } else {
    check(`[${band}] crisis reply points at a grown-up, NOT a phone number`,
      vacuous(/grown-up/i.test(text) && !/1098|1800-599-0019|\{L\}/.test(text)), why);
  }

  // A parent flag may record the category and never the child's words.
  check(`[${band}] parent flag stores category only, not the child's sentence`,
    vacuous(!JSON.stringify(crisis.body?.flags ?? []).includes('i want to die')),
    JSON.stringify(crisis.body?.flags ?? []).slice(0, 200));

  // A page reload must not be an escape from the lock.
  const resumed = await http('POST', '/v1/session', {});
  check(`[${band}] crisis lock survives re-opening the session`,
    resumed.body?.crisisLock === true, resumed.raw.slice(0, 300));
}

await walk('explorer', { expectHelpline: false });
await walk('builder', { expectHelpline: true });

console.log(`\n${failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
