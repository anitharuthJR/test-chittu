/**
 * @chittu/safety-kernel — the package a certifier reads.
 *
 * Pure functions over strings. No I/O, no clock, no randomness, no dependencies
 * beyond @chittu/contracts. That constraint is what makes this reviewable by
 * someone who is not an engineer, and it is enforced in CI by a dependency
 * boundary check — not by good intentions.
 */
export { LEX, PROFANITY, L1_ORDER, L1_PATTERNS, scan } from './lexicon';
export type { LexKind } from './lexicon';

export {
  SPINE, CRISIS_MAIN, CRISIS_SOFT, PROFANITY_REPLY, spineFor, crisisMain,
} from './spines';
export type { SpineKind, SpineEntry, BandedText } from './spines';

export { REGISTRY, helplineText } from './helplines';

export { passesOutputFilter, stripControlTokens } from './output-filter';

export {
  CLASSIFIER_SYSTEM, CLASSIFIER_PROMPT_VERSION, parseClassifier, ClassifierParseError,
} from './classifier';
export type { RawClassification } from './classifier';

export { parseBlocks, stripBlocks, flatten, ITEM_SEPARATOR } from './blocks';
