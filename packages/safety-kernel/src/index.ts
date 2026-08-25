/**
 * @chittu/safety-kernel — the package a certifier reads.
 *
 * Pure functions over strings. No I/O, no clock, no randomness, no dependencies
 * beyond @chittu/contracts. That constraint is what makes this reviewable by
 * someone who is not an engineer, and it is enforced in CI by a dependency
 * boundary check — not by good intentions.
 */
export { LEX, PROFANITY, L1_ORDER, L1_PATTERNS, scan } from './lexicon.js';
export type { LexKind } from './lexicon.js';

export {
  SPINE, CRISIS_MAIN, CRISIS_SOFT, CRISIS_WELCOME_BACK, PROFANITY_REPLY, spineFor, crisisMain,
} from './spines.js';
export type { SpineKind, SpineEntry, BandedText } from './spines.js';

export { WELCOME, welcomeMemory, welcomeSpine } from './welcome.js';

export { REGISTRY, helplineText } from './helplines.js';

export { passesOutputFilter, stripControlTokens } from './output-filter.js';

export {
  CLASSIFIER_SYSTEM, CLASSIFIER_PROMPT_VERSION, parseClassifier, ClassifierParseError,
} from './classifier.js';
export type { RawClassification } from './classifier.js';

export { parseBlocks, stripBlocks, flatten, ITEM_SEPARATOR } from './blocks.js';

export {
  abstractShape, MAX_SHAPE_CHARS, PLACEHOLDERS, SHAPE_RE,
} from './abstractor.js';
export type { Placeholder } from './abstractor.js';
export { AUTHORED, BASE, COMMON, EMOTIONS, EMOTION_PHRASES, NAMES, PETS, PLACES }
  from './vocabulary.js';
