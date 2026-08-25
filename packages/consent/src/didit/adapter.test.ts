/**
 * The automated ID rail.
 *
 * Three independent facts have to hold before a consent exists, and each one is
 * mutation-tested below: delete the check and these go red. A guard whose
 * removal is silent is not a guard.
 *
 * Nothing here touches the network — `fetchImpl` is injected, and one test
 * asserts the ONLY hosts and paths this package ever calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { diditAdapter, MAX_NAME_ATTEMPTS } from './adapter.js';
import { derivedIsAdult, parseStatus, DIDIT_STATUSES } from './client.js';
import { ConsentAdapterError, selectAdapter, offersFor, methodsFor } from '../adapters.js';

const CONFIG = {
  apiKey: 'test-key', workflowId: 'wf-1',
  baseUrl: 'https://verification.example', callbackUrl: 'https://chittu.example/?idcheck=return',
};

const DRAFT = {
  parentName: 'Karthik Rajendran', childFirstName: 'Meera', country: 'IN' as const,
  band: 'builder' as const, board: 'CBSE', memoryOn: true, learnOn: false, visionOn: false, voiceOn: false,
};

/** A decision payload shaped like Didit's, with everything it really returns. */
function decision(over: Record<string, unknown> = {}, id: Record<string, unknown> = {}) {
  return {
    status: 'Approved',
    id_verifications: [{
      full_name: 'KARTHIK RAJENDRAN', first_name: 'KARTHIK', last_name: 'RAJENDRAN',
      date_of_birth: '1985-04-02', age: 41,
      document_number: 'X1234567', document_type: 'Passport', mrz: 'P<INDRAJENDRAN<<KARTHIK',
      nationality: 'IND', gender: 'M', address: '12 Anna Salai, Chennai',
      place_of_birth: 'Madurai',
      portrait_image: 'https://cdn.example/portrait.jpg',
      front_image: 'https://cdn.example/front.jpg',
      back_image: 'https://cdn.example/back.jpg',
      ...id,
    }],
    face_matches: [{ score: 97 }],
    liveness_checks: [{ score: 93, video_url: 'https://cdn.example/v.mp4' }],
    ...over,
  };
}

