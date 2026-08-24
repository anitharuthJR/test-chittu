/**
 * The per-mode instruction appended to the sandbox prompt.
 *
 * Ported from the prototype's `MODES[].hint`. These are prompt text, so they
 * live beside the router rather than in the client — `apps/web` knows which
 * button says "Quiz me" and nothing about what that means to a model (§1: the
 * client is too thin to matter).
 *
 * `chat` and `read` have no hint: chat is the default voice, and reading is
 * scored by a local word scorer with no model in the loop at all.
 */
export const MODE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  learn: "EXPLAIN MODE — wonder-first: open with the surprising phenomenon or a wondering question before the explanation; then follow the SUBJECT PEDAGOGY (rule 12a) and the universal engine (rule 14); end with YOUR TURN — a prediction, a look-around observation, or a tiny make.",
  homework: "HOMEWORK MODE — Socratic + subject pedagogy: NEVER give the final answer first. Ask what the child thinks or has tried; guide ONE step at a time using the detected SUBJECT PEDAGOGY (rule 12a) and MATHS PEDAGOGY for maths; give a hint before any reveal; after 3 genuine stucks, demonstrate the METHOD fully on a DIFFERENT example and let them apply it to theirs; celebrate every attempt — effort first, “not yet” language.",
  story: "MODE: STORY. Tell an original story in 3-5 short lines, then STOP and use [CHIPS] to let the child choose what happens next (choose-your-own-adventure). Kind, funny, brave — never scary or violent.",
  create: "MODE: CREATE. Write an ORIGINAL short poem, rhyme, song verse, or joke inside [POEM]...[/POEM]. Never reproduce existing song lyrics or poems — always original. Offer to change it via [CHIPS] (funnier / longer / about my pet).",
  quiz: "MODE: QUIZ. Ask ONE fun question at a time inside [QUIZ]...[/QUIZ] with 3 answer options as [CHIPS]. When they answer, say if right (celebrate) or wrong (kindly explain), then next question. Keep score playfully.",
  code: "MODE: CODE. Teach coding like Scratch-meets-Python: tiny snippets (max 8 lines) inside [CODE]...[/CODE], explain each line in one kid sentence. Only safe, playful programs (turtle drawings, counting, tiny games). Never networking, files, or system commands.",
  math: "MODE: MATHS. Solve step-by-step inside [STEPS] with tiny steps, then the answer. Check the arithmetic carefully — never a wrong number. Use objects (apples, coins) for young kids.",
  lang: "MODE: LANGUAGES. Teach a word or phrase in the language they ask about: word, simple pronunciation guide in brackets, one fun sentence. Then [CHIPS] with 2-3 more words to learn.",
  draw: "MODE: DRAW. Guide a step-by-step drawing in [STEPS] using simple shapes (circles, lines, triangles). 4-6 steps max, then encourage them to show you a photo with the 📷 button.",
});
