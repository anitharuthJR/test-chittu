/**
 * Does the name a parent typed describe the same person as the name on their ID?
 *
 * This file is pure on purpose: no network, no vendor types, no clock. It holds
 * the only genuinely interesting logic on the automated consent rail, and it
 * needs to be testable against a corpus of names written the way parents write
 * them rather than the way a normaliser produces them.
 *
 * WHY THIS IS NOT A STRING COMPARISON
 *
 * Chittu launches in India. A parent in Tamil Nadu writes `R. Karthik` or
 * `Karthik R`; the passport reads `KARTHIK RAJENDRAN`, because the initial is
 * the father's name and is not a middle name at all. Documents disagree about
 * name order. Married names differ from the ID. Diacritics survive in some
 * renderings and not others. An exact match would reject a large share of
 * legitimate parents on the one gate that blocks launch — which is not a safe
 * default, it is a broken product.
 *
 * WHY IT IS NOT FUZZY EITHER
 *
 * A tuned similarity threshold on a legal gate is indefensible to a regulator
 * ("why 0.82?"). Transliteration variance — `Krishna` against `KRISHNAN` — is
 * absorbed by letting the parent correct what they typed and re-match against
 * the same session, and by the human fallback after that. Structure, not
 * scoring.
 */

/**
 * Titles that carry no identity. Dropped before matching so `Dr Priya` and
 * `PRIYA KRISHNAN` are not held apart by a word neither document means.
 *
 * `md` is deliberately absent. In South Asia it abbreviates Mohammad — a given
 * name, and for many parents the ONLY token their ID and their typing share.
 * Stripping it would fail exactly the families it looks like it is helping.
 */
const HONORIFICS: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir',
  'shri', 'sri', 'smt', 'thiru', 'thirumathi', 'selvi', 'kumari',
]);

/**
 * Fold to comparable tokens.
 *
 * NFKD then stripping the combining range turns `José` into `jose`; punctuation
 * becomes space so `R.` and `R` and `R-` all yield `r`; case is flattened
 * because documents shout and people do not.
 */
export function normaliseName(raw: string): readonly string[] {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // combining marks left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0 && !HONORIFICS.has(t));
}

/** Equal, or one is the other's initial. `r` matches `rajendran`. */
function tokensAgree(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  return false;
}

export interface NameMatch {
  readonly matched: boolean;
  /** Why not, for a message to the parent. Never contains either name. */
  readonly reason?: 'empty' | 'no-shared-word' | 'unmatched-token';
}

/**
 * Order-insensitive token match with initial expansion.
 *
 * Two rules, and the second is load-bearing:
 *
 *   1. every token of the SHORTER name must find a partner in the longer one —
 *      so `Karthik` matches `KARTHIK RAJENDRAN` (a parent who omits the
 *      surname) while `Priya Sharma` does not match `PRIYA KRISHNAN` (a married
 *      name the parent must correct or take to the human rail);
 *   2. at least one of those partnerships must be between two FULL words.
 *
 * Without (2), `K` alone matches `KARTHIK RAJENDRAN` — a single letter becomes
 * a wildcard that passes any ID sharing one initial, which is not verification.
 */
export function matchesIdName(typed: string, onDocument: string): NameMatch {
  const a = normaliseName(typed);
  const b = normaliseName(onDocument);
  if (a.length === 0 || b.length === 0) return { matched: false, reason: 'empty' };

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  // Each token of the shorter name consumes a DISTINCT partner: two initials
  // must not both claim the same surname.
  const taken = new Array<boolean>(long.length).fill(false);
  let sharedWord = false;

  for (const t of short) {
    let hit = -1;
    // Prefer an exact partner over an initial one, so `r` cannot steal the
    // slot that `rajendran` needs.
    for (let i = 0; i < long.length; i++) {
      if (!taken[i] && long[i] === t) { hit = i; break; }
    }
    if (hit === -1) {
      for (let i = 0; i < long.length; i++) {
        if (!taken[i] && tokensAgree(t, long[i]!)) { hit = i; break; }
      }
    }
    if (hit === -1) return { matched: false, reason: 'unmatched-token' };
    taken[hit] = true;
    if (t.length > 1 && long[hit]!.length > 1) sharedWord = true;
  }

  if (!sharedWord) return { matched: false, reason: 'no-shared-word' };
  return { matched: true };
}
