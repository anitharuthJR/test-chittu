# comparisons/ — the cards behind "How Chittu compares"

Design: `docs/superpowers/specs/2026-09-29-chittu-comparison-page-design.md` (§2 is the
contract; read it before adding or changing anything here).

```
cards/     <id>-<date>.json   the card tulifo.com consumes (schema §2.3 of the spec)
           <id>-<date>.md     the human card: method, every generation verbatim (redacted by
                              rule where §2.5 says so), the human read
fixtures/  example-card.json       a `story` card with INVENTED numbers, `"fixture": true`
           example-landscape.json  a `landscape` card with INVENTED cells, `"fixture": true`
```

Rules that are not negotiable:

- **The page renders cards; it holds no numbers of its own.** Every figure on tulifo.com's
  `/chittu/compare` comes from a file in `cards/`, with its date, versions, denominators and
  caveats. A measurement that has not run has no card and is not shown.
- **Fixtures are never cards.** Both fixtures carry `"fixture": true`; the website's loader
  refuses to render one, and its importer refuses to copy one into `src/comparisons/cards/`.
  They exist so both repos test the same schema: the runners here are tested against them,
  and the website's import script copies them into its own test fixtures.
- **Raw generations never land in the tree.** They live under
  `~/.cache/chittu-compare/<id>-<date>/`; only the card does.
- **Cards are not comparable across dates, models or graders** unless the card says so. A
  new run is a new dated file; the site shows the latest date per card id.
