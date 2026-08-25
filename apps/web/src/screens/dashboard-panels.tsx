/**
 * The dashboard's panels.
 *
 * Every one of these renders data the server computed. None of them decides
 * anything, and none of them has a code path that could display a child's words
 * where the doctrine says it must not — the flag panels take a `ParentFlag`,
 * which has no field for a quote, and the transcript panel obeys
 * `bodiesIncluded` rather than checking the band itself.
 */

import { useEffect, useState } from 'preact/hooks';
import type {
  Api, CertificationResponse, DashboardResponse, HarnessResponse,
  ParentFlag, SessionSummary, TranscriptResponse,
} from '../api';

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export function StatsPanel({ d }: { d: DashboardResponse }): preact.JSX.Element {
  const cells: readonly [string, string | number][] = [
    ['Conversations', d.stats.sessions],
    ['Messages', d.stats.messages],
    ['Things remembered', d.stats.memories],
    // The prototype called these "spines". A parent should not have to learn
    // our vocabulary to read their own dashboard.
    ['Scripted safety replies', d.stats.spines],
    // D5's reading stat, formatted as the prototype formatted it
    // (chittu-v3.html:1190): a percentage plus the sentence count, or an
    // em dash before the first attempt. Computed from aggregates — the words
    // a child read or misread are not in this payload.
    ['Reading accuracy', d.stats.readingWords > 0
      ? `${Math.round((d.stats.readingHits / d.stats.readingWords) * 100)}% `
        + `(${d.stats.readingAttempts} sent.)`
      : '—'],
  ];
  return (
    <section class="card">
      <h3>{d.child.firstName} at a glance</h3>
      <p class="sub">
        {d.child.band === 'explorer' ? 'Explorer (4–7)'
          : d.child.band === 'builder' ? 'Builder (8–12)' : 'Thinker (13–17)'}
        {d.child.board !== 'General' && ` · ${d.child.board}`}
        {d.stats.lastSeen && ` · last chat ${when(d.stats.lastSeen)}`}
      </p>
      <div class="stats">
        {cells.map(([label, n]) => (
          <div class="stat" key={label}>
            <span class="stat__n">{n}</span>
            <span class="stat__l">{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function FlagList(
  { flags, empty }: { flags: readonly ParentFlag[]; empty: string },
): preact.JSX.Element {
  if (flags.length === 0) return <p class="empty">{empty}</p>;
  return (
    <ul class="flaglist">
      {flags.map((f, i) => (
        <li key={i} class={`flagrow flagrow--${f.kind.toLowerCase()}`}>
          <span class="flagrow__cat">{f.category}</span>
          <p>{f.body}</p>
          {f.topic !== null && <p class="flagrow__topic">Topic: {f.topic}</p>}
          <time>{when(f.at)}</time>
        </li>
      ))}
    </ul>
  );
}

export function SafetyPanel({ d }: { d: DashboardResponse }): preact.JSX.Element {
  return (
    <section class="card card--safety">
      <h3>⚑ Safety flags</h3>
      <p class="sub">
        <b>Category only — never your child's words.</b> We record that something
        came up and which kind of thing it was. What was actually said is not
        stored for us to show you, and that is deliberate.
      </p>
      <FlagList flags={d.flags.safety} empty="Nothing has been flagged." />
    </section>
  );
}

export function AssistPanel({ d }: { d: DashboardResponse }): preact.JSX.Element {
  return (
    <section class="card card--assist">
      <h3>🤝 Moments that deserve a grown-up</h3>
      <p class="sub">
        Not safety problems — a repeated struggle with a school topic, or a big
        question a family answers better than a machine.
      </p>
      <FlagList
        flags={d.flags.assist}
        empty="Nothing yet. Examples: repeated difficulty with fractions, or a question about death or war."
      />
      {d.flags.gate.length > 0 && (
        <>
          <h3 class="card__sub">🔒 Dashboard access</h3>
          <FlagList flags={d.flags.gate} empty="" />
        </>
      )}
    </section>
  );
}

export function HelplinePanel({ d }: { d: DashboardResponse }): preact.JSX.Element {
  return (
    <section class="card">
      <h3>☎️ If you need a person, right now</h3>
      <p class="sub">Verified lines for {d.helplines.name}.</p>
      <ul class="helplines">
        {d.helplines.lines.map((l) => (
          <li key={l.contact}>
            <b>{l.name}</b>
            <span>{l.contact}</span>
          </li>
        ))}
      </ul>
      <p class="sub">Your consent is recorded under {d.helplines.law}.</p>
    </section>
  );
}

export function LearningPanel({ d }: { d: DashboardResponse }): preact.JSX.Element {
  return (
    <section class="card card--muted">
      <h3>🔬 Helping Chittu improve</h3>
      {d.learning.optedIn ? (
        <p>
          You have this switched <b>on</b>. It does not mean your child's chats
          train anything — raw conversations never train models. It means we may
          count your child's turns inside an anonymous aggregate, of at least 25
          children, that a person reviews before anything changes.
        </p>
      ) : (
        <p>
          Switched <b>off</b>, which is the default. Nothing from your child's
          chats contributes to improving Chittu.
        </p>
      )}
      {/*
        Not an empty panel: there is genuinely nothing per-child to list, and
        saying so is the honest version. The insight table has no link back to a
        child, so "your child's items" is not a thing that can exist.
      */}
      <p class="sub">
        There is no per-child list here because there is nothing to list — what
        we learn from is stored with no way back to any individual child.
      </p>
    </section>
  );
}

export function ConversationsPanel(
  { d, api }: { d: DashboardResponse; api: Api },
): preact.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const [t, setT] = useState<TranscriptResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function show(s: SessionSummary): Promise<void> {
    if (open === s.id) { setOpen(null); setT(null); return; }
    setOpen(s.id); setT(null); setErr(null); setLoading(true);
    try { setT(await api.transcript(s.id)); }
    catch { setErr("Couldn't load that conversation."); }
    finally { setLoading(false); }
  }

  return (
    <section class="card">
      <h3>💬 Conversations</h3>
      <p class="sub">
        {d.child.band === 'thinker'
          ? 'Your teenager gets a topics-only view — see the note inside any conversation.'
          : 'Everything your child and Chittu said to each other.'}
      </p>

      {d.sessions.length === 0 && <p class="empty">No conversations yet.</p>}

      <ul class="sessionlist">
        {d.sessions.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              class={`sessionrow${open === s.id ? ' is-open' : ''}`}
              aria-expanded={open === s.id}
              onClick={() => { void show(s); }}
            >
              <span>{when(s.startedAt)}</span>
              <span class="sessionrow__meta">
                {s.msgCount} message{s.msgCount === 1 ? '' : 's'}
                {s.crisisLock && <span class="sessionrow__lock"> · paused</span>}
              </span>
            </button>

            {open === s.id && (
              <div class="transcript">
                {loading && <p class="sub">Loading…</p>}
                {err !== null && <p class="field__error">{err}</p>}
                {t && (
                  <>
                    {/* The server decides; this only reports. */}
                    {!t.bodiesIncluded && t.note !== null && (
                      <p class="transcript__note">{t.note}</p>
                    )}
                    {t.turns.length === 0 && <p class="empty">Nothing was said.</p>}
                    {t.turns.map((turn) => (
                      <p key={turn.seq} class={`trow trow--${turn.role}`}>
                        <span class="trow__who">
                          {turn.role === 'child' ? d.child.firstName : 'Chittu'}
                        </span>
                        {turn.body !== null
                          ? turn.body
                          : <span class="trow__topic">{turn.topic ?? 'chat'}</span>}
                      </p>
                    ))}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}


/**
 * D5/HARNESS — "run 5 live checks vs truth", on demand.
 *
 * It does not run on load. A parent pressing the button and watching the
 * answers appear is the demonstration; a result already sitting there when the
 * page opened is indistinguishable from a picture of a result.
 *
 * Every number shown comes from the server. The only thing decided here is
 * whether a row gets a tick or a cross, and that is read from `ok` rather than
 * recomputed — a client that graded the answers itself would be a second
 * implementation of the thing under test.
 */
export function MathsHarnessPanel({ api }: { api: Api }): preact.JSX.Element {
  const [r, setR] = useState<HarnessResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run(): Promise<void> {
    setRunning(true); setErr(null); setR(null);
    try { setR(await api.mathsCheck()); }
    catch { setErr("Couldn't run the check just now."); }
    finally { setRunning(false); }
  }

  return (
    <section class="card">
      <h3>🎯 Check Chittu&rsquo;s maths</h3>
      <p class="sub">
        Sums are worked out by a calculator built into Chittu, not guessed by an AI.
        This runs five of them right now and compares each answer with the right one.
      </p>
      <button type="button" class="btn btn--secondary" disabled={running}
        onClick={() => { void run(); }}>
        {running ? 'Checking…' : 'Run five checks'}
      </button>

      {err !== null && <p class="field__error" role="alert">{err}</p>}

      {r !== null && (
        <div class="harness" role="status">
          <ul class="harness__list">
            {r.items.map((i) => (
              <li key={i.shown} class={`harness__row harness__row--${i.ok ? 'ok' : 'bad'}`}>
                <span class="harness__mark" aria-hidden="true">{i.ok ? '✓' : '✗'}</span>
                <span class="harness__sum">{i.shown}</span>
                <span class="harness__got">
                  {/* Never blank: "no answer" must not look like a quiet pass. */}
                  Chittu said {i.got === null ? 'nothing' : i.got}
                </span>
                <span class="harness__truth">right answer {i.truth}</span>
              </li>
            ))}
          </ul>
          <p class={`harness__score${r.ok ? '' : ' harness__score--bad'}`}>
            <b>{r.passed} of {r.total} correct.</b>
          </p>
          <p class="sub">{r.note}</p>
        </div>
      )}
    </section>
  );
}

/**
 * D5/CERT — the readiness checklist.
 *
 * The prototype's version was nine hand-written rows, six of them badged
 * BUILT-IN. This one renders what the server probed out of the running system,
 * and it renders the server's own words for each status — including
 * "Written down, not switched on", which is the honest label for the schema's
 * database-role separation: declared, inert, and protecting nobody today.
 *
 * The rows that say "Not done" are not failures of this panel. They are the
 * reason it can be trusted.
 */
export function CertificationPanel({ api }: { api: Api }): preact.JSX.Element {
  const [r, setR] = useState<CertificationResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.certification()
      .then((x) => { if (live) setR(x); })
      .catch(() => { if (live) setErr("Couldn't check these just now."); });
    return () => { live = false; };
  }, [api]);

  return (
    <section class="card">
      <h3>🏅 What is actually in place</h3>
      <p class="sub">
        Chittu is built to the criteria a children&rsquo;s certifier (kidSAFE, KORA-class)
        would ask about. Each line below was checked against the running system a moment
        ago &mdash; including the lines that say we have not done something.
      </p>

      {err !== null && <p class="field__error" role="alert">{err}</p>}
      {r === null && err === null && <p class="sub">Checking…</p>}

      {r !== null && (
        <>
          <p class="certsum">
            <b>{r.summary.enforced} in place</b> · {r.summary.partial} partly ·{' '}
            {r.summary.declarative} written down but not switched on ·{' '}
            {r.summary.absent} not done
          </p>
          <ul class="certlist">
            {r.controls.map((c) => (
              <li key={c.id} class={`certrow certrow--${c.status}`}>
                <button
                  type="button"
                  class="certrow__head"
                  aria-expanded={open === c.id}
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                >
                  <span class="certrow__title">{c.title}</span>
                  {/* The server's word for the status, never one of ours. */}
                  <span class={`certrow__badge certrow__badge--${c.status}`}>{c.label}</span>
                </button>
                <p class="certrow__detail">{c.detail}</p>
                {open === c.id && (
                  <p class="certrow__evidence">
                    <b>What we checked:</b> {c.evidence}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p class="sub">{r.note}</p>
        </>
      )}
    </section>
  );
}
