/**
 * "What Chittu remembers about you" — the child's own view.
 *
 * It is the SAME list the parent sees, deliberately (requirements §4.3). A
 * memory book that shows a child one thing and an adult another would make the
 * child's copy a decoration, and the point of showing it is that a child can
 * delete from it.
 *
 * The list is fetched from the server rather than read from local state,
 * because the server's copy is the one that exists. A memory the parent deleted
 * a minute ago must not still be sitting in this tab.
 */

import { useEffect, useState } from 'preact/hooks';
import type { Memory } from '@chittu/contracts';
import type { Api } from '../api';
import { memories, session } from '../store';

export function MemoryBook(
  { api, by, onBack }: { api: Api; by: 'child' | 'parent'; onBack: () => void },
): preact.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const s = session.value;

  useEffect(() => {
    if (s === null) { setLoading(false); return; }
    let live = true;
    api.memories(s.sessionId)
      .then((r) => { if (live) memories.value = r.memories; })
      .catch(() => { if (live) setError("I couldn't load the list just now."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, s]);

  async function forget(m: Memory): Promise<void> {
    if (s === null) return;
    try {
      await api.forget(s.sessionId, m.id);
      memories.value = memories.value.filter((x) => x.id !== m.id);
    } catch {
      setError("I couldn't forget that just now.");
    }
  }

  const list = memories.value;

  return (
    <main class="panel">
      <section class="card">
        <h2>📖 What Chittu remembers{by === 'parent' ? '' : ' about you'}</h2>
        <p class="sub">
          Only nice, everyday things — interests, pets, hobbies, favourites, achievements
          and things learned. Never feelings, health, family matters or fears.
          {by === 'child'
            ? ' Your grown-ups see this exact same list.'
            : ' Your child sees this exact same list, and can delete from it too.'}
        </p>

        {error !== null && <p class="field__error" role="alert">{error}</p>}
        {loading && <p class="sub">Loading…</p>}

        {!loading && list.length === 0 && (
          <p class="empty">
            {by === 'child'
              ? 'Nothing yet! Tell Chittu about things you love. 🐦'
              : 'Nothing has been remembered yet.'}
          </p>
        )}

        <ul class="memlist">
          {list.map((m) => (
            <li key={m.id} class="memrow">
              <span class="memrow__body">
                <span class="memory__cat">{m.category}</span>
                {m.fact}
                <small>since {new Date(m.since).toLocaleDateString()}</small>
              </span>
              <button type="button" class="memrow__forget"
                onClick={() => { void forget(m); }}>
                Forget
              </button>
            </li>
          ))}
        </ul>

        <button type="button" class="btn btn--secondary" onClick={onBack}>
          Back to Chittu
        </button>
      </section>
    </main>
  );
}
