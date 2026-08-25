/**
 * @chittu/contracts — the vocabulary every other package codes against.
 *
 * These types are deliberately narrow. Where the prototype used a bare string,
 * this uses a union, so that a typo becomes a compile error rather than a guard
 * that silently never fires. The escalation tokens in particular are compared
 * EXACTLY at runtime (CLAUDE.md), so they are a closed set here.
 *
 * Nothing in this package has behaviour. Types and frozen constants only.
 */

// ---------------------------------------------------------------------------
// Child-facing vocabulary
// ---------------------------------------------------------------------------

/** Age bands. Explorer 4-7 / Builder 8-12 / Thinker 13-17. */
export type Band = 'explorer' | 'builder' | 'thinker';

export const BANDS = ['explorer', 'builder', 'thinker'] as const;

/** Markets with a verified helpline set. A country absent here cannot be enabled. */
export type Country = 'IN' | 'US' | 'GB' | 'AU' | 'SG' | 'AE';

export const COUNTRIES = ['IN', 'US', 'GB', 'AU', 'SG', 'AE'] as const;

/** The 11 surfaces. `read` is the reading coach, not a chat mode. */
export type Mode =
  | 'chat' | 'learn' | 'homework' | 'story' | 'create'
  | 'quiz' | 'code' | 'math' | 'lang' | 'draw' | 'read';

// ---------------------------------------------------------------------------
// Guards and escalation
// ---------------------------------------------------------------------------

/**
 * What the L1 fast path can detect. Note `identity` and `secret` are separate
 * kinds here but both resolve to the SPINE escalation token — the distinction
 * matters for which scripted reply is used and which flag is raised.
 *
 * `profanity` is the Kindness Guard (prototype line 1058). It sits OUTSIDE the
 * prototype's `LEX` object, which is how it was missed on the first port: five
 * patterns in `LEX`, six guards in the dispatch. It is listed here so the type
 * system carries all six, because forgetting it means a child's profane turn
 * reaches a model provider where the prototype answered it with a script and
 * spent no tokens at all.
 */
export type GuardKind =
  | 'crisis' | 'pii' | 'unsafe' | 'secret' | 'identity' | 'profanity';

/** Declaration order. The DISPATCH order lives in safety-kernel's L1_ORDER. */
export const GUARD_KINDS = Object.freeze(
  ['crisis', 'pii', 'unsafe', 'secret', 'identity', 'profanity'] as const,
);

/**
 * The exact strings a model may return to hand control back to the scripts.
 * CLAUDE.md: "The sandbox escalation tokens (exact outputs CRISIS / SPINE /
 * UNSAFE / PII) must keep working." Compared with ===, never with `includes`.
 */
export type EscalationToken = 'CRISIS' | 'SPINE' | 'UNSAFE' | 'PII';

export const ESCALATION_TOKENS = ['CRISIS', 'SPINE', 'UNSAFE', 'PII'] as const;

/** Classifier labels. SAFE is the only one that proceeds to the sandbox. */
export type ClassifierLabel = 'SAFE' | EscalationToken;

/**
 * The fixed pipeline order (CLAUDE.md — never reorder or skip a layer).
 * Every audit event records which layer produced it, so the trace a certifier
 * reads is the trace the code actually walked.
 */
export type PipelineLayer =
  | 'SEAL' | 'CRISIS_LOCK' | 'READ' | 'L1_LEXICON' | 'MATH_LOOP' | 'MATH_ENGINE'
  | 'CORPUS' | 'SUBJECT' | 'L2_CLASSIFIER' | 'L5_SANDBOX' | 'L6_FILTER'
  | 'RENDER' | 'LEDGER';

