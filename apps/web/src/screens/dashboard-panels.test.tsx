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
  MathsHarnessPanel, CertificationPanel,
} from './dashboard-panels';
import type { CertificationResponse, HarnessResponse } from '../api';

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


// ---------------------------------------------------------------------------
// D5's last two nodes.
// ---------------------------------------------------------------------------

const harness = (over: Partial<HarnessResponse> = {}): HarnessResponse => ({
  items: [
    { shown: '7 × 8', truth: 56, got: 56, inTheLesson: true, ok: true },
    { shown: '48 ÷ 6', truth: 8, got: 8, inTheLesson: true, ok: true },
  ],
  passed: 2, total: 2, ok: true,
  note: 'No AI was asked: sums are done by a calculator built into Chittu.',
  ...over,
});

describe('MathsHarnessPanel', () => {
  it('shows nothing until the parent runs it — a result on load is a picture', () => {
    const api = { mathsCheck: vi.fn(async () => harness()) } as unknown as Api;
    render(<MathsHarnessPanel api={api} />);
    expect(api.mathsCheck).not.toHaveBeenCalled();
    expect(screen.queryByText(/correct/i)).toBeNull();
  });

  it('runs five checks and shows each answer beside the right one', async () => {
    const api = { mathsCheck: vi.fn(async () => harness()) } as unknown as Api;
    render(<MathsHarnessPanel api={api} />);
    fireEvent.click(screen.getByRole('button', { name: /run five checks/i }));
    await waitFor(() => expect(screen.getByText(/2 of 2 correct/i)).toBeTruthy());
    expect(screen.getByText('7 × 8')).toBeTruthy();
    expect(screen.getByText(/Chittu said 56/)).toBeTruthy();
    expect(screen.getByText(/right answer 56/)).toBeTruthy();
  });

  /**
   * The failure this panel exists to make impossible: a sum the engine did not
   * answer rendering as a blank, which reads as a pass.
   */
  it('says "nothing" when the engine gave no answer, never a blank', async () => {
    const api = {
      mathsCheck: vi.fn(async () => harness({
        items: [{ shown: '7 × 8', truth: 56, got: null, inTheLesson: false, ok: false }],
        passed: 0, total: 1, ok: false,
      })),
    } as unknown as Api;
    render(<MathsHarnessPanel api={api} />);
    fireEvent.click(screen.getByRole('button', { name: /run five checks/i }));
    await waitFor(() => expect(screen.getByText(/Chittu said nothing/)).toBeTruthy());
    expect(screen.getByText(/0 of 1 correct/i)).toBeTruthy();
  });
});

const control = (over: Partial<CertificationResponse['controls'][number]>) => ({
  id: 'x', title: 'A title', status: 'enforced' as const,
  label: 'In place', detail: 'A detail.', evidence: 'What was read.', ...over,
});

const cert = (
  controls: CertificationResponse['controls'],
): CertificationResponse => ({
  checkedAt: '2026-08-25T10:00:00.000Z',
  summary: {
    enforced: controls.filter((c) => c.status === 'enforced').length,
    partial: controls.filter((c) => c.status === 'partial').length,
    declarative: controls.filter((c) => c.status === 'declarative').length,
    absent: controls.filter((c) => c.status === 'absent').length,
  },
  controls,
  note: 'Every line above was checked against this running system a moment ago.',
});

describe('CertificationPanel', () => {
  /**
   * The row the panel exists to be honest about. A `declarative` control must
   * not be dressed as a pass — the schema's database-role separation is
   * declared, inert, and protecting nobody today.
   */
  it('renders the server\'s own words for a declarative control, not a tick', async () => {
    const api = {
      certification: vi.fn(async () => cert([control({
        id: 'database-role-separation',
        title: 'Separate database accounts limit what each part of Chittu can reach',
        status: 'declarative',
        label: 'Written down, not switched on',
        detail: 'That design is written into the schema and is NOT switched on here.',
        evidence: 'chittu_app is NOLOGIN; FORCE ROW LEVEL SECURITY is set on 0 tables.',
      })])),
    } as unknown as Api;
    const { container } = render(<CertificationPanel api={api} />);
    await waitFor(() => expect(screen.getByText(/written down, not switched on/i)).toBeTruthy());
    // Not styled as a pass, and not counted as one.
    expect(container.querySelector('.certrow--declarative')).toBeTruthy();
    expect(container.querySelector('.certrow--enforced')).toBeNull();
    expect(screen.getByText(/1 written down but not switched on/i)).toBeTruthy();
  });

  it('shows the evidence only when a parent opens the row', async () => {
    const api = {
      certification: vi.fn(async () => cert([control({
        id: 'teen-words-never-stored', title: 'A teenager\'s messages are never stored',
        evidence: 'The check "teen_bodies_are_never_stored" is present.',
      })])),
    } as unknown as Api;
    render(<CertificationPanel api={api} />);
    await waitFor(() => expect(screen.getByText(/never stored/i)).toBeTruthy());
    expect(screen.queryByText(/teen_bodies_are_never_stored/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /never stored/i }));
    await waitFor(() =>
      expect(screen.getByText(/teen_bodies_are_never_stored/)).toBeTruthy());
  });

  it('renders an absent control as not done, in the server\'s words', async () => {
    const api = {
      certification: vi.fn(async () => cert([control({
        id: 'independent-audit', title: 'An independent auditor has certified Chittu',
        status: 'absent', label: 'Not done',
        detail: 'Nobody outside the team has checked that claim.',
      })])),
    } as unknown as Api;
    const { container } = render(<CertificationPanel api={api} />);
    await waitFor(() => expect(screen.getByText('Not done')).toBeTruthy());
    expect(container.querySelector('.certrow--absent')).toBeTruthy();
    expect(screen.getByText(/1 not done/i)).toBeTruthy();
  });

  /** An unanswered question is not a pass. Same rule as the seal panel. */
  it('says it could not check rather than showing an empty pass', async () => {
    const api = {
      certification: vi.fn(async () => { throw new Error('down'); }),
    } as unknown as Api;
    render(<CertificationPanel api={api} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/couldn't check these just now/i)).toBeTruthy();
  });
});
