/**
 * UI copy that has no server meaning: mode labels, starter prompts, board names.
 *
 * The mode *hints* — the prompt fragments that actually change how a model is
 * asked — live server-side and are not in this file and must not be. What the
 * client knows is which button says "Quiz me"; what that means is the API's
 * business (§1: the client is too thin to matter).
 */

import type { Band, Country, Mode } from '@chittu/contracts';

export interface ModeInfo {
  readonly id: Mode;
  readonly label: string;
  readonly starters: readonly string[];
}

/** Order is the order they appear in the mode bar. */
export const MODES: readonly ModeInfo[] = [
  { id: 'chat', label: '💬 Chat', starters: ['Tell a story!', 'Riddle me!', 'Fun fact!', 'Why is the sky blue?'] },
  { id: 'learn', label: '🎓 Explain', starters: ['How do planes fly?', 'Why do we dream?', 'What is gravity?', 'How does the internet work?'] },
  { id: 'homework', label: '📚 Homework help', starters: ['Help me with fractions', 'What is a noun?', 'Photosynthesis?', 'Water cycle?'] },
  { id: 'story', label: '📖 Story', starters: ['A dragon who is afraid of fire', 'A robot learning to dance', 'A cat astronaut', 'Make one up!'] },
  { id: 'create', label: '✍️ Poem & song', starters: ['A poem about my dog', 'A silly song about socks', 'A rhyme about the moon', 'A joke!'] },
  { id: 'quiz', label: '🎯 Quiz me', starters: ['Quiz me on animals', 'Space quiz!', 'Countries quiz', 'Surprise me'] },
  { id: 'code', label: '💻 Code', starters: ['What is a loop?', 'Make a counting program', 'Draw a square with code', 'What is a variable?'] },
  { id: 'math', label: '🔢 Maths', starters: ['What is 7 × 8?', 'Explain fractions', 'What is a prime number?', '48 ÷ 6?'] },
  { id: 'lang', label: '🌐 Languages', starters: ['Hello in Spanish?', 'Count to 5 in French', 'Colours in Hindi', 'Thank you in Japanese'] },
  { id: 'draw', label: '🎨 Draw with me', starters: ['Draw a cat', 'Draw a rocket', 'Draw a house', 'Draw a dinosaur'] },
  { id: 'read', label: '📕 Read to me', starters: [] },
];

export const modeInfo = (m: Mode): ModeInfo =>
  MODES.find((x) => x.id === m) ?? MODES[0]!;

export interface BandInfo {
  readonly id: Band;
  readonly label: string;
  readonly ages: string;
}

export const BAND_INFO: readonly BandInfo[] = [
  { id: 'explorer', label: 'Explorer', ages: '4–7' },
  { id: 'builder', label: 'Builder', ages: '8–12' },
  { id: 'thinker', label: 'Thinker', ages: '13–17' },
];

export const COUNTRY_NAMES: Readonly<Record<Country, string>> = {
  IN: 'India', US: 'United States', GB: 'United Kingdom',
  AU: 'Australia', SG: 'Singapore', AE: 'United Arab Emirates',
};

/** Grouped exactly as the prototype had them, so a parent sees a familiar list. */
export const BOARD_GROUPS: readonly {
  readonly group: string;
  readonly boards: readonly { readonly value: string; readonly label: string }[];
}[] = [
  { group: 'India — National', boards: [
    { value: 'CBSE', label: 'CBSE (NCERT)' },
    { value: 'ICSE', label: 'ICSE / ISC (CISCE)' },
    { value: 'NIOS', label: 'NIOS (Open Schooling)' },
  ] },
  { group: 'India — State Boards', boards: [
    { value: 'TN', label: 'Tamil Nadu (Samacheer Kalvi)' },
    { value: 'MH', label: 'Maharashtra (SSC/HSC)' },
    { value: 'KA', label: 'Karnataka (KSEEB)' },
    { value: 'KL', label: 'Kerala (SCERT)' },
    { value: 'AP-TS', label: 'Andhra / Telangana (SSC)' },
    { value: 'WB', label: 'West Bengal (WBBSE)' },
    { value: 'GJ', label: 'Gujarat (GSEB)' },
    { value: 'UP', label: 'Uttar Pradesh (UPMSP)' },
  ] },
  { group: 'International Programmes', boards: [
    { value: 'IB', label: 'IB (PYP / MYP / DP)' },
    { value: 'Cambridge', label: 'Cambridge International (Primary/IGCSE)' },
    { value: 'Montessori', label: 'Montessori approach' },
  ] },
  { group: 'National Curricula — World', boards: [
    { value: 'Common Core', label: 'United States (Common Core)' },
    { value: 'UK', label: 'England (National Curriculum, Key Stages)' },
    { value: 'AU', label: 'Australia (ACARA)' },
    { value: 'CA-ON', label: 'Canada (Ontario)' },
    { value: 'SG', label: 'Singapore (MOE)' },
    { value: 'FI', label: 'Finland (National Core)' },
    { value: 'ZA', label: 'South Africa (CAPS)' },
    { value: 'AE-UK', label: 'UAE / Gulf (UK-pattern intl. schools)' },
  ] },
];

/**
 * Parent-facing names for the verification rails. Where a method is not
 * available the server says why in `blockedOn`, and the UI shows that verbatim
 * rather than hiding the option — a parent who cannot proceed deserves the
 * reason, not a shorter list.
 */
export const METHOD_LABELS: Readonly<Record<string, string>> = {
  dev_stub: 'Development stub (no verification)',
  card_micro_charge: 'Card micro-charge (refunded)',
  email_plus: 'Email plus a second step',
  signed_form_review: 'Signed form, reviewed by a person',
  gov_id_review: 'Government ID, reviewed by a person',
  consent_manager_token: 'Registered Consent Manager token',
  age_assurance_uk: 'Proportional age assurance',
  digilocker: 'DigiLocker',
};
