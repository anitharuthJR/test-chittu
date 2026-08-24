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
 * What the L1 lexicon can detect. Note `identity` and `secret` are separate
 * kinds here but both resolve to the SPINE escalation token — the distinction
 * matters for which scripted reply is used and which flag is raised.
 */
export type GuardKind = 'crisis' | 'pii' | 'unsafe' | 'secret' | 'identity';

export const GUARD_KINDS = ['crisis', 'pii', 'unsafe', 'secret', 'identity'] as const;

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
// Turn I/O — the one endpoint that runs the whole pipeline
// ---------------------------------------------------------------------------

export interface TurnRequest {
  readonly sessionId: string;
  readonly text: string;
  readonly mode: Mode;
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
}

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

export type RouterCategory =
  | 'classifier' | 'sandbox' | 'homework' | 'curriculum' | 'vision' | 'embedding';

export interface RouteDecision {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly maxTokens?: number;
}

export interface ModelReply {
  readonly text: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

/** One interface per vendor. `controlTokens` is that vendor's own litter. */
export interface ProviderAdapter {
  readonly id: string;
  readonly controlTokens: RegExp;
  complete(req: ModelRequest, route: RouteDecision): Promise<ModelReply>;
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
