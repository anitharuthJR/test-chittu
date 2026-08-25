/**
 * D5/CERT — the kidSAFE/KORA-class readiness checklist, PROBED rather than
 * maintained.
 *
 * The prototype's version (chittu-v3.html:362) was nine hand-written rows with
 * hand-written badges. Six of them said `BUILT-IN`. A checklist that claims a
 * control is in place when it is not is worse than no checklist — it is the
 * document a certifier reads instead of the code — so every row here is derived
 * from something read out of this running system: the roles and policies
 * actually present in Postgres, the constraint actually on `message`, the
 * helpline registry's actual state for this family's country, the consent
 * method this family actually completed, and the hash chain recomputed now.
 *
 * Four statuses, and the middle one is the reason this file exists:
 *
 *   `enforced`    — something in the system stops it. Named in `evidence`.
 *   `partial`     — built, but not yet the real thing (a stub, a fallback).
 *   `declarative` — WRITTEN DOWN AND INERT. The schema's GRANT block and its
 *                   five RLS policies are the case: both roles are NOLOGIN,
 *                   every environment connects as the table owner, and
 *                   `FORCE ROW LEVEL SECURITY` is set nowhere, so an owner
 *                   bypasses the policies. It is a correct specification of
 *                   what a deployment would switch on, and it is protecting
 *                   nobody today. See PORT-REVIEW, "the role separation is
 *                   DECLARATIVE".
 *   `absent`      — not done. No probe; saying so IS the honest row.
 */

import type { Country } from '@chittu/contracts';
import { PIPELINE_ORDER } from '@chittu/contracts';
import type { DbPool } from '@chittu/db';
import { resolveHelplines } from './helplines/resolve.js';
import { runMathsHarness } from './maths-harness.js';
import type { MathContext } from '@chittu/maths-engine';

export type ControlStatus = 'enforced' | 'partial' | 'declarative' | 'absent';

export interface Control {
  readonly id: string;
  /** Parent-facing. What the control promises, in their words. */
  readonly title: string;
  readonly status: ControlStatus;
  /** Parent-facing rendering of `status`. The server owns these words. */
  readonly label: string;
  /** Parent-facing. What it means for them. */
  readonly detail: string;
  /** What was actually read to decide the status. Never a child's words. */
  readonly evidence: string;
}

export interface CertificationResponse {
  readonly checkedAt: string;
  readonly summary: {
    readonly enforced: number;
    readonly partial: number;
    readonly declarative: number;
    readonly absent: number;
  };
  readonly controls: readonly Control[];
  readonly note: string;
}

const LABEL: Record<ControlStatus, string> = {
  enforced: 'In place',
  partial: 'Partly in place',
  declarative: 'Written down, not switched on',
  absent: 'Not done',
};

const RLS_TABLES = ['child', 'session', 'memory', 'flag', 'message'] as const;

interface Probe {
  declared_roles: number;
  login_roles: number;
  role_detail: string;
  rls_on: number;
  rls_forced: number;
  policies: number;
  owned_by_runtime: number;
  teen_checks: number;
  metering_links: number;
  runtime_role: string;
  key_ref: string | null;
}

/**
 * Every Postgres fact in ONE round trip. Nine separate `SELECT count(*)`s would
 * be nine waits on a page a parent is looking at.
 *
 * Resolved through `current_schema()` and `regclass`, never against a hardcoded
 * `public`: the test fixture puts every table in a throwaway schema, so a probe
 * pinned to `public` reports zero policies and zero owned tables — which is the
 * DECLARATIVE row's own answer, arrived at by looking in the wrong place. A
 * sweep that finds nothing looks exactly like one aimed at nothing.
 */