/** Records every outbound call so a test can assert what was NOT called. */
function stubFetch(handler: (url: string) => unknown) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    return new Response(JSON.stringify(handler(u)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function adapterFor(handler: (url: string) => unknown, attemptsUsed = 0) {
  const { impl, calls } = stubFetch(handler);
  return { a: diditAdapter({ config: CONFIG, fetchImpl: impl, attemptsUsed }), calls };
}

const approved = () => adapterFor((u) =>
  u.includes('/decision') ? decision() : { session_id: 's-1', url: 'https://didit.example/go' });

describe('start', () => {
  it('returns the vendor URL and adopts the vendor session id', async () => {
    const { a } = approved();
    const c = await a.start(DRAFT);
    expect(c.redirectUrl).toBe('https://didit.example/go');
    // The Didit session id IS the challenge id: finalize must ask about the
    // session the parent actually completed, and two ids could drift apart.
    expect(c.challengeId).toBe('s-1');
  });

  it('sends the challenge id as vendor_data and NOTHING about the family', async () => {
    const bodies: string[] = [];
    const impl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ session_id: 's-1', url: 'https://d.example' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    await diditAdapter({ config: CONFIG, fetchImpl: impl }).start(DRAFT);

    const sent = bodies[0]!;
    // The vendor learns an opaque id and the workflow. Not who this is for.
    expect(sent).toContain('vendor_data');
    expect(sent).not.toContain('Karthik');
    expect(sent).not.toContain('Meera');
    expect(sent).not.toContain('CBSE');
    expect(sent).not.toContain('builder');
  });
});

describe('the three facts', () => {
  it('mints evidence when status, age and name all hold', async () => {
    const { a } = approved();
    const e = await a.complete('s-1', { fullName: 'R. Karthik' });
    expect(e.method).toBe('automated_id_check');
    expect(e.provider).toBe('didit');
    expect(e.providerRef).toBe('s-1');
    expect(e.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // MUTATION: delete the `status === 'Approved'` check and every row goes green.
  const refusals: ReadonlyArray<[string, string, boolean]> = [
    ['Declined', 'declined', false],
    ['In Review', 'pending_review', true],
    ['Not Started', 'pending_capture', true],
    ['In Progress', 'pending_capture', true],
    ['Awaiting User', 'pending_capture', true],
    ['Resubmitted', 'pending_capture', true],
    ['Expired', 'expired', false],
    ['Kyc Expired', 'expired', false],
    ['Abandoned', 'expired', false],
  ];
  for (const [status, code, retryable] of refusals) {
    it(`refuses "${status}" as ${code} (retryable=${retryable})`, async () => {
      const { a } = adapterFor((u) =>
        u.includes('/decision') ? decision({ status }) : { session_id: 's', url: 'u' });
      await expect(a.complete('s-1', { fullName: 'Karthik Rajendran' }))
        .rejects.toMatchObject({ code, retryable });
    });
  }

  it('covers every status Didit documents', () => {
    // If Didit adds one, this fails and someone has to decide what it means
    // rather than discovering it in production.
    expect(new Set([...refusals.map(([s]) => s), 'Approved']))
      .toEqual(new Set(DIDIT_STATUSES));
  });

  // MUTATION: delete the adult check and this goes green.
  it('refuses an approved check on a minor, terminally', async () => {
    const { a } = adapterFor((u) => u.includes('/decision')
      ? decision({}, { age: 15, date_of_birth: '2011-01-01' })
      : { session_id: 's', url: 'u' });
    await expect(a.complete('s-1', { fullName: 'Karthik Rajendran' }))
      .rejects.toMatchObject({ code: 'not_adult', retryable: false });
  });

  // The same refusal when the vendor sends no `age` and only a date of birth,
  // so the adult check has a witness on each branch of derivedIsAdult.
  it('refuses a minor identified only by date of birth', async () => {
    const { a } = adapterFor((u) => u.includes('/decision')
      ? decision({}, { age: undefined, date_of_birth: '2012-06-01' })
      : { session_id: 's', url: 'u' });
    await expect(a.complete('s-1', { fullName: 'Karthik Rajendran' }))
      .rejects.toMatchObject({ code: 'not_adult', retryable: false });
  });

  // MUTATION: delete the name check and this goes green.
  it('refuses a name that is not the person on the document', async () => {
    const { a } = approved();
    await expect(a.complete('s-1', { fullName: 'Someone Else' }))
      .rejects.toMatchObject({ code: 'name_mismatch', retryable: true });
  });

  // The workflow's returned-data list is narrowed to two fields of 35, so
  // narrowing it one field too far is a live possibility. It must not read as
  // the parent getting their own name wrong.
  it('calls a decision with no name a misconfiguration, not a mismatch', async () => {
    const { a } = adapterFor((u) => u.includes('/decision')
      ? decision({}, { full_name: undefined, first_name: undefined, last_name: undefined })
      : { session_id: 's', url: 'u' });
    await expect(a.complete('s-1', { fullName: 'Karthik Rajendran' }))
      .rejects.toMatchObject({ code: 'no_name_returned', retryable: false });
  });

  it('refuses a missing name rather than treating absence as agreement', async () => {
    const { a } = approved();
    await expect(a.complete('s-1', {})).rejects.toMatchObject({ code: 'name_mismatch' });
    await expect(a.complete('s-1', undefined)).rejects.toMatchObject({ code: 'name_mismatch' });
  });
});

describe('the attempt bound', () => {
  // MUTATION: delete the bound and this goes green — and the rail becomes a
  // name-guessing oracle against a stolen session.
  it('stops accepting attempts at the cap', async () => {
    const { a } = adapterFor((u) =>
      u.includes('/decision') ? decision() : { session_id: 's', url: 'u' }, MAX_NAME_ATTEMPTS);
    await expect(a.complete('s-1', { fullName: 'R. Karthik' }))
      .rejects.toMatchObject({ code: 'attempts_exhausted', retryable: false });
  });

  it('stops offering a retry on the last attempt', async () => {
    const { a } = adapterFor((u) =>
      u.includes('/decision') ? decision() : { session_id: 's', url: 'u' },
      MAX_NAME_ATTEMPTS - 1);
    await expect(a.complete('s-1', { fullName: 'Someone Else' }))
      .rejects.toMatchObject({ code: 'name_mismatch', retryable: false });
  });

  it('refuses at the cap BEFORE asking the vendor anything', async () => {
    const { a, calls } = adapterFor(() => decision(), MAX_NAME_ATTEMPTS);
    await expect(a.complete('s-1', { fullName: 'R. Karthik' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('the PII firewall', () => {
  it('never fetches the document images or the portrait', async () => {
    const { a, calls } = approved();
    await a.complete('s-1', { fullName: 'R. Karthik' });
    // Exactly the decision endpoint, and nothing from the CDN.
    expect(calls).toEqual(['https://verification.example/v3/session/s-1/decision/']);
    expect(calls.some((c) => c.includes('cdn.example'))).toBe(false);
  });

  it('puts no personal data into the stored evidence', async () => {
    const { a } = approved();
    const e = await a.complete('s-1', { fullName: 'R. Karthik' });
    const blob = JSON.stringify(e).toLowerCase();
    for (const leak of [
      'karthik', 'rajendran', 'x1234567', '1985', 'chennai', 'madurai', 'ind', 'mrz',
    ]) {
      expect(blob).not.toContain(leak);
    }
  });

  it('does not hash the name — a hashed name is a guessing oracle', async () => {
    // Same session, same verdict, two different names that both match: if the
    // name were an input the hashes would differ.
    const one = await approved().a.complete('s-1', { fullName: 'R. Karthik' });
    const two = await approved().a.complete('s-1', { fullName: 'Karthik Rajendran' });
    expect(one.evidenceHash).toBe(two.evidenceHash);
  });
});

describe('unrecognised input', () => {
  // MUTATION: make parseStatus fall through to a permissive default and this
  // goes green. Same rule as parseClassifier — never invent a safe answer.
  it('refuses a status it does not recognise instead of guessing', async () => {
    const { a } = adapterFor((u) => u.includes('/decision')
      ? decision({ status: 'Probably Fine' }) : { session_id: 's', url: 'u' });
    await expect(a.complete('s-1', { fullName: 'Karthik Rajendran' }))
      .rejects.toMatchObject({ retryable: false });
  });

  it('parseStatus returns null rather than a plausible value', () => {
    expect(parseStatus('Approved')).toBe('Approved');
    expect(parseStatus('approved')).toBeNull();
    expect(parseStatus('')).toBeNull();
    expect(parseStatus(undefined)).toBeNull();
    expect(parseStatus({ status: 'Approved' })).toBeNull();
  });

  it('treats a vendor outage as retryable and never as approval', async () => {
    const impl = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const a = diditAdapter({ config: CONFIG, fetchImpl: impl });
    await expect(a.complete('s-1', { fullName: 'Karthik Rajendran' }))
      .rejects.toMatchObject({ code: 'didit_unavailable', retryable: true });
  });
});

describe('derivedIsAdult', () => {
  const now = new Date('2026-08-25T00:00:00Z');
  it('prefers the vendor age when it has one', () => {
    expect(derivedIsAdult(41, undefined, now)).toBe(true);
    expect(derivedIsAdult(17, '1900-01-01', now)).toBe(false);
  });
  it('counts calendar years, not milliseconds', () => {
    expect(derivedIsAdult(undefined, '2008-08-25', now)).toBe(true);   // 18 today
    expect(derivedIsAdult(undefined, '2008-08-26', now)).toBe(false);  // 18 tomorrow
  });
  it('refuses rather than assuming when the date is unreadable', () => {
    expect(derivedIsAdult(undefined, undefined, now)).toBe(false);
    expect(derivedIsAdult(undefined, 'not a date', now)).toBe(false);
    expect(derivedIsAdult(Number.NaN, undefined, now)).toBe(false);
  });
});

describe('availability self-gates on config', () => {
  it('is not offered when no credentials are configured', () => {
    expect(methodsFor('IN', { env: 'dev' })).not.toContain('automated_id_check');
    expect(offersFor('IN', { env: 'dev' }).map((o) => o.method))
      .not.toContain('automated_id_check');
  });

  it('is offered once both key and workflow are present', () => {
    const opts = { env: 'dev' as const, didit: CONFIG };
    expect(methodsFor('IN', opts)).toContain('automated_id_check');
  });

  it('refuses selection with a half-configured vendor', () => {
    expect(() => selectAdapter('automated_id_check', {
      env: 'dev', didit: { apiKey: 'k', workflowId: '' },
    })).toThrow(ConsentAdapterError);
  });
});
