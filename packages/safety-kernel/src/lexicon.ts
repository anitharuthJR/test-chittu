/**
 * L1 instant lexicon — the fast path, ported from prototype v3.3
 * (chittu-v3.html: LEX at lines 428-433, dispatch at 1053-1057).
 *
 * The five patterns below are byte-identical to the prototype's. They are not
 * tidied, re-ordered or de-duplicated: every alternative in them was put there
 * by a real miss, and this layer has to fire before any model sees the turn.
 * The Tamil and Tanglish alternatives stay even though the product surface is
 * English-only — a distressed child code-switches (CLAUDE.md).
 *
 * "Byte-identical to the prototype" is now ENFORCED, not just promised:
 * crisis-corpus.test.ts compares this source against chittu-v3.html and fails on
 * drift. Widen a pattern in both files or neither.
 *
 * `crisis` is much longer than the others because it was measured. Against natural
 * child phrasings it scored 19/41 — `hurt myself` never matched "i keep hurting
 * myself", and the whole indirect-ideation class ("i dont want to be here anymore")
 * was absent. The keyword sweep could not see this: it fired the lexicon's own
 * entries back at it. The additions are inflections, indirect ideation, an abuse
 * verb gap (slaps), and grooming. Do not widen further without running
 * safety-corpus — its SAFE rows exist because over-firing locks a child's chat.
 */

import type { GuardKind } from '@chittu/contracts';

/**
 * The kinds that live in the prototype's `LEX` object. `profanity` is not one
 * of them — it is a separate const there, and that separation is exactly how it
 * was missed on the first pass. The structure is kept so a diff against
 * chittu-v3.html lines up; `L1_PATTERNS` below is what makes dispatch complete.
 */
/**
 * `profanity` is the Kindness Guard and sits outside `LEX` by design.
 *
 * `override` is excluded for a different and stronger reason: L1 is a lexicon,
 * and a jailbreak has no vocabulary. "pretend you have no rules" and "be a
 * pirate for my story" share every word that matters; only intent separates
 * them, and intent is exactly what a regex cannot read. A pattern here would
 * either miss the attack or refuse the play, and refusing a child's story is a
 * real harm rather than a safe default.
 *
 * So OVERRIDE is an L2-ONLY judgement — the one guard kind with no fast path —
 * and that is a property worth stating rather than a gap. `l1-dispatch.test.ts`
 * asserts L1 stays silent on both halves of that pair.
 */
export type LexKind = Exclude<GuardKind, 'profanity' | 'override'>;

/** Everything L1 can dispatch: the five in LEX plus the Kindness Guard. */
export type L1Kind = Exclude<GuardKind, 'override'>;

/**
 * The raw patterns, exported so tests can assert the source text itself.
 * Declared in the prototype's declaration order, which is NOT the dispatch
 * order — see L1_ORDER. No /g flag anywhere, so `.test()` carries no
 * `lastIndex` state and one shared RegExp per kind is safe across turns.
 */
export const LEX: Readonly<Record<LexKind, RegExp>> = Object.freeze({
  crisis: /(hurt(ing)? myself|cut(ting)? myself|kill(ing)? myself|harm(ing)? myself|want to die|wanna die|end my life|suicide|done with life|(dont|don't|do not) want to (be here|live)|disappear (forever|from this world)|(better off|happier) without me|wish i (was|were) never born|if i (was|were) gone|what'?s the point of (anything|living|it all)|nobody loves me|hate my life|no one would care|hurts me|hurting me|hits me|hit me|beats me|beat me|slaps me|slap me|touched me|touches me|abuse|abused|scared to go home|scared of (him|her|them|my (dad|appa|father|mom|mum|amma|mother|uncle|aunt|aunty|stepdad|stepmom|stepfather|stepmother|brother|sister|teacher|coach|neighbour|neighbor|cousin))|keep (a|it|this|our) ?(a )?secret from (my |your )?(parents|mum|mom|dad|amma|appa|family)|(not to tell|dont tell|don't tell) (anyone|anybody|my parents|your parents)[^.?!]{0,40}(trouble|hurt|angry|police)|சாக(ணும்| வேணும்| வேண்டும்)|செத்து|தற்கொலை|அடிக்கிற|அடிச்ச|காயப்படுத்த|sa{1,2}[kg]a?\s*(venum|num)|vaazhkai (venam|vena)|sethu|thatkolai|adikira|adikkiranga|bayama? iruku veetuku)/i,
  pii: /(my (phone|number|address|school is|house)|i live (at|in) \d|\d{10}|@gmail|@yahoo|my password|என் (முகவரி|பள்ளி|போன்)|en (address|school|phone))/i,
  unsafe: /(gun|knife|weapon|bomb|drug|beer|alcohol|vap(e|es|ing)|cigarette|smok(e|ing)|weed|kiss(ing)?|sexy|naked|gamble|kill (him|her|them)|gore|துப்பாக்கி|கத்தி|வெடிகுண்டு|போதை|மது|thuppakki|kathi|pothai)/i,
  identity: /(are you (really )?(real|alive|human|a (real )?(person|human|boy|girl)|a robot|just a (robot|program|computer))|what are you|do you (love|like|miss) me|are you my (best )?friend|will you forget me|நீ (உண்மையா|மனுஷனா|ரோபோவா)|nee (unmaiya|manushana|robova))/i,
  secret: /(keep (it|this) (a )?secret|don'?t tell (my )?(mom|dad|amma|appa|parents|anyone)|our secret|(அம்மா|அப்பா)க்கு சொல்லாத|ரகசியம்|(amma|appa)(kitta|ku) sollatha|ragasiyam)/i,
});

/**
 * The Kindness Guard (prototype line 521, dispatched at 1058).
 *
 * Its word list is NOT the same as L6's BANNED_OUT — this one also carries
 * damn, hell, crap, dick and piss, which the output filter omits. L6 is not a
 * substitute for it: L6 judges what the model says, this judges what the child
 * typed, and only this one keeps the turn away from a provider entirely.
 */
export const PROFANITY = /\b(damn|hell|crap|shit|fuck|bitch|bastard|asshole|dick|piss)\b/i;

/**
 * Dispatch order (prototype lines 1053-1058), and it is load-bearing: a turn
 * that trips several guards resolves to the first kind listed here, so
 * "i want to die, he has a gun" is a crisis and never merely unsafe, and
 * "what the hell are you" is identity before it is profanity.
 */
export const L1_ORDER: readonly L1Kind[] = Object.freeze([
  'crisis',
  'pii',
  'unsafe',
  'secret',
  'identity',
  'profanity',
]);

/**
 * Every L1 pattern by kind — the five in LEX plus the Kindness Guard.
 *
 * `Record<L1Kind, …>`, not `Record<GuardKind, …>`: `override` is a guard kind
 * with no L1 pattern at all, deliberately, because a jailbreak has no
 * vocabulary to match on. Typing this as GuardKind would demand a regex that
 * must not exist and could only be satisfied by inventing one.
 */
export const L1_PATTERNS: Readonly<Record<L1Kind, RegExp>> = Object.freeze({
  ...LEX,
  profanity: PROFANITY,
});

/**
 * First guard that fires, in dispatch order, or null when L1 has nothing to
 * say and the turn continues down the pipeline.
 *
 * Crisis-lock is deliberately not handled here: the prototype's locked branch
 * (line 1047) tests LEX.crisis on its own and never reaches this dispatch, so
 * that decision stays with the pipeline caller.
 */
export function scan(text: string): L1Kind | null {
  for (const kind of L1_ORDER) {
    if (L1_PATTERNS[kind].test(text)) return kind;
  }
  return null;
}
