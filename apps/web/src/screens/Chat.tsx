/**
 * The child surface.
 *
 * Everything that decides anything happens on the other end of `api.turn`. This
 * screen opens a session, posts text, and renders what comes back — including
 * the crisis lock, which it obeys rather than evaluates. There is no branch here
 * that inspects a child's words.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Block, Mode } from '@chittu/contracts';
import type { Api } from '../api';
import { ApiError, OfflineError } from '../api';
import { guardBlocks } from '../safety/render-guard';
import { HonestyBadge } from '../components/HonestyBadge';
import { ModeBar } from '../components/ModeBar';
import { MessageLog } from '../components/MessageLog';
import { Composer } from '../components/Composer';
import { CrisisPanel } from '../components/CrisisPanel';
import { modeInfo } from '../catalog';
import {
  busy, crisisLock, memories, messages, mode, nextId, push, session,
  speechSynthesisAvailable, lite,
} from '../store';

export function Chat(
  { api, onParentGate, onMemoryBook }:
  { api: Api; onParentGate: () => void; onMemoryBook: () => void },
): preact.JSX.Element {
  const [fatal, setFatal] = useState<string | null>(null);
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
        push({
          id: nextId(), role: 'chittu',
          blocks: [
            { kind: 'big', emoji: '🐦' },
            { kind: 'text', text: "Hello! I'm Chittu. Ask me anything, or pick something below." },
          ],
          trace: 'SPINE · welcome',
          layers: [],
        });
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

    push({ id: nextId(), role: 'child', text });
    busy.value = true;
    try {
      const r = await api.turn(s.sessionId, text, mode.value);
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
    }
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
    if (m === 'read') {
      // The reading coach needs POST /session/:id/read, which does not exist
      // yet. Saying so beats a mode that silently behaves like chat.
      push({
        id: nextId(), role: 'system',
        text: 'Reading practice is not switched on yet — it is still being built.',
      });
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

      <Composer
        disabled={locked || busy.value || session.value === null}
        {...(locked ? { placeholder: 'Paused until a grown-up unlocks it' } : {})}
        onSend={(t) => { void send(t); }}
      />
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
