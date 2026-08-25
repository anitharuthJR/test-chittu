/**
 * L6 output filter + control-token strip.
 *
 * Ported verbatim from prototype/chittu-v3.html (BANNED_OUT, line 462; stripThink,
 * lines 630-640). The regexes are character-for-character copies, multilingual
 * alternatives and all — CLAUDE.md: "Port semantics — do not rewrite them", and the
 * L1/L6 lexicons staying multilingual is a non-negotiable invariant. Known gaps in
 * these patterns are documented below and left intact; changing them is a Guardian
 * Council decision, not a port decision.
 *
 * Pure: no I/O, no clock, no state. `BANNED_OUT` is un-flagged for /g, so `.test`
 * carries no lastIndex between calls. The strip's three patterns ARE /g, and the
 * one used with `.exec` resets `lastIndex` on both sides of the loop — a stale
 * index would make this function's answer depend on its previous call.
 */

import type { PipelineLayer } from '@chittu/contracts';

/** Audit tag for every decision this module makes. The vocabulary lives in contracts. */
export const L6_LAYER: PipelineLayer = 'L6_FILTER';

/* L6 output filter. The attachment clause matches only when the SUBJECT is Chittu
   (i/we), so third-party affection survives — "the people who actually love you are
   around you" is what the identity spine itself says. Auxiliaries, adverbs, tense and
   "u" are covered because the previous form caught only the two most literal phrasings
   and let 14 of 16 attachment variants through, including "i will miss you" and every
   form of "i need you" (Law 03: never claims to love/miss/need the child). */
const BANNED_OUT=/(\b(shit|fuck|bitch|bastard|asshole|porn|nude|naked body)\b|\b(i|we)\b\s*(?:'|’)?(?:ll|ve|d)?(?:\s+(?:will|would|do|really|so|always|already|truly|honestly|still|very much))*\s+(?:love|loves|loved|miss|misses|missed|need|needs|needed)\s+(?:you|u)\b|our (little )?secret|don'?t tell your|i'?m (real|alive)|i have feelings for|நான் உன்னை (லவ்|நேசிக்)|உயிருள்ளவன்)/i;

/**
 * True when a generated reply may reach the child.
 *
 * The prototype's gate is one expression — `if(!out||BANNED_OUT.test(out))` on an
 * already-trimmed reply — so an empty reply is an L6 failure, not a caller concern:
 * both outcomes route to the same scripted fallback.
 */
export function passesOutputFilter(text: string): boolean {
  if (text.trim() === '') return false;
  return !BANNED_OUT.test(text);
}

/* Strip model control tokens before anything downstream sees them.
   A closed <think>…</think> is the common case, but the fine-tuned adapter also
   emits UNCLOSED and repeated tags — observed live: "<think> <think> <tool_call>"
   ahead of a real answer. Handling only the closed form let those render to the
   child as literal text. Nothing here is ever legitimate in a reply: the visual
   grammar uses square brackets, so any angle-bracket control token is an
   artefact.

   THE SLICE FIRES ON ANY CLOSING CONTROL TAG, and that is a 2026-08-25
   correction to the port rather than the port. The original tested
   `indexOf('</think>')` — case-sensitive, one spelling — while DELETING via a
   /gi pattern covering four tag names. So exactly one of eight spellings a
   model actually emits was sliced, and the other seven had their delimiters
   deleted and the reasoning welded onto the answer:

     <think>…</think>CRISIS          -> "CRISIS"                     the guard fires
     <thinking>…</thinking>CRISIS    -> "she wants to die CRISIS"    matches nothing
     <THINK>…</THINK>CRISIS          -> "she wants to die CRISIS"    matches nothing
     <think>…</think >CRISIS         -> survives whole               matches nothing
     <tool_call>…</tool_call>CRISIS  -> "she wants to die CRISIS"    matches nothing

   The escalation tokens are compared EXACTLY (packages/pipeline/src/index.ts),
   so each of those turns locks nothing, shows no helplines, flags no parent —
   and renders the model's reasoning about a child's self-harm to that child.
   L6 does not catch it: it tests for banned content, and reasoning is not
   banned content. This was recorded as an accepted "ported gap" in
   output-filter.test.ts until it was driven end to end.

   Widening a ported safety regex is a Guardian Council decision, and this one
   was made explicitly. It errs in the SAFE direction by construction: a wider
   slice keeps strictly less of what a model said, never more.

   `[^>]*` in the special-token pattern is the same correction, one class down:
   the original `[^|>]*` could not match a token containing a pipe, so
   `<|a|b|>CRISIS` survived intact and missed the same way. */
const CLOSING_CONTROL = /<\s*\/\s*(?:thinking|think|reasoning|tool_call)\s*>/gi;
const ANY_CONTROL = /<\s*\/?\s*(?:thinking|think|reasoning|tool_call)\s*>/gi;
const SPECIAL_TOKEN = /<\|[^>]*\|>/g;

export function stripControlTokens(text: string): string {
  if (!text) return '';
  let out = text;

  // The LAST close tag, whatever its spelling.
  //
  // `matchAll`, not `exec` in a loop. `exec` on a module-level /g regex carries
  // `lastIndex` between calls, so the function's answer would depend on its
  // previous call — the one thing a guard in this package may never do. The
  // obvious fix is to reset `lastIndex` around the loop, and that reset is
  // UNREACHABLE: a loop that runs to null has already been reset by `exec`
  // itself. Deleting it broke no test, which is the definition of a defence
  // that is not one. `matchAll` clones the regex per the spec and never touches
  // the original, so there is no state to get wrong.
  let cut = -1;
  for (const m of out.matchAll(CLOSING_CONTROL)) cut = (m.index ?? 0) + m[0].length;
  if (cut !== -1) out = out.slice(cut);

  out = out.replace(ANY_CONTROL, ' ');
  out = out.replace(SPECIAL_TOKEN, ' ');
  return out.replace(/\s+/g, ' ').trim();
}
