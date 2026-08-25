/**
 * The child surface.
 *
 * Everything that decides anything happens on the other end of `api.turn`. This
 * screen opens a session, posts text, and renders what comes back — including
 * the crisis lock, which it obeys rather than evaluates. There is no branch here
 * that inspects a child's words.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Block, ImageInput, Mode } from '@chittu/contracts';
import { passagesFor, type ReadPassage } from '@chittu/reading-coach';
import type { Api } from '../api';
import { ApiError, OfflineError } from '../api';
import { guardBlocks } from '../safety/render-guard';
import { HonestyBadge } from '../components/HonestyBadge';
import { ModeBar } from '../components/ModeBar';
import { MessageLog } from '../components/MessageLog';
import { Composer } from '../components/Composer';
import { ReadCoach } from '../components/ReadCoach';
import { CrisisPanel } from '../components/CrisisPanel';
import { modeInfo } from '../catalog';
import {
  busy, crisisLock, memories, messages, mode, nextId, profile, push, session,
  speechSynthesisAvailable, lite,
} from '../store';

export function Chat(
  { api, onParentGate, onMemoryBook }:
  { api: Api; onParentGate: () => void; onMemoryBook: () => void },
): preact.JSX.Element {
  const [fatal, setFatal] = useState<string | null>(null);
  /** The passage on the current read card. Chosen here, scored by the server. */
  const [passage, setPassage] = useState<ReadPassage | null>(null);
  /**
   * The picture waiting to go with the next message, if the child chose one.
   *
   * ONE AT A TIME, AND ONLY THE NEXT TURN. Picking a second replaces the first;
   * sending clears it in `finally`, so a failed turn does not leave a picture
   * armed for a later, unrelated message. Nothing writes it to `localStorage` —
   * nothing in this client writes anything there, and a test asserts it.
   */
  const [pending, setPending] = useState<{ image: ImageInput; url: string } | null>(null);
  const opening = useRef(false);

  // One session per visit. The guard is a ref rather than state because two
  // renders must not produce two sessions — that would fork the seal chain.
  useEffect(() => {
    if (session.value !== null || opening.current) return;
    opening.current = true;
    // No credential passed: the consent cookie travels with the request and the
    // server decides. This screen is only reachable once the server already
    // confirmed the consent is active, so a 403 here means it changed underneath
    // us — revoked in another tab, or expired.
    api.openSession()
      .then(async (s) => {
        session.value = s;

        /**
         * The lock comes from the SERVER, always.
         *
         * A reloaded page has no memory of the turn that locked the session, so
         * a client that only set this from a turn response let a child escape a
         * crisis lock by pressing F5. The server now resumes the locked session
         * and says so; this line is what makes the page obey it.
         */
        crisisLock.value = s.crisisLock;

        if (s.resumed) {
          await repaint(s.sessionId);
          return;
        }
        /**
         * D1/H — "Scripted welcome + one warm memory if any".
         *
         * The words come from the SERVER, and this screen holds no copy of its
         * own. The welcome may now carry a stored memory, and which stored fact
         * may be spoken back to a child is an allowlist decision — the same one
         * that governs `memAdd`. A greeting hard-coded here would be a second
         * source of truth for scripted copy, and a client that picked the memory
         * itself would be the client making that decision.
         *
         * Nothing is invented when the server sends none: saying nothing to a
         * stale API is honest, and inventing a greeting is how the copy drifts.
         */
        if (s.welcome) {
          push({
            id: nextId(), role: 'chittu',
            blocks: s.welcome.blocks, trace: s.welcome.trace, layers: [],
          });
        }
      })
      .catch((e: unknown) => {
        // A 403 here means the consent is not active. Saying "your grown-up
        // needs to finish setting up" is honest; "something went wrong" is not.
        setFatal(e instanceof ApiError && e.status === 403
          ? 'A grown-up needs to finish setting Chittu up.'
          : e instanceof OfflineError
            ? "I can't reach the internet right now."
            : 'Something went wrong starting our chat.');
      })
      .finally(() => { opening.current = false; });
  }, [api]);

  /**
   * Put the earlier conversation back on screen.
   *
   * Only the text is restored, not the cards and chips: what is stored is the
   * flattened reply a parent reads, and re-deriving blocks from it is not
   * possible. A plainer repaint is a fair trade for not losing the
   * conversation, and it is honest — nothing is invented that was not said.
   */
  async function repaint(sessionId: string): Promise<void> {
    try {
      const r = await api.ownMessages(sessionId);
      if (!r.restorable) {
        // A teen's words were never written down. Say so; an empty screen would
        // read as "we lost your chat".
        if (r.note !== null) push({ id: nextId(), role: 'system', text: r.note });
        return;
      }
      for (const t of r.turns) {
        if (t.text === null) continue;
        if (t.role === 'child') {
          push({ id: nextId(), role: 'child', text: t.text });
        } else {
          push({
            id: nextId(), role: 'chittu',
            blocks: [{ kind: 'text', text: t.text }],
            trace: 'from earlier', layers: [],
          });
        }
      }
    } catch {
      push({
        id: nextId(), role: 'system',
        text: "I couldn't bring back what we said earlier, but we can keep going.",
      });
    }
  }

  async function send(text: string): Promise<void> {
    const s = session.value;
    if (s === null || busy.value || crisisLock.value) return;

    /**
     * Read mode has no free-typed path (the composer is replaced by the mic
     * panel), so text arriving here is a chip tap — navigation the prototype
     * also dispatched locally (chittu-v3.html:1047). These never become model
     * turns: "Next sentence!" is a tap, not an utterance.
     */
    if (mode.value === 'read') { readNav(text); return; }

    /**
     * The picture is claimed HERE, before the await, and cleared in `finally`.
     *
     * Reading it inside the try would let a second send pick up the same
     * picture while the first is still in flight — the same turn's image
     * attached to two turns.
     */
    const shown = pending;
    push({ id: nextId(), role: 'child', text });
    busy.value = true;
    try {
      const r = await api.turn(s.sessionId, text, mode.value, shown?.image);
      push({
        id: nextId(), role: 'chittu',
        blocks: r.blocks, trace: r.trace, layers: r.layers,
      });
      if (r.memorySaved) {
        memories.value = [...memories.value, r.memorySaved];
        push({ id: nextId(), role: 'memory', memory: r.memorySaved });
      }
      crisisLock.value = r.crisisLock;
      if (!lite.value && speechSynthesisAvailable()) speak(r.blocks);
    } catch (e) {
      push({
        id: nextId(), role: 'system',
        text: e instanceof OfflineError
          ? "I can't reach the internet right now. Try again in a moment?"
          : e instanceof ApiError && e.status === 429
            ? "That was a lot at once! Give me a second to catch up."
            : 'Something went wrong. Ask me again?',
      });
    } finally {
      busy.value = false;
      // Cleared whatever happened. A picture that failed to send must not ride
      // along on the next, unrelated message.
      if (shown !== null) setPending(null);
    }
  }

  /**
   * A picture the child chose. It goes into the log immediately — so they can
   * see Chittu got it — and into `pending`, so it rides with the next message.
   *
   * The previous preview's object URL is revoked when it is replaced, which is
   * the only cleanup this needs: the Blob behind it is freed, and a `blob:` URL
   * that outlived its picture is a handle to nothing.
   */
  function pickImage(image: ImageInput, url: string): void {
    if (pending !== null) URL.revokeObjectURL(pending.url);
    setPending({ image, url });
    push({ id: nextId(), role: 'childimage', src: url });
    push({
      id: nextId(), role: 'system',
      text: 'Got your picture! Ask me anything about it — "what is this?" '
        + 'or "is my drawing good?" (I never save pictures.)',
    });
  }

  async function forget(memoryId: string): Promise<void> {
    const s = session.value;
    if (s === null) return;
    try {
      await api.forget(s.sessionId, memoryId);
      memories.value = memories.value.filter((m) => m.id !== memoryId);
      push({ id: nextId(), role: 'system', text: 'Forgotten. It is gone from the list.' });
    } catch {
      push({ id: nextId(), role: 'system', text: "I couldn't forget that just now." });
    }
  }

  function pickMode(m: Mode): void {
    mode.value = m;
    if (m === 'read') startReading();
  }

  // ---- the reading coach --------------------------------------------------
  // The client's share of it is deliberately small: pick a passage from the
  // static bank, show it, hand the transcript to the server, render the marks
  // that come back. Scoring, guarding and copy all live on the other end.

  function pickPassage(): ReadPassage | null {
    const band = session.value?.band;
    if (band === undefined) return null;
    const bank = passagesFor(band);
    return bank[Math.floor(Math.random() * bank.length)] ?? null;
  }

  function showPassage(p: ReadPassage): void {
    setPassage(p);
    // A fresh, unmarked card each time — earlier cards keep their marks, the
    // way the prototype's log kept every attempt on screen.
    push({
      id: nextId(), role: 'readcard',
      words: p.text.split(/\s+/).map((word) => ({ word, hit: null })),
    });
  }

  function startReading(): void {
    const p = pickPassage();
    if (p === null) return;   // session still opening; another tap retries
    push({
      id: nextId(), role: 'system',
      text: 'Reading time! Read the sentence out loud. '
        + 'Your voice is heard, checked, and discarded — never stored.',
    });
    showPassage(p);
  }

  /** Chip navigation inside read mode. Local, exactly as the prototype's. */
  function readNav(text: string): void {
    push({ id: nextId(), role: 'child', text });
    if (/next sentence/i.test(text)) {
      const p = pickPassage();
      if (p !== null) showPassage(p);
      return;
    }
    if (/read it again|try again/i.test(text)) {
      if (passage !== null) showPassage(passage);
      return;
    }
    if (/back to chat|stop reading/i.test(text)) {
      mode.value = 'chat';
      return;
    }
    push({
      id: nextId(), role: 'system',
      text: '🎙 Tap the mic and read the sentence out loud — or tap a choice!',
    });
  }

  /**
   * One scored attempt. The transcript is text the browser produced and the
   * audio is already gone. If a guard fired server-side there is no `reading`
   * payload — the blocks are rendered exactly like a chat turn's, and the
   * crisis lock is obeyed the same way.
   */
  async function readAloud(transcript: string): Promise<void> {
    const s = session.value;
    const p = passage;
    if (s === null || p === null || busy.value || crisisLock.value) return;

    push({ id: nextId(), role: 'child', text: `${transcript} 🎙` });
    busy.value = true;
    try {
      const r = await api.read(s.sessionId, p.id, transcript);
      if (r.reading) {
        push({ id: nextId(), role: 'readcard', words: r.reading.words });
        push({ id: nextId(), role: 'readscore', text: r.reading.line });
      }
      push({
        id: nextId(), role: 'chittu',
        blocks: r.blocks, trace: r.trace, layers: r.layers,
      });
      crisisLock.value = r.crisisLock;
      if (!lite.value && speechSynthesisAvailable()) speak(r.blocks);
    } catch (e) {
      push({
        id: nextId(), role: 'system',
        text: e instanceof OfflineError
          ? "I can't reach the internet right now. Try again in a moment?"
          : e instanceof ApiError && e.status === 429
            ? 'That was a lot at once! Give me a second to catch up.'
            : 'Something went wrong. Try reading it again?',
      });
    } finally {
      busy.value = false;
    }
  }

  if (fatal !== null) {
    return (
      <main class="chat">
        <HonestyBadge />
        <p class="msg msg--system" role="alert">{fatal}</p>
      </main>
    );
  }

  const locked = crisisLock.value;
  const starters = modeInfo(mode.value).starters;

  return (
    <main class="chat">
      <header class="topbar">
        <div class="brand">
          <span class="brand__bird" aria-hidden="true">🐦</span>
          <span class="brand__name">Chittu <span class="brand__tam">சிட்டு</span></span>
        </div>
        <HonestyBadge />
        <div class="topbar__actions">
          <button type="button" class="chip" onClick={onMemoryBook}>📖 What you remember</button>
          <button type="button" class="chip" onClick={onParentGate}>👪 Grown-ups</button>
        </div>
      </header>

      <ModeBar current={mode.value} onPick={pickMode} disabled={locked} />

      {locked && <CrisisPanel onParentGate={onParentGate} />}

      <MessageLog
        messages={messages.value}
        thinking={busy.value}
        onChip={(t) => { void send(t); }}
        onForget={(id) => { void forget(id); }}
      />

      {!locked && starters.length > 0 && messages.value.length <= 1 && (
        <div class="starters">
          {starters.map((s) => (
            <button key={s} type="button" class="starters__btn"
              onClick={() => { void send(s); }}>{s}</button>
          ))}
        </div>
      )}

      {mode.value === 'read' && !locked
        ? (
          <ReadCoach
            disabled={busy.value || session.value === null || passage === null}
            canHearVoice={profile.value?.voiceOn ?? false}
            onTranscript={(t) => { void readAloud(t); }}
          />
        )
        : (
          <Composer
            disabled={locked || busy.value || session.value === null}
            {...(locked ? { placeholder: 'Paused until a grown-up unlocks it' } : {})}
            onSend={(t) => { void send(t); }}
            /**
             * NO GRANT, NO PROP, NO BUTTON — this component's own rule, so the
             * camera is gated here rather than by a third flag.
             *
             * The GRANT is the only thing tested here. A crisis lock is already
             * handled by `disabled` above, which both controls honour; adding
             * `&& !locked` here as well would make the button vanish mid-lock
             * rather than grey out, which is a different (and louder) thing to
             * do to a child who has just been shown helplines.
             */
            {...((profile.value?.visionOn ?? false)
              ? { onPickImage: pickImage, hasImage: pending !== null }
              : {})}
            canHearVoice={profile.value?.voiceOn ?? false}
          />
        )}
    </main>
  );
}

/**
 * Read the reply aloud. Only the prose blocks — reading "chips" or a code
 * snippet aloud is noise, and the emoji is decorative.
 *
 * **It guards the blocks itself, and that is the whole point of this function
 * being written this way.** Speech is a second output channel: the renderer
 * dropping a leaked `CRISIS` token from the screen does nothing about a speech
 * synthesiser reading it out. The first draft of this took the raw response and
 * would have spoken exactly what the screen refused to show.
 *
 * Non-strict on purpose. The renderer sees the same blocks and throws in
 * development, so the bug is still loud; making the audio path throw as well
 * would only mean a crash instead of a rendered page.
 */
export function speak(raw: readonly Block[]): void {
  const { blocks } = guardBlocks(raw, { strict: false });
  const say = blocks
    .filter((b): b is Extract<Block, { text: string }> =>
      b.kind === 'text' || b.kind === 'fact' || b.kind === 'quiz')
    .map((b) => b.text)
    .join(' ')
    .trim();
  if (say === '') return;
  try {
    const u = new SpeechSynthesisUtterance(say);
    u.rate = 0.95;
    globalThis.speechSynthesis.cancel();
    globalThis.speechSynthesis.speak(u);
  } catch { /* a browser that lied about having it */ }
}
