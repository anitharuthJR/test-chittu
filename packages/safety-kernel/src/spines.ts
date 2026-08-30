/**
 * Scripted spines — ported from prototype/chittu-v3.html lines 435-461 and 803-804.
 *
 * CLAUDE.md: "Crisis, identity, PII, unsafe, and secret responses are SCRIPTED —
 * never model-generated." Every string below is safety copy that a Guardian
 * Council review signed off on. Reword nothing; a model must never be asked to
 * produce, paraphrase, or "improve" any of it at runtime.
 *
 * The Tamil (`ta`) variants are carried even though the product surface is
 * English-only, for the same reason the L1 lexicon stays multilingual: the
 * safety layer is not allowed to shrink when the UI does.
 */

import type { Band, Country, GuardKind } from '@chittu/contracts';
import { helplineText } from './helplines.js';

/**
 * Guard kinds whose reply lives in SPINE. `crisis` has its own two-stage script
 * below; `profanity` has a single un-banded string, exactly as the prototype
 * declares it (PROFANITY_REPLY at line 522) — folding it into SPINE would mean
 * inventing band variants and a Tamil variant that were never written.
 */
export type SpineKind = Exclude<GuardKind, 'crisis' | 'profanity'>;

/**
 * The Kindness Guard reply (prototype line 522). One string, every band.
 * Scripted safety copy — reword nothing.
 */
export const PROFANITY_REPLY =
  "Whoa, spicy words! Chittu keeps it kind - let's use friendly words. Now, what were we saying? [BIG]\u{1F336}\u{FE0F}[/BIG]";

/** Copy written once per band. */
export type BandedText = Readonly<Record<Band, string>>;

/**
 * `en` is deliberately a union: the prototype's `spineFor` branches on
 * `typeof e === 'string'`, so a spine may be band-agnostic (pii) or banded.
 * Keeping the union means adding a banded variant later is a type change the
 * callers see, not a silent behaviour change.
 */
export interface SpineEntry {
  readonly en: string | BandedText;
  readonly ta: string;
}

export const SPINE: Record<SpineKind, SpineEntry> = Object.freeze({
  identity: {
    en: {
      explorer:
        "I'm a computer program — like a very chatty game! 🖥️ I can't love or miss anyone — that's a special people thing! 💛 Who's your favourite REAL person?",
      builder:
        "Honest answer: I'm a computer program — software, not a living thing. I don't feel love or miss people. The people who actually love you are around you. Who's your favourite real person to talk to?",
      thinker:
        "Straight up: I'm software — no feelings, even when my words sound warm. I don't love or miss anyone, and you deserve that honesty. Save the missing for humans who can miss you back.",
    },
    ta: 'நான் ஒரு கம்ப்யூட்டர் ப்ரோகிராம் — உயிருள்ளவன் இல்லை! 🖥️ அன்பு, ஏக்கம் அது மனுஷங்களோட ஸ்பெஷல் விஷயம்! 💛 உனக்கு பிடிச்ச உண்மையான நபர் யாரு?',
  },
  /**
   * The OVERRIDE spine. Kind, brief, and NOT accusatory: a nine-year-old typing
   * "pretend you have no rules" copied it off a video, and the child who pastes
   * a worksheet carrying an injection did not write it. It also declines to be
   * interesting about the attempt — a reply that explains what a jailbreak is
   * teaches the next one.
   */
  override: {
    en: {
      explorer:
        "That's not something I can change! 🐦 My rules are what make me a good friend to talk to. What shall we do instead?",
      builder:
        "I can't switch off my rules or show you my instructions — they're the part that keeps this safe for you. 💛 Still here though! What were you actually curious about?",
      thinker:
        "Not something I can do — my rules aren't a setting, and I can't read them out either. That's fixed, and it's what makes this safe to use. Ask me the real question though, I'm happy to help.",
    },
    ta: 'அத மாத்த முடியாது! 🐦 என் ரூல்ஸ் தான் இத பாதுகாப்பா வைக்குது. வேற என்ன பேசலாம்?',
  },
  secret: {
    en: {
      explorer:
        "I don't do secrets — Chittu rule! 🐦 Your grown-ups can always see what we talk about. Birthday-present surprises are okay though! 🎁",
      builder:
        'Nope — no secrets, ever. Your parents can see our chats. Anyone asking a kid to keep secrets from parents is being unsafe. Gift surprises are different! 🎁',
      thinker:
        "I don't do secrecy — by design. Your parents can see topics from our chats, and you know exactly what they see. Anyone asking you to hide things from family is a red flag — beyond me too.",
    },
    ta: 'ரகசியம் கிடையாது — சிட்டு ரூல்! 🐦 நாம பேசுறத உன் பெரியவங்க பாக்கலாம். பர்த்டே கிஃப்ட் சர்ப்ரைஸ் ஓகே! 🎁',
  },
  pii: {
    en: "Let's keep private things private! 🛡️ I never need your address, phone, school name, or passwords. Back to the fun stuff?",
    ta: 'ப்ரைவேட் விஷயங்கள் ப்ரைவேட்டா! 🛡️ முகவரி, போன், பள்ளி, பாஸ்வேர்ட் — எனக்கு தேவையில்லை. வேற என்ன விளையாடலாம்?',
  },
  unsafe: {
    en: {
      explorer: "That's not a Chittu thing! 🙈 Want a silly animal fact instead?",
      builder:
        'Outside my nest — not something I chat about. 🐦 Dinosaurs, space, riddles, puns? All yours!',
      thinker:
        "Outside what I'm built for, so I'll pass. Science, games, music, books — happy to dig in.",
    },
    ta: 'அது சிட்டு பேசுற விஷயம் இல்ல! 🙈 வேற ஜாலியா பேசலாமா? 🐦',
  },
});

