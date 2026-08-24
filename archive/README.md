# archive/ — superseded originals

Kept for lineage and provenance only. **Do not edit, do not import from, do not run.**
The live prototype is `prototype/chittu-v3.html`.

| File | What it was | Superseded because |
|---|---|---|
| `chittu-prototype-v1.html` | The first doctrine-compliant build. Pipeline L1 crisis → L2 PII → L3 unsafe → L4 scripted spine → L5 sandbox → L6 output filter. English-only regex guards, arithmetic parent gate, session-only memory, 15/20/25-minute timers. | v2 replaced regex-only classification with a model classifier and added Tamil safety parity. |
| `chittu-v2.html` | The "gap-fix build" — closed GAP-02 (model classifier), GAP-03 (Tamil + Tanglish lexicons), GAP-04 (voice I/O), GAP-05 (per-jurisdiction consent), GAP-06 (helpline registry). Added seal-chain re-verification. | v3 added the PIN gate, Memory Book, 10 modes, reading coach, deterministic maths, vision, curriculum boards, and the crisis parent-unlock. |

Two things in these files are **deliberately not** in v3 and should not be re-introduced:

- **Session timers** (`mins: 15/20/25`, `tickTimer`, `endWell`) — removed by product decision. v3 has no time limits; only the ≥21:00 calm-tone notice remains.
- **The arithmetic parent gate** (`7 × 8` challenge) — replaced by the hashed **PIN gate** with attempt counting, lockout and audit. A maths question is kid-guessable.