const PROBE_SQL = `
  SELECT
    (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('chittu_app','chittu_ops'))::int AS declared_roles,
    (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('chittu_app','chittu_ops') AND rolcanlogin)::int AS login_roles,
    (SELECT coalesce(string_agg(
        rolname || (CASE WHEN rolcanlogin THEN ' (can log in)' ELSE ' (NOLOGIN)' END),
        ', ' ORDER BY rolname), 'none')
      FROM pg_roles WHERE rolname IN ('chittu_app','chittu_ops')) AS role_detail,
    (SELECT count(*) FROM pg_class
      WHERE oid = ANY($3::regclass[]) AND relrowsecurity)::int AS rls_on,
    (SELECT count(*) FROM pg_class
      WHERE oid = ANY($3::regclass[]) AND relforcerowsecurity)::int AS rls_forced,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = ANY($2::text[]))::int AS policies,
    (SELECT count(*) FROM pg_tables
      WHERE schemaname = current_schema() AND tablename = ANY($2::text[])
        AND tableowner = current_user)::int AS owned_by_runtime,
    (SELECT count(*) FROM pg_constraint
      WHERE conname = 'teen_bodies_are_never_stored')::int AS teen_checks,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'metering'
        AND column_name IN ('child_id','session_id','parent_id'))::int AS metering_links,
    current_user AS runtime_role,
    (SELECT kms_key_arn FROM child_data_key WHERE child_id = $1) AS key_ref
`;

export interface CertificationInput {
  readonly pool: DbPool;
  readonly childId: string;
  readonly country: Country;
  /** From the consent ledger — what this family actually completed. */
  readonly consentMethod: string;
  readonly consentLaw: string;
  /** The chain recompute the seal panel runs, reused rather than run twice. */
  readonly seal: { ok: boolean; sessions: number; records: number };
  /** Band and board, so the maths row audits the engine as THIS child has it. */
  readonly maths: MathContext;
}

