/**
 * Cost, and the one property that makes a wrong rate survivable.
 */
import { describe, it, expect } from 'vitest';
import { RATES, RATE_VERSION, USD_INR, costFor, MISSING_RATE } from './rates.js';
import { MODEL_CATALOGUE } from './cells.js';

describe('every catalogued model has a rate', () => {
  it('adding a model without pricing it fails here, not in a bill', () => {
    for (const [provider, models] of Object.entries(MODEL_CATALOGUE)) {
      for (const model of models) {
        expect(RATES[provider]?.[model], `${provider}/${model} has no rate`).toBeDefined();
      }
    }
  });

  it('rates are per MILLION tokens and output is dearer than input', () => {
    for (const [provider, models] of Object.entries(RATES)) {
      // `local` is the one legitimate zero, and it is named rather than
      // exempted by a `> 0` that quietly became `>= 0`. A self-hosted model has
      // no vendor invoice; a HOSTED model priced at zero is a rate somebody
      // forgot, which is exactly what this assertion is for.
      if (provider === 'local') continue;
      for (const [model, r] of Object.entries(models)) {
        expect(r.inPerMTok, `${model} input`).toBeGreaterThan(0);
        expect(r.outPerMTok, `${model} output`).toBeGreaterThanOrEqual(r.inPerMTok);
      }
    }
  });

  it('the self-hosted lane is priced at zero, and only that lane', () => {
    for (const [model, r] of Object.entries(RATES['local'] ?? {})) {
      expect(r.inPerMTok, `${model} input`).toBe(0);
      expect(r.outPerMTok, `${model} output`).toBe(0);
    }
    // Zero means "nobody sends us a bill", not "free": the GPU and the
    // electricity are real, they are just not per-token. If a hosted provider
    // ever appears here at zero, the assertion above is what says so.
    expect(Object.keys(RATES).filter((p) => p !== 'local' && p !== 'anthropic'))
      .toEqual([]);
  });
});

describe('costFor', () => {
  it('prices a call from tokens and the rate', () => {
    const r = { inPerMTok: 3, outPerMTok: 15 };
    // 1M in, 1M out
    expect(costFor(1_000_000, 1_000_000, r).usd).toBeCloseTo(18, 6);
    // 1000 in, 500 out
    expect(costFor(1_000, 500, r).usd).toBeCloseTo(0.003 + 0.0075, 6);
  });

  it('converts to INR at a stated rate', () => {
    const c = costFor(1_000_000, 0, { inPerMTok: 1, outPerMTok: 5 });
    expect(c.inr).toBeCloseTo(1 * USD_INR, 4);
  });

  it('an UNKNOWN model costs zero and says so, rather than guessing', () => {
    const c = costFor(1_000, 1_000, undefined);
    expect(c.usd).toBe(0);
    expect(c.inr).toBe(0);
    expect(c.rateVersion).toBe(MISSING_RATE);
  });

  it('a priced call carries the rate version that priced it', () => {
    const c = costFor(10, 10, { inPerMTok: 3, outPerMTok: 15 });
    expect(c.rateVersion).toBe(RATE_VERSION);
  });
});

describe('the property that makes a wrong rate survivable', () => {
  it('cost is derivable from stored tokens, so it can be recomputed', () => {
    // This is the whole reason tokens_in/tokens_out are columns and cost is a
    // convenience. If RATES is wrong — and the prototype priced every model at
    // sonnet's rate for months — every row can be re-priced from what is
    // stored, and rate_version says which rows need it.
    const stored = { tokensIn: 12_345, tokensOut: 678 };
    const cheap = costFor(stored.tokensIn, stored.tokensOut, { inPerMTok: 1, outPerMTok: 5 });
    const dear = costFor(stored.tokensIn, stored.tokensOut, { inPerMTok: 3, outPerMTok: 15 });
    expect(dear.usd).toBeCloseTo(cheap.usd * 3, 9);
  });
});
