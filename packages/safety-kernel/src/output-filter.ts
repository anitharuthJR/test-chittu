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
 * Pure: no I/O, no clock, no state. Both regexes are un-flagged for /g, so `.test`
 * carries no lastIndex between calls and the module-level constants are safe.
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
   artefact. */
export function stripControlTokens(text: string): string {
  if (!text) return '';
  let out = text;
  if (out.indexOf('</think>') !== -1) {            // drop reasoning up to the LAST close
    out = out.slice(out.lastIndexOf('</think>') + 8); // 8 = '</think>'.length
  }
  out = out.replace(/<\/?(think|tool_call|thinking|reasoning)>/gi, ' ');
  out = out.replace(/<\|[^|>]*\|>/g, ' ');         // <|im_start|>-style special tokens
  return out.replace(/\s+/g, ' ').trim();
}