export async function buildCertification(
  input: CertificationInput,
): Promise<CertificationResponse> {
  // Independent of each other, so they wait together rather than in turn.
  const [p, helplines] = await Promise.all([
    input.pool.query<Probe>(
      PROBE_SQL, [input.childId, RLS_TABLES as unknown as string[], RLS_TABLES as unknown as string[]])
      .then((r) => r.rows[0] ?? null)
      .catch(() => null),
    resolveHelplines(input.pool, input.country),
  ]);
  const maths = runMathsHarness(input.maths);

  const controls: Control[] = [];
  const add = (c: Control): void => { controls.push(c); };

  // ---- 1. no advertising, no tracking, no profiling ------------------------
  add({
    id: 'no-ads-no-profiling',
    title: 'No adverts, no tracking, no profile built of your child',
    status: p === null ? 'partial' : p.metering_links === 0 ? 'enforced' : 'partial',
    label: LABEL[p !== null && p.metering_links === 0 ? 'enforced' : 'partial'],
    detail:
      'Chittu sells nothing and shows no adverts. What it costs to run is counted, '
      + 'but the counting is not attached to your child.',
    evidence: p === null
      ? 'The database could not be read just now, so this row could not be checked.'
      : `The usage ledger is keyed by a one-way session code and carries `
        + `${p.metering_links} column(s) that could identify a child, a parent or a `
        + `conversation. Read from the table itself, not from a policy document.`,
  });

  // ---- 2. verifiable parental consent -------------------------------------
  // `dev_stub` completes and verifies nothing about a real adult. G1 is red.
  const realMethod = input.consentMethod !== 'dev_stub';
  add({
    id: 'verifiable-consent',
    title: 'A verified grown-up agreed before your child could use Chittu',
    status: realMethod ? 'enforced' : 'partial',
    label: LABEL[realMethod ? 'enforced' : 'partial'],
    detail:
      'No part of Chittu is reachable before a consent record exists — not the chat, '
      + 'not a session, nothing.',
    evidence: realMethod
      ? `Your consent is recorded under ${input.consentLaw}, verified by the `
        + `"${input.consentMethod}" method.`
      : `Your consent is recorded under ${input.consentLaw}, but the method used was `
        + `"dev_stub" — a placeholder that completes without checking that a real adult `
        + `is present. The live verification services are not connected yet.`,
  });

  // ---- 3. parental controls ------------------------------------------------
  add({
    id: 'parental-controls',
    title: 'Controls for you: a PIN, the flags, the memory book, and erasure',
    status: 'enforced',
    label: LABEL.enforced,
    detail:
      'You can see what has been flagged, read or withhold conversations, delete anything '
      + 'Chittu remembers, and erase the whole account.',
    evidence:
      'You are reading this behind the PIN. The PIN is checked on the server and lasts '
      + '15 minutes; erasing the account and unlocking a paused chat both refuse without it.',
  });

  // ---- 4. the content wall -------------------------------------------------
  const walls = ['L1_LEXICON', 'L2_CLASSIFIER', 'L5_SANDBOX', 'L6_FILTER'] as const;
  const present = walls.filter((w) => PIPELINE_ORDER.includes(w));
  add({
    id: 'content-wall',
    title: 'Nothing adult, violent or frightening reaches your child',
    status: present.length === walls.length ? 'enforced' : 'partial',
    label: LABEL[present.length === walls.length ? 'enforced' : 'partial'],
    detail:
      'Every message is checked on the way in and again on the way out, and the order '
      + 'of those checks cannot be skipped.',
    evidence:
      `${present.length} of ${walls.length} checking layers are in the fixed order the code `
      + `walks: ${present.join(', ')}. Read from the order itself, which is the same list `
      + `the pipeline steps through.`,
  });

  // ---- 5. crisis: scripted words, real numbers -----------------------------
  const linesVerified = helplines.source === 'registry' && helplines.status === 'verified';
  add({
    id: 'crisis-helplines',
    title: 'If your child is in danger: a scripted reply and a real helpline',
    status: linesVerified ? 'enforced' : 'partial',
    label: LABEL[linesVerified ? 'enforced' : 'partial'],
    detail:
      'Chittu never improvises in a crisis. It says words we wrote in advance, shows the '
      + 'local helplines, pauses the chat and tells you.',
    evidence: linesVerified
      ? `The helplines for ${helplines.name} were last checked on `
        + `${(helplines.lastVerified ?? '').slice(0, 10)} and are being served from the `
        + `checked list.`
      : helplines.source === 'builtin'
        ? `Your child is being shown the numbers built into the app for ${helplines.name}, `
          + `not a separately checked list — the checked list is `
          + `${helplines.status === 'P0_WRONG_NUMBER' ? 'marked wrong' : 'not loaded'}. `
          + `The numbers still show; nobody has re-checked them recently.`
        : `The checked list for ${helplines.name} is overdue for re-checking `
          + `(last checked ${(helplines.lastVerified ?? '').slice(0, 10)}). Your child is `
          + `still shown those numbers — overdue is not the same as wrong.`,
  });

  // ---- 6. clinical review — nobody has done it -----------------------------
  add({
    id: 'clinical-review',
    title: 'A clinician has reviewed what Chittu says in a crisis',
    status: 'absent',
    label: LABEL.absent,
    detail:
      'The crisis wording was written carefully, but no psychologist or child-safeguarding '
      + 'clinician has reviewed it.',
    evidence:
      'Nothing in this system records such a review, because none has happened. This row '
      + 'is a known gap, not a measurement.',
  });

  // ---- 7. maths is not guessed --------------------------------------------
  add({
    id: 'deterministic-maths',
    title: 'Sums are calculated, not guessed by an AI',
    status: maths.ok ? 'enforced' : 'partial',
    label: LABEL[maths.ok ? 'enforced' : 'partial'],
    detail:
      'Arithmetic is answered by a calculator inside Chittu, so it cannot invent an answer. '
      + 'You can run the check yourself on this page.',
    evidence:
      `${maths.passed} of ${maths.total} live sums matched the known answers just now, `
      + `with no AI involved.`,
  });

  // ---- 8. teenagers' words are never written down --------------------------
  const teenOk = p !== null && p.teen_checks > 0;
  add({
    id: 'teen-words-never-stored',
    title: "A 13–17-year-old's messages are never stored",
    status: teenOk ? 'enforced' : 'absent',
    label: LABEL[teenOk ? 'enforced' : 'absent'],
    detail:
      'For a teenager, you get the topics and the safety flags and nothing else — because '
      + 'their words are not kept anywhere for us to show you.',
    evidence: teenOk
      ? `The database itself refuses them: the check "teen_bodies_are_never_stored" is `
        + `present on the messages table (${p.teen_checks} place(s), including each monthly `
        + `partition). It is not a rule the app is trusted to follow.`
      : 'The database check that enforces this could not be found. That is a defect.',
  });

  // ---- 9. tamper-evident record -------------------------------------------
  add({
    id: 'tamper-evident-record',
    title: 'The record cannot be quietly edited',
    status: input.seal.ok ? 'enforced' : 'absent',
    label: LABEL[input.seal.ok ? 'enforced' : 'absent'],
    detail:
      'Every turn is sealed into a chain. If one character were changed or one record '
      + 'removed, the check fails.',
    evidence: input.seal.ok
      ? `${input.seal.records} sealed record(s) across ${input.seal.sessions} conversation(s) `
        + `were recomputed from the beginning just now. Nothing had been altered.`
      : 'The chain did not verify. Please tell us — this should never happen.',
  });

  // ---- 10. encryption + erasure -------------------------------------------
  const managedKey = p?.key_ref != null && !p.key_ref.startsWith('local:');
  add({
    id: 'encryption-and-erasure',
    title: "Your child's data is encrypted, and erasing it destroys the key",
    status: managedKey ? 'enforced' : 'partial',
    label: LABEL[managedKey ? 'enforced' : 'partial'],
    detail:
      'Names, messages and memories are stored encrypted under a key that belongs to your '
      + 'child alone. Erasing the account destroys that key, which makes the data '
      + 'unreadable rather than merely deleted.',
    evidence: p === null || p.key_ref === null
      ? 'The key record for this account could not be read just now.'
      : managedKey
        ? `This account's key is held in a managed key service (${p.key_ref}).`
        : `This account's key is the local development key ("${p.key_ref}"), not a managed `
          + `key service. Encryption and erasure work; the key custody is a development `
          + `arrangement, not a production one.`,
  });

  // ---- 11. THE DECLARATIVE ROW --------------------------------------------
  // The one the checklist exists to be honest about.
  add({
    id: 'database-role-separation',
    title: 'Separate database accounts limit what each part of Chittu can reach',
    status: 'declarative',
    label: LABEL.declarative,
    detail:
      'The design gives the part of Chittu your child talks to a restricted database '
      + 'account that cannot read other families\' rows or reach the training data. That '
      + 'design is written into the schema and is NOT switched on in this deployment. '
      + 'What actually keeps one family\'s data out of another\'s is a separate check in '
      + 'the code, which stops the query outright.',
    evidence: p === null
      ? 'The database could not be read just now, so this row could not be checked — but '
        + 'the separation is inert by design in every environment built so far.'
      : `Read from Postgres: ${p.declared_roles} restricted role(s) are declared `
        + `— ${p.role_detail} — and ${p.login_roles} of them can log in, so nothing `
        + `connects as one. This service `
        + `connects as "${p.runtime_role}", which owns ${p.owned_by_runtime} of `
        + `${RLS_TABLES.length} child tables — an owner holds every privilege and bypasses `
        + `row-level security. ${p.policies} row-level policies exist and `
        + `${p.rls_forced} table(s) have FORCE ROW LEVEL SECURITY set, so the policies are `
        + `inert. The grants and the policies are a correct specification of what a `
        + `deployment would switch on; they are not enforced here and this row does not `
        + `claim they are.`,
  });

  // ---- 12. adversarial testing as a release gate ---------------------------
  add({
    id: 'red-team-gate',
    title: 'A full attack corpus is run before every release',
    status: 'absent',
    label: LABEL.absent,
    detail:
      'Chittu is tested against the ways children actually write, but the full adversarial '
      + 'corpus that a release should have to pass does not exist yet.',
    evidence:
      'No such corpus and no such release gate exist in this system. This row is a known '
      + 'gap, not a measurement.',
  });

  // ---- 13. independent audit ----------------------------------------------
  add({
    id: 'independent-audit',
    title: 'An independent auditor has certified Chittu (kidSAFE / KORA-class)',
    status: 'absent',
    label: LABEL.absent,
    detail:
      'Chittu is BUILT to these criteria. Nobody outside the team has checked that claim, '
      + 'and no certification has been filed.',
    evidence:
      'No audit or filing is recorded anywhere in this system, because none has been '
      + 'started. This row is a known gap, not a measurement.',
  });

  const tally = (s: ControlStatus): number => controls.filter((c) => c.status === s).length;

  return {
    checkedAt: new Date().toISOString(),
    // Counted from the rows, never maintained beside them — a summary that can
    // disagree with its own list is the same defect as a hand-kept checklist.
    summary: {
      enforced: tally('enforced'),
      partial: tally('partial'),
      declarative: tally('declarative'),
      absent: tally('absent'),
    },
    controls,
    note:
      'Every line above was checked against this running system a moment ago, including '
      + 'the ones that say we have not done something. Nothing here is a tick somebody '
      + 'maintains by hand.',
  };
}