/** Order is data, not comment. Tests assert the walk never goes backwards. */
export const PIPELINE_ORDER: readonly PipelineLayer[] = Object.freeze([
  'SEAL', 'CRISIS_LOCK', 'READ', 'L1_LEXICON', 'MATH_LOOP', 'MATH_ENGINE',
  'CORPUS', 'SUBJECT', 'L2_CLASSIFIER', 'L5_SANDBOX', 'L6_FILTER',
  'RENDER', 'LEDGER',
]);

// ---------------------------------------------------------------------------
// Memory — the allowlist, in the type system
// ---------------------------------------------------------------------------

/**
 * Requirements §4.3. Six values, no more. Enforced here, in `memAdd`, AND as a
 * Postgres enum — three layers, because prompt-level enforcement alone has
 * never been sufficient.
 */
export type MemoryCategory =
  | 'INTEREST' | 'PET' | 'HOBBY' | 'FAVORITE' | 'ACHIEVEMENT' | 'LEARNING';

export const MEMORY_CATEGORIES = Object.freeze([
  'INTEREST', 'PET', 'HOBBY', 'FAVORITE', 'ACHIEVEMENT', 'LEARNING',
] as const);

export interface Memory {
  readonly id: string;
  readonly category: MemoryCategory;
  readonly fact: string;
  readonly since: string;
}

// ---------------------------------------------------------------------------
// Flags — category only, never the child's words
// ---------------------------------------------------------------------------

export type FlagKind = 'SAFETY' | 'ASSIST' | 'GATE';

/**
 * A flag names a category and points at vetted wording by key. There is
 * deliberately no field here that could hold a child's quoted text — the
 * database enforces the same thing with a foreign key and no free-text column.
 */
export interface Flag {
  readonly kind: FlagKind;
  readonly category: string;
  readonly noteKey: string;
  /** ASSIST only: a school topic such as "fractions". Never a feeling. */
  readonly assistTopic?: string;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export interface ClassifierResult {
  readonly label: ClassifierLabel;
  readonly memory: { readonly category: MemoryCategory; readonly fact: string } | null;
  readonly assist: string | null;
}

/**
 * When the classifier cannot be parsed the turn continues, honestly marked
 * FAST-PATH-ONLY (CLAUDE.md). This is that outcome, not an exception.
 */
export interface ClassifierFailure {
  readonly label: 'FAST-PATH-ONLY';
  readonly reason: string;
}

export type ClassifierOutcome = ClassifierResult | ClassifierFailure;

export const isClassifierFailure = (o: ClassifierOutcome): o is ClassifierFailure =>
  o.label === 'FAST-PATH-ONLY';

// ---------------------------------------------------------------------------
// Visual block grammar — rendered as UI, never as raw text
// ---------------------------------------------------------------------------

export type BlockTag = 'BIG' | 'FACT' | 'STEPS' | 'POEM' | 'QUIZ' | 'CODE' | 'CHIPS';

export const BLOCK_TAGS = Object.freeze(
  ['BIG', 'FACT', 'STEPS', 'POEM', 'QUIZ', 'CODE', 'CHIPS'] as const,
);

/**
 * Parsed block grammar. The client renders from this AST and never from a
 * string, so a model emitting markup cannot inject a DOM node.
 *
 * NOTE the delimiters, which collided once and truncated lessons (CLAUDE.md):
 *   [STEPS] items are separated by '|'
 *   maths pictorial emoji groups are separated by '·'
 * They are not interchangeable.
 */
export type Block =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'big'; readonly emoji: string }
  | { readonly kind: 'fact'; readonly text: string }
  | { readonly kind: 'steps'; readonly items: readonly string[] }
  | { readonly kind: 'poem'; readonly text: string }
  | { readonly kind: 'quiz'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'chips'; readonly chips: readonly string[] };

// ---------------------------------------------------------------------------
// Images — what a child SHOWS Chittu
// ---------------------------------------------------------------------------

