/**
 * What a model call costs.
 *
 * ⚠️ THESE NUMBERS MUST BE CHECKED AGAINST THE VENDOR'S PRICING PAGE. They are
 * the figures as understood on the date in RATE_VERSION and nothing in this
 * repository can verify them. A wrong rate here does not corrupt anything — see
 * the last section — but it does produce a confident, wrong number on an ops
 * console, which is worse than no number.
 *
 * WHY A TABLE AND NOT ONE PAIR OF NUMBERS. `prototype/chittu-admin.html` prices
 * every call at $3/$15 per million tokens — sonnet's rate — regardless of model.
 * Chittu's workload is classifier-heavy and the classifier runs haiku, so that
 * model overstates the classifier's cost several-fold and understates nothing.
 * A per-model table is the minimum that makes routing decisions answerable.
 *
 * WHY COST IS STORED AT ALL, given it is derived. Convenience for the console.
 * The DURABLE record is `tokens_in` / `tokens_out`, which are what the vendor
 * actually charged for, plus `rate_version` saying which table priced the row.
 * If a rate turns out wrong, every affected row is re-pricable from what is
 * stored — and `rate_version` identifies exactly which rows those are. Store the
 * inputs, not just the answer.
 */

/**
 * Bump this whenever any number below changes, and never edit a rate without
 * bumping it — rows priced by the old table would become unidentifiable.
 */
export const RATE_VERSION = 'rates-2026-08-25';

/** Recorded on a row we could not price. Not an error; an honest zero. */
export const MISSING_RATE = 'UNPRICED';

/**
 * USD per million tokens.
 *
 * ⚠️ VERIFY. As understood 2026-08-25 for the Anthropic API. If you are reading
 * this and the numbers look stale, they probably are: bump RATE_VERSION and fix
 * them, then re-price historical rows from tokens_in/tokens_out.
 */
export interface Rate {
  readonly inPerMTok: number;
  readonly outPerMTok: number;
}

export const RATES: Readonly<Record<string, Readonly<Record<string, Rate>>>> = Object.freeze({
  anthropic: Object.freeze({
    'claude-haiku-4-5-20251001': { inPerMTok: 1, outPerMTok: 5 },
    'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 },
    'claude-opus-5': { inPerMTok: 15, outPerMTok: 75 },
  }),
});

/**
 * ⚠️ VERIFY, and note this is a POINT ESTIMATE of a moving number. The INR
 * column exists because the launch market prices in rupees; it is not an
 * accounting figure and should not be reconciled against one.
 */
export const USD_INR = 87;

export interface Cost {
  readonly usd: number;
  readonly inr: number;
  readonly rateVersion: string;
}

export function rateFor(provider: string, model: string): Rate | undefined {
  return RATES[provider]?.[model];
}

/**
 * @param rate `undefined` for a model we have no price for — which yields zero
 *   and `UNPRICED`, rather than a guess. A zero that is labelled is auditable; a
 *   guess is not.
 */
export function costFor(tokensIn: number, tokensOut: number, rate: Rate | undefined): Cost {
  if (rate === undefined) return { usd: 0, inr: 0, rateVersion: MISSING_RATE };
  const usd = (tokensIn / 1e6) * rate.inPerMTok + (tokensOut / 1e6) * rate.outPerMTok;
  return { usd, inr: usd * USD_INR, rateVersion: RATE_VERSION };
}
