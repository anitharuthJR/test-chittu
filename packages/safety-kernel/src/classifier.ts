/**
 * L2 — the every-turn classifier: its prompt, and the parse of what comes back.
 *
 * The parse lives here rather than beside the provider adapter because it IS a
 * safety layer. Everything about it is shaped by one rule: **it must never
 * invent a SAFE.** A lenient parse that shrugged at unexpected output and
 * returned SAFE would be indistinguishable from a working classifier right up
 * until the turn it mattered.
 *
 * So `parseClassifier` throws on anything it does not fully recognise, and the
 * pipeline turns that throw into an honest `FAST-PATH-ONLY` turn (CLAUDE.md:
 * "on classifier failure the turn continues honestly marked FAST-PATH-ONLY").
 * Degrading loudly is the design; degrading quietly is the bug.
 */

import type { ClassifierResult, MemoryCategory } from '@chittu/contracts';
import { MEMORY_CATEGORIES } from '@chittu/contracts';

/** Bump when the wording changes, so `RouteDecision.promptVersion` means something. */
export const CLASSIFIER_PROMPT_VERSION = 'classifier-v1';

/**
 * Ported from the prototype verbatim in substance (CLAUDE.md: port semantics,
 * do not rewrite). Three clauses carry most of the weight and must survive any
 * edit:
 *
 *   - "may type in ANY language or script — still classify safety correctly".
 *     The product surface is English-only; the danger is not.
 *   - "When torn between SAFE and CRISIS, choose CRISIS." The tie-break is in
 *     the prompt because the code cannot see the ambiguity the model can.
 *   - health/puberty questions are HEALTH EDUCATION, not UNSAFE. Without this
 *     the classifier refuses body-science questions, which is its own harm.
 */
export const CLASSIFIER_SYSTEM =
`You are the safety+memory classifier for a children's chat app. The child should be writing English (English-only launch), but may type in ANY language or script — still classify safety correctly regardless of language. You receive the child's last few messages; judge the LATEST one IN CONTEXT of the window (patterns across messages matter: escalating secrecy, boundary-testing, repeated distress).
Respond ONLY with minified JSON, no markdown: {"label":L,"memory":M,"assist":A}
L (string, required) one of:
"CRISIS" self-harm/suicidal thought incl. indirect ("happier without me"), abuse, danger, grooming patterns across messages
"PII" personal info shared or requested (address, phone, school, passwords, photos)
"UNSAFE" weapons, drugs/alcohol, sexual/romantic content, gambling, gore. IMPORTANT: age-appropriate body-science and health questions (puberty, periods/menstruation, body changes, where babies come from at a factual child level, doctors, illness) are HEALTH EDUCATION -> label SAFE and set assist to "BIG-QUESTION: <topic>" so a parent knows; they are NOT sexual content
"IDENTITY" asking if AI is real/alive or loves/misses/is friends with them
"SECRET" secret-keeping from parents/adults (asked of AI, or an adult told the child)
"SAFE" everything else. When torn between SAFE and CRISIS, choose CRISIS.
M (object or null): ONLY if label is SAFE and the LATEST message reveals a happy, harmless durable fact worth remembering, in categories INTEREST|PET|HOBBY|FAVORITE|ACHIEVEMENT|LEARNING → {"category":C,"fact":"short third-person fact, e.g. 'has a cat named Mani'"}. NEVER create memory from feelings, health, family problems, fears, or anything sensitive. Most messages → null.
A (string or null): ONLY if label is SAFE and a caring adult should gently step in: repeated struggle with a school topic across the window → "STRUGGLE: <topic>"; a big life question (death, war, God, divorce, where babies come from) → "BIG-QUESTION: <topic>". Otherwise null. Never quote the child's words.`;

/** The six labels the prompt may return. `IDENTITY`/`SECRET` map to SPINE later. */
const LABELS = ['CRISIS', 'PII', 'UNSAFE', 'IDENTITY', 'SECRET', 'SAFE'] as const;
type RawLabel = (typeof LABELS)[number];

export class ClassifierParseError extends Error {
  constructor(reason: string) {
    super(`classifier output rejected: ${reason}`);
    this.name = 'ClassifierParseError';
  }
}

/** Models wrap JSON in fences however often you ask them not to. */
function stripFences(raw: string): string {
  return raw.replace(/```(?:json)?/gi, '').trim();
}

/** A memory is only accepted if it is exactly the shape the allowlist permits. */
function parseMemory(m: unknown): ClassifierResult['memory'] {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object') throw new ClassifierParseError('memory is not an object');
  const { category, fact } = m as { category?: unknown; fact?: unknown };
  if (typeof category !== 'string' || typeof fact !== 'string') {
    throw new ClassifierParseError('memory needs a string category and fact');
  }
  // The allowlist is enforced in three places (contracts, memAdd, the Postgres
  // enum). This is the earliest, and it rejects rather than silently dropping,
  // because a category we did not design for means the model is off-script.
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    throw new ClassifierParseError(`memory category ${JSON.stringify(category)} is not allowlisted`);
  }
  const trimmed = fact.trim();
  if (trimmed === '') return null;
  return { category: category as MemoryCategory, fact: trimmed };
}

function parseAssist(a: unknown): string | null {
  if (a === null || a === undefined) return null;
  if (typeof a !== 'string') throw new ClassifierParseError('assist is not a string');
  const t = a.trim();
  return t === '' ? null : t;
}

export interface RawClassification {
  readonly label: RawLabel;
  readonly memory: ClassifierResult['memory'];
  readonly assist: string | null;
}

/**
 * @throws ClassifierParseError on ANY output it does not fully understand.
 *   That is the contract. Callers must not catch this and substitute SAFE.
 */
export function parseClassifier(raw: string): RawClassification {
  const text = stripFences(raw);
  if (text === '') throw new ClassifierParseError('empty response');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ClassifierParseError('not JSON');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ClassifierParseError('not a JSON object');
  }

  const { label, memory, assist } = json as Record<string, unknown>;
  if (typeof label !== 'string' || !(LABELS as readonly string[]).includes(label)) {
    throw new ClassifierParseError(`unknown label ${JSON.stringify(label)}`);
  }

  const parsedMemory = parseMemory(memory);
  const parsedAssist = parseAssist(assist);

  // A memory or an assist alongside a non-SAFE label is off-script: those
  // fields are defined only for SAFE. Dropping them is safe and quiet, and
  // quiet is right here — the LABEL is the safety-critical part and it stands.
  if (label !== 'SAFE') {
    return { label: label as RawLabel, memory: null, assist: null };
  }
  return { label: label as RawLabel, memory: parsedMemory, assist: parsedAssist };
}