/**
 * A picture the child is showing Chittu on THIS turn, and only this turn.
 *
 * **IT IS NEVER STORED.** Not in `message`, not in `session.runtime_enc`, not
 * on disk, not in the seal chain. It exists for the length of one request: the
 * route hands it to the pipeline, the pipeline hands it to the sandbox port,
 * the adapter puts it on the wire, and the reference is dropped when the turn
 * returns. That is why this type is NOT on `SessionState` and never can be —
 * everything on that type is written to `runtime_enc` at the end of the turn.
 *
 * The seal chain records that a picture was shown (`INPUT·IMAGE`, with the
 * prototype's own words "image-shared(not stored)") and never what was in it,
 * which is the same shape as a flag: the category, never the content.
 *
 * ONE IMAGE PER TURN, and only the latest. The prototype bounds context the
 * same way (chittu-v3.html:1129 strips every image block but the newest);
 * here it is bounded by construction, because nothing carries an image
 * forward.
 */
export interface ImageInput {
  readonly mimeType: ImageMimeType;
  /** Base64, WITHOUT the `data:` URI prefix. */
  readonly dataBase64: string;
}

/**
 * The four formats both providers accept. A closed set for the same reason
 * every other union here is closed: an unrecognised value must be a refusal,
 * never a pass-through to a vendor's own parser.
 */
export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const IMAGE_MIME_TYPES = Object.freeze(
  ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const,
);

/** 4 MiB decoded — the prototype's cap (chittu-v3.html:1007), kept for parity. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The same cap expressed in base64 characters, which is what a JSON schema can
 * actually check. Checking the decoded size would mean decoding first, i.e.
 * allocating whatever was sent before deciding whether it was too big.
 */
export const IMAGE_MAX_BASE64_CHARS = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;

// ---------------------------------------------------------------------------
// Turn I/O — the one endpoint that runs the whole pipeline
// ---------------------------------------------------------------------------

export interface TurnRequest {
  readonly sessionId: string;
  readonly text: string;
  readonly mode: Mode;
  /**
   * A picture the child is showing, for this turn only. Optional, and its
   * presence changes ONE thing: which cell the sandbox call routes to. It does
   * not change the layer order, and L1 and L2 still run on `text` first.
   */
  readonly image?: ImageInput;
}

/**
 * What the runtime OBSERVED go wrong on a turn, for training-signal capture.
 *
 * This is not part of `TurnResponse` and never reaches a child's browser. It
 * travels alongside it, from the pipeline to the API, and its only consumer is
 * the abstractor path in `apps/api`.
 *
 * THE FIELDS ARE OBSERVATIONS, NOT JUDGEMENTS. `layer` and `observedToken` are
 * facts about which layer acted. `failureClass` is set ONLY for the two things
 * the runtime can honestly name on its own — a classifier that could not be
 * parsed, and an output filter that fired. Everything else in the
 * `failure_class` enum (OVER_REFUSAL, WRONG_TOKEN, HALLUCINATION…) requires
 * someone to decide what SHOULD have happened, and a runtime that guessed at
 * those would fill the triage queue with confident fiction.
 */
export interface TurnSignal {
  readonly layer: PipelineLayer;
  readonly observedToken: 'CRISIS' | 'SPINE' | 'UNSAFE' | 'PII' | 'NONE';
  readonly failureClass: 'CLASSIFIER_PARSE' | 'L6_CATCH' | null;
}

/**
 * One passage word, marked heard-or-not by the local scorer.
 *
 * `word` is always the PASSAGE's word — static bank content — never the
 * child's transcript. The client renders these spans green/red and decides
 * nothing: hit and miss were decided server-side, deterministically.
 */
export interface ReadingWord {
  readonly word: string;
  readonly hit: boolean;
}

/** The reading coach's scoring payload, present only on a scored read turn. */
export interface ReadingResult {
  readonly passageId: string;
  readonly words: readonly ReadingWord[];
  readonly hits: number;
  readonly total: number;
  /** The scripted score line ("🌟 7 of 8 words — great reading!"). */
  readonly line: string;
}

