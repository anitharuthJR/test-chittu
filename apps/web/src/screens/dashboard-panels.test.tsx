/**
 * The dashboard panels, tested for the two things that would be a doctrine
 * breach rather than a bug:
 *
 *   1. A teen's words must not appear, and their absence must be EXPLAINED
 *      rather than shown as a blank — a parent who sees an empty transcript
 *      concludes their teenager has not used it.
 *   2. A safety flag must render a category and vetted wording, and there must
 *      be no path by which a child's quote could reach the screen.
 *
 * The server is the control for both. These assert the client does not undo it.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import type { Api, DashboardResponse, TranscriptResponse } from '../api';
import {
  StatsPanel, SafetyPanel, AssistPanel, HelplinePanel, LearningPanel, ConversationsPanel,
} from './dashboard-panels';

const base: DashboardResponse = {
  child: { firstName: 'Meera', band: 'builder', country: 'IN', board: 'CBSE' },
  consent: {
    law: 'DPDP', method: 'dev_stub', status: 'active',
    issuedAt: '2026-08-01T00:00:00.000Z', expiresAt: null,
    scopes: { memory: true, learning: false },
  },
  stats: {
    sessions: 3, messages: 42, spines: 2, memories: 5,
    crisisLocked: false,
    firstSeen: '2026-08-01T09:00:00.000Z', lastSeen: '2026-08-24T18:00:00.000Z',
    readingAttempts: 2, readingWords: 16, readingHits: 15,
  },
  sessions: [{
    id: 's1', band: 'builder', startedAt: '2026-08-24T18:00:00.000Z',
    endedAt: null, msgCount: 4, crisisLock: false,
  }],
  memories: [],
  flags: { safety: [], assist: [], gate: [] },
  helplines: {
    name: 'India', law: 'DPDP', consent: 'parental',
    lines: [{ name: 'Tele-MANAS', contact: '14416' }],
  },
  learning: { optedIn: false, perChildQueueExists: false },
};

const stubApi = (transcript: TranscriptResponse): Api =>
  ({ transcript: vi.fn(async () => transcript) } as unknown as Api);

describe('StatsPanel', () => {
  it('names the numbers in a parent\'s vocabulary, not ours', () => {
    render(<StatsPanel d={base} />);
    expect(screen.getByText('42')).toBeTruthy();
    // "spines" is our word. A parent should not have to learn it.
    expect(screen.getByText(/scripted safety replies/i)).toBeTruthy();
    expect(screen.queryByText(/spine/i)).toBeNull();
  });

  it('shows reading accuracy as the prototype formatted it (D5)', () => {
    render(<StatsPanel d={base} />);
    // 15/16 words = 94%, across 2 sentences.
    expect(screen.getByText('94% (2 sent.)')).toBeTruthy();
    expect(screen.getByText(/reading accuracy/i)).toBeTruthy();
  });

  it('shows an em dash before the first attempt, never NaN', () => {
    const none = {
      ...base,
      stats: { ...base.stats, readingAttempts: 0, readingWords: 0, readingHits: 0 },
    };
    render(<StatsPanel d={none} />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});

describe('SafetyPanel', () => {
  it('shows the category and the vetted wording', () => {
    render(<SafetyPanel d={{
      ...base,
      flags: {
        ...base.flags,
        safety: [{
          kind: 'SAFETY', category: 'CRISIS', at: '2026-08-24T18:00:00.000Z',
          body: 'Possible distress or harm disclosure. Chat is in calm mode until you mark this handled.',
          topic: null,
        }],
      },
    }} />);
    expect(screen.getByText('CRISIS')).toBeTruthy();
    expect(screen.getByText(/possible distress or harm disclosure/i)).toBeTruthy();
  });

  it('states that it carries no quote, so an empty panel is not misread', () => {
    render(<SafetyPanel d={base} />);
    expect(screen.getByText(/never your child's words/i)).toBeTruthy();
    expect(screen.getByText(/nothing has been flagged/i)).toBeTruthy();
  });
});

describe('AssistPanel', () => {
  it('shows a school topic for an ASSIST flag', () => {
    render(<AssistPanel d={{
      ...base,
      flags: {
        ...base.flags,
        assist: [{
          kind: 'ASSIST', category: 'STRUGGLE', at: '2026-08-24T18:00:00.000Z',
          body: 'Repeated difficulty with a school topic.', topic: 'fractions',
        }],
      },
    }} />);
    expect(screen.getByText(/topic: fractions/i)).toBeTruthy();
  });
});

describe('ConversationsPanel — the teen carve-out', () => {
  const teenTranscript: TranscriptResponse = {
    band: 'thinker',
    bodiesIncluded: false,
    note: 'Your teenager gets a topics-only view. We do not store what they typed, '
      + 'so there is nothing here we are choosing to withhold — there is nothing to show.',
    turns: [
      { seq: 1, role: 'child', topic: 'science', body: null },
      { seq: 2, role: 'chittu', topic: 'science', body: null },
    ],
  };

  it('explains the absence instead of showing a blank', async () => {
    const d: DashboardResponse = { ...base, child: { ...base.child, band: 'thinker' } };
    render(<ConversationsPanel d={d} api={stubApi(teenTranscript)} />);

    fireEvent.click(screen.getByRole('button', { name: /message/i }));
    await waitFor(() => expect(screen.getByText(/topics-only view/i)).toBeTruthy());
    // The turns are still listed — a parent can see that conversations happened
    // and roughly what about. They just carry a topic instead of the words.
    expect(screen.getAllByText('science')).toHaveLength(2);
  });

  it('obeys `bodiesIncluded` rather than deciding from the band itself', async () => {
    // If the server ever says "no bodies" for a non-teen — a redacted turn, a
    // future rule — the client must honour it. A client that re-derived the
    // rule from the band would show the words anyway.
    const contradiction: TranscriptResponse = {
      band: 'builder', bodiesIncluded: false, note: 'Withheld for another reason.',
      turns: [{ seq: 1, role: 'child', topic: 'science', body: null }],
    };
    render(<ConversationsPanel d={base} api={stubApi(contradiction)} />);
    fireEvent.click(screen.getByRole('button', { name: /message/i }));
    await waitFor(() => expect(screen.getByText(/withheld for another reason/i)).toBeTruthy());
  });

  it('shows the words for a builder', async () => {
    const full: TranscriptResponse = {
      band: 'builder', bodiesIncluded: true, note: null,
      turns: [{ seq: 1, role: 'child', topic: 'science', body: 'why is the sky blue' }],
    };
    render(<ConversationsPanel d={base} api={stubApi(full)} />);
    fireEvent.click(screen.getByRole('button', { name: /message/i }));
    await waitFor(() => expect(screen.getByText('why is the sky blue')).toBeTruthy());
    expect(screen.queryByText(/topics-only/i)).toBeNull();
  });

  it('does not fetch a transcript until a parent opens one', () => {
    const api = stubApi(teenTranscript);
    render(<ConversationsPanel d={base} api={api} />);
    expect(api.transcript).not.toHaveBeenCalled();
  });
});

describe('HelplinePanel', () => {
  it('renders real contact details, so a crisis panel is never a dead end', () => {
    render(<HelplinePanel d={base} />);
    expect(screen.getByText('Tele-MANAS')).toBeTruthy();
    expect(screen.getByText('14416')).toBeTruthy();
  });
});

describe('LearningPanel', () => {
  it('says there is no per-child list, and why', () => {
    render(<LearningPanel d={base} />);
    expect(screen.getByText(/switched/i)).toBeTruthy();
    expect(screen.getByText(/nothing to list/i)).toBeTruthy();
  });

  it('does not claim chats train models when opted in', () => {
    render(<LearningPanel d={{
      ...base, learning: { optedIn: true, perChildQueueExists: false },
    }} />);
    expect(screen.getByText(/raw conversations never train models/i)).toBeTruthy();
    expect(screen.getByText(/at least 25/i)).toBeTruthy();
  });
});
