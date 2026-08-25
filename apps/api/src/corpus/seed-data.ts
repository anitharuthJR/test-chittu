/**
 * The seed corpus.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE — read this before adding a row
 *
 * All fifteen entries are copied VERBATIM from `prototype/chittu-v3.html:474`
 * (`const CORPUS`), the grounded-pedagogy table in prototype v3.3. Nothing here
 * is newly authored, nothing is scraped, and no board's textbook has been
 * copied: they are one-line explanations written by hand for the prototype,
 * which is why they can be seeded as `published` at all.
 *
 * That is the whole argument for signing them. These fifteen facts have been in
 * front of children since v3 and have been through the prototype's Playwright
 * suite; they carry a real review history, and `import` records the name of the
 * person asserting it rather than inventing one. It is NOT a general licence to
 * seed published rows — see the `sign` path in corpus-repo.ts.
 *
 * ANYTHING ADDED HERE LATER IS DIFFERENT and must land as `draft`. The
 * architecture's W6 exists because a second independent reader over authored
 * content caught roughly 130 factual errors in llm-kit that a single author
 * pass had missed. A new row has had one pass.
 *
 * ---------------------------------------------------------------------------
 * WHY BOARD-AGNOSTIC
 *
 * Every row is `BOARD_ANY`. The prototype's table had no board dimension, and
 * inventing one per row would be asserting a curriculum alignment nobody
 * checked — "the CBSE class-5 water cycle" is a claim about NCERT's sequencing,
 * not a restatement of the same sentence. Photosynthesis is photosynthesis in
 * every board in the catalogue; where a board genuinely differs, that is a new
 * entry authored against that board's sequence, drafted and signed like any
 * other.
 *
 * The board COLUMN is still load-bearing and still exercised — `retrieve`
 * scopes by `board = $2 OR board = BOARD_ANY`, and the repo test seeds a
 * board-specific row to prove the scope actually selects rather than matching
 * everything by accident.
 *
 * ---------------------------------------------------------------------------
 * `subject` IS METADATA HERE, NOT A FILTER
 *
 * `retrieve` can narrow by subject and the pipeline deliberately does not ask
 * it to — see the wiring in server.ts for why. So these values are for humans
 * and ops queries. Note `maths`, which is not in `Subject`: arithmetic never
 * reaches a model, so pedagogy has no maths subject, but "what is a fraction"
 * is still a maths question and mislabelling it `science` to fit a union that
 * does not apply would be worse than using the honest word.
 */

import { BOARD_ANY } from '@chittu/db';

export interface SeedEntry {
  readonly topic: string;
  readonly subject: string;
  readonly body: string;
}

/** The embedding model these were embedded with. Pinned — see embed.ts. */
export const SEED_EMBED_MODEL = 'mxbai-embed-large';

export const SEED_BOARD = BOARD_ANY;

export const SEED_ENTRIES: readonly SeedEntry[] = Object.freeze([
  {
    topic: 'why-the-sky-is-blue',
    subject: 'science',
    body: 'The sky looks blue because sunlight is made of many colours, and tiny bits of air scatter blue light around the most.',
  },
  {
    topic: 'photosynthesis',
    subject: 'science',
    body: 'Photosynthesis: plants use sunlight, water and carbon dioxide to make their own food (sugar) and release oxygen.',
  },
  {
    topic: 'water-cycle',
    subject: 'science',
    body: 'Water cycle: the sun warms water, it rises as vapour (evaporation), cools into clouds (condensation), and falls as rain (precipitation).',
  },
  {
    topic: 'gravity',
    subject: 'science',
    body: 'Gravity is a pulling force: everything with mass pulls on everything else. Earth is huge, so it pulls us down.',
  },
  {
    topic: 'solar-system',
    subject: 'science',
    body: 'Our solar system has 8 planets orbiting the Sun: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune.',
  },
  {
    topic: 'the-heart',
    subject: 'science',
    body: 'The heart is a muscle pump: it pushes blood around the body, delivering oxygen and food like a delivery truck.',
  },
  {
    topic: 'fractions',
    subject: 'maths',
    body: 'A fraction shows parts of a whole: in 3/4, the bottom (denominator) is how many equal parts, the top (numerator) is how many we have.',
  },
  {
    topic: 'nouns',
    subject: 'english',
    body: 'A noun is a naming word - a person, place, animal or thing: teacher, park, elephant, ball.',
  },
  {
    topic: 'verbs',
    subject: 'english',
    body: 'A verb is a doing or being word - run, jump, think, is, are.',
  },
  {
    topic: 'prime-numbers',
    subject: 'maths',
    body: 'A prime number has exactly two factors: 1 and itself. Examples: 2, 3, 5, 7, 11. (1 is not prime.)',
  },
  {
    topic: 'how-the-internet-works',
    subject: 'coding',
    body: 'The internet is like a giant post office: computers break messages into packets, send them through cables and routers, and reassemble them.',
  },
  {
    topic: 'how-planes-fly',
    subject: 'science',
    body: 'Planes fly because curved wings make air move faster over the top than the bottom, creating lift.',
  },
  {
    topic: 'dreams',
    subject: 'science',
    body: 'Dreams happen mostly in REM sleep, when the brain sorts memories and feelings - scientists still study exactly why.',
  },
  {
    topic: 'rainbows',
    subject: 'science',
    body: 'Rainbows appear when raindrops bend and split sunlight into its colours.',
  },
  {
    topic: 'volcanoes',
    subject: 'science',
    body: "A volcano is an opening in Earth's crust where melted rock (magma) escapes; flowing out, it's called lava.",
  },
]);