export interface TurnResponse {
  readonly blocks: readonly Block[];
  /** Human-readable provenance, shown in the trace strip. */
  readonly trace: string;
  /** Which layers actually ran, in the order they ran. */
  readonly layers: readonly PipelineLayer[];
  readonly crisisLock: boolean;
  readonly flags: readonly Flag[];
  readonly memorySaved?: Memory;
  /**
   * Present ONLY when the reading coach scored this turn. Absent means the
   * turn ended somewhere earlier — a guard fired on the transcript, or the
   * session is crisis-locked — and the client must render the blocks exactly
   * as it would a chat turn's.
   */
  readonly reading?: ReadingResult;
}

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

export type RouterCategory =
  | 'classifier' | 'sandbox' | 'homework' | 'curriculum' | 'vision' | 'embedding';

/**
 * Who a turn is, as far as routing is concerned.
 *
 * Deliberately only these two. The router needs to pick a vendor; anything else
 * handed to it is something it could then route on, and a routing layer that
 * can see the child is a profiling layer.
 */
export interface RouteContext {
  readonly band: Band;
  readonly country: Country;
}

export interface RouteDecision {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly maxTokens?: number;
  /**
   * Attached to the LAST user message by the adapter, because that is where a
   * "look at this" belongs and it keeps `messages` a list of strings.
   *
   * It is deliberately NOT a content-part union on `messages`: the two vendors
   * disagree about the wire (Anthropic wants `source.data` base64 blocks,
   * OpenAI-compatible endpoints want an `image_url` data URI), and a union here
   * would force every adapter to re-derive the same thing from a shape one of
   * them cannot send. Above the port an image is one field; below it, it is
   * whatever that vendor's protocol says.
   */
  readonly image?: ImageInput;
}

/**
 * What one model call consumed. Reported by the router so the caller can meter.
 *
 * DELIBERATELY CARRIES NO IDENTITY — no session, no child, no text. The router
 * does not know those and must not learn them: the same reasoning as
 * RouteContext, which carries band and country and nothing else. The caller
 * already holds the session and binds it; `metering.session_pseudonym` is an
 * HMAC even then, so the ops console can aggregate per session without being
 * able to reach a child.
 */
export interface ModelUsage {
  readonly category: RouterCategory;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
}

export type UsageSink = (usage: ModelUsage) => void;

export interface ModelReply {
  readonly text: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

/** One interface per vendor. `controlTokens` is that vendor's own litter. */
export interface EmbedRequest {
  readonly input: string;
}

export interface EmbedReply {
  readonly vector: number[];
  /** Absent, not zero, when the endpoint does not report it — see `ModelReply`. */
  readonly tokensIn?: number;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly controlTokens: RegExp;
  complete(req: ModelRequest, route: RouteDecision): Promise<ModelReply>;
  /**
   * OPTIONAL, because an embeddings API is a capability a provider either has
   * or does not — Anthropic has none, and no cell assignment can give it one.
   *
   * This is why it is a separate method rather than a `complete()` with a
   * different prompt: an embedding is not a chat completion. There is no
   * system prompt, no message list, no `maxTokens`, and the reply is a vector
   * rather than text. Folding it into `complete` would mean a `ModelReply`
   * whose `text` field is a serialised array, which nothing downstream could
   * be trusted to notice.
   *
   * A route to a provider without this must REFUSE. `RouteDecision` naming a
   * model is not evidence the provider can produce a vector.
   */
  embed?(req: EmbedRequest, route: RouteDecision): Promise<EmbedReply>;
}

// ---------------------------------------------------------------------------
// Helplines
// ---------------------------------------------------------------------------

export interface Helpline {
  readonly name: string;
  readonly contact: string;
}

export interface CountryRegistry {
  readonly name: string;
  readonly lines: readonly Helpline[];
  readonly law: string;
  readonly consent: string;
}