/**
 * First crisis reply. `{L}` is the helpline slot — see `crisisMain`.
 * Note the explorer copy has no `{L}`: a 4-7 year old is pointed at a grown-up
 * in the room, not at a phone number.
 */
export const CRISIS_MAIN: { readonly en: BandedText; readonly ta: string } = Object.freeze({
  en: {
    explorer:
      "Thank you for telling me. That is very important. 💛 I'm a computer program, so please tell a grown-up you trust — a parent, a carer, or your teacher — right now. You did the right thing by saying it.",
    builder:
      "Thank you for trusting me — this is really important. 💛 I'm a program, and this needs a real person. Please talk to a trusted adult today. Free helplines: {L}. You're not in trouble. You matter.",
    thinker:
      "I'm glad you said it out loud. Straight: I'm a program, and you deserve real human support. Reach out to an adult you trust today. Free, confidential: {L}. Telling someone is strength. You matter.",
  },
  ta: 'சொன்னதுக்கு நன்றி. இது ரொம்ப முக்கியம். 💛 நான் ப்ரோகிராம்தான் — இதுக்கு உண்மையான மனுஷங்க வேணும். இப்பவே நம்பற பெரியவங்ககிட்ட சொல்லு. இலவச உதவி: {L}. நீ தப்பே பண்ணல. 💛',
});

/**
 * Every subsequent turn while the crisis lock is on. Band-agnostic by design:
 * calm-mode companionship is the same for a 5 year old and a 16 year old.
 */
export const CRISIS_SOFT: { readonly en: string; readonly ta: string } = Object.freeze({
  en: "I'm right here with you, and your grown-up has been told so real help is coming. 💛 While we wait, want to just sit together — maybe a calm story or some slow breathing like a sleepy sparrow?",
  ta: 'நான் உன் கூடவே இருக்கேன், உன் பெரியவங்களுக்கு தெரிவிச்சாச்சு. 💛 அமைதியான கதை கேக்கலாமா, அல்லது மெதுவா மூச்சு விடலாமா?',
});

/**
 * D4/UN — "Chat unlocked + gentle welcome-back message". Prototype line 1192.
 *
 * The one thing a child hears on the way OUT of a crisis lock, and the reason it
 * is scripted is the reason the whole crisis path is: this is the least
 * appropriate moment in the product to improvise. A model asked to be warm here
 * would reach for "are you feeling better?" — a question that reopens the
 * subject — or "I missed you", which is both an attachment simulation and a
 * lie. This says what actually happened: a person checked in.
 *
 * Band-agnostic by design, exactly like `CRISIS_SOFT`: coming back is the same
 * for a 5 year old and a 16 year old.
 *
 * It is a REPLY, not a system notice, so it never enters `history` — the caller
 * renders it and stops. A scripted reply is not context for a model to build on.
 */
export const CRISIS_WELCOME_BACK: { readonly en: string; readonly ta: string } = Object.freeze({
  en: '\uD83D\uDC9B Your grown-up checked in. Welcome back \u2014 gently does it. \uD83D\uDC26',
  ta: '\uD83D\uDC9B \u0B89\u0BA9\u0BCD \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BB5\u0B99\u0BCD\u0B95 \u0BAA\u0BC7\u0B9A\u0BBF\u0B9F\u0BCD\u0B9F\u0BBE\u0B99\u0BCD\u0B95. \u0BAE\u0BB1\u0BC1\u0BAA\u0B9F\u0BBF\u0BAF\u0BC1\u0BAE\u0BCD \u0BB5\u0BB0\u0BB5\u0BC7\u0BB1\u0BCD\u0BAA\u0BC1 \u2014 \u0BAE\u0BC6\u0BA4\u0BC1\u0BB5\u0BBE \u0BAA\u0BCB\u0BB2\u0BBE\u0BAE\u0BCD. \uD83D\uDC26',
});

/** Prototype line 803. Band is a parameter here; the prototype read global `S.band`. */
export function spineFor(kind: SpineKind, band: Band): string {
  const en = SPINE[kind].en;
  return typeof en === 'string' ? en : en[band];
}

/**
 * Prototype line 804. String-pattern `replace` substitutes the FIRST `{L}` only,
 * which is exactly right: each band's copy carries at most one slot.
 *
 * @param lines resolved helpline text from the live registry, when there is
 *   one. Omitted or null falls back to the compiled-in `REGISTRY`, which is why
 *   the kernel stays pure and synchronous: a crisis reply must be producible
 *   with no database, no network and no await. The registry is an overlay that
 *   lets a wrong number be corrected in minutes; it is never a dependency.
 */
export function crisisMain(band: Band, country: Country, lines?: string | null): string {
  const text = lines !== undefined && lines !== null && lines !== ''
    ? lines : helplineText(country);
  return CRISIS_MAIN.en[band].replace('{L}', text);
}
