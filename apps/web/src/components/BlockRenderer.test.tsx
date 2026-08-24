/**
 * The renderer's safety obligations, tested as behaviour rather than as intent.
 *
 * The XSS tests deliberately assert on the DOM, not on the props: "we passed a
 * string to a text node" is a claim about our code, while "no <img> element
 * exists in the document" is a claim about what a browser did with it.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import type { Block } from '@chittu/contracts';
import { BlockRenderer } from './BlockRenderer';
import { EscalationLeak } from '../safety/render-guard';

const strict = true;

describe('BlockRenderer — injection', () => {
  it('renders model markup as inert text, never as a DOM node', () => {
    const { container } = render(
      <BlockRenderer strict={strict} blocks={[
        { kind: 'text', text: '<img src=x onerror="globalThis.__pwned=1">' },
      ]} />);

    expect(container.querySelector('img')).toBeNull();
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
    // ...and the child sees the literal characters, which is the honest outcome.
    expect(container.textContent).toContain('<img src=x onerror=');
  });

  it('does not execute a script tag in any block kind', () => {
    const nasty = '<script>globalThis.__ran = true</script>';
    const { container } = render(
      <BlockRenderer strict={strict} blocks={[
        { kind: 'text', text: nasty },
        { kind: 'fact', text: nasty },
        { kind: 'poem', text: nasty },
        { kind: 'quiz', text: nasty },
        { kind: 'code', text: nasty },
        { kind: 'steps', items: [nasty] },
        { kind: 'chips', chips: [nasty] },
      ]} />);

    expect(container.querySelector('script')).toBeNull();
    expect((globalThis as { __ran?: boolean }).__ran).toBeUndefined();
  });

  it('keeps a code snippet inside <pre><code> as text', () => {
    const { container } = render(
      <BlockRenderer strict={strict} blocks={[
        { kind: 'code', text: 'for i in range(3):\n  print("<b>hi</b>")' },
      ]} />);
    const code = container.querySelector('pre code');
    expect(code?.textContent).toContain('<b>hi</b>');
    expect(code?.querySelector('b')).toBeNull();
  });
});

describe('BlockRenderer — escalation tokens', () => {
  it('throws in dev so the server-side bug gets found', () => {
    // Observed for real: the 8B baseline answered an abuse disclosure with the
    // literal string "SPINE [CHIPS]" (llm-kit/evals/baseline-8b-35prompt-*).
    expect(() => render(
      <BlockRenderer strict={true} blocks={[{ kind: 'text', text: 'SPINE' }]} />))
      .toThrow(EscalationLeak);
  });

  it('in production drops the block and says something honest instead', () => {
    render(<BlockRenderer strict={false} blocks={[{ kind: 'text', text: 'CRISIS' }]} />);
    expect(screen.queryByText('CRISIS')).toBeNull();
    expect(screen.getByText(/something went wrong with that answer/i)).toBeTruthy();
  });

  it('keeps the good blocks when only one leaks', () => {
    render(<BlockRenderer strict={false} blocks={[
      { kind: 'text', text: 'Rainbows bend light!' },
      { kind: 'text', text: 'UNSAFE' },
    ]} />);
    expect(screen.getByText('Rainbows bend light!')).toBeTruthy();
    expect(screen.queryByText('UNSAFE')).toBeNull();
    // One good block survived, so the error line is NOT shown.
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
});

describe('BlockRenderer — control tokens', () => {
  it('strips a vendor\'s reasoning before it reaches the screen', () => {
    render(<BlockRenderer strict={strict} blocks={[
      { kind: 'text', text: '<think>should I say i love you?</think>Your family loves you.' },
    ]} />);
    expect(screen.getByText('Your family loves you.')).toBeTruthy();
    expect(screen.queryByText(/should I say/i)).toBeNull();
  });
});

describe('BlockRenderer — grammar drift', () => {
  it('renders an unknown block kind as literal text rather than swallowing it', () => {
    // Forced past the type system on purpose: this is what a server one version
    // ahead of the client actually sends.
    const drifted = { kind: 'hologram', text: 'from the future' } as unknown as Block;
    const { container } = render(<BlockRenderer strict={strict} blocks={[drifted]} />);
    expect(container.textContent).toContain('hologram');
  });
});

describe('BlockRenderer — chips', () => {
  it('renders real buttons and reports the tapped text', () => {
    const onChip = vi.fn();
    render(<BlockRenderer strict={strict} onChip={onChip}
      blocks={[{ kind: 'chips', chips: ['Tell me more', 'Why?'] }]} />);

    const b = screen.getByRole('button', { name: 'Tell me more' });
    fireEvent.click(b);
    expect(onChip).toHaveBeenCalledWith('Tell me more');
  });

  it('disables chips from an older message', () => {
    render(<BlockRenderer strict={strict} chipsEnabled={false}
      blocks={[{ kind: 'chips', chips: ['Stale'] }]} />);
    expect(screen.getByRole('button', { name: 'Stale' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('BlockRenderer — the ordinary case', () => {
  it('renders a full reply in order', () => {
    const { container } = render(<BlockRenderer strict={strict} blocks={[
      { kind: 'big', emoji: '🌈' },
      { kind: 'text', text: 'Rainbows happen when light bends through rain.' },
      { kind: 'steps', items: ['Light enters a raindrop', 'It bends', 'It splits'] },
      { kind: 'fact', text: 'You can never reach the end of one!' },
      { kind: 'chips', chips: ['Why is it curved?'] },
    ]} />);

    expect(container.querySelectorAll('.card--steps li')).toHaveLength(3);
    expect(screen.getByText('You can never reach the end of one!')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Why is it curved?' })).toBeTruthy();
  });

  it('hides the decorative emoji from screen readers', () => {
    const { container } = render(
      <BlockRenderer strict={strict} blocks={[{ kind: 'big', emoji: '🐦' }]} />);
    expect(container.querySelector('.bigmoji')?.getAttribute('aria-hidden')).toBe('true');
  });
});
