import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { UpdateNotice } from '../src/UpdateNotice.js';

/**
 * The whole interface of an update policy that never interrupts: one line, and
 * nothing to press. See `plans/panorama-live-updates-plan.md`.
 */
describe('saying a new version is ready', () => {
  it('names the version and what will happen to it', () => {
    const { container } = render(<UpdateNotice version="0.2.0" applies="on-quit" />);
    expect(container.textContent).toContain('Panorama 0.2.0 is ready');
    // States the outcome rather than asking for a decision: the shell installs it
    // while the window is closing, so there is nothing for anybody to agree to.
    expect(container.textContent).toContain('installed when you quit');
  });

  it('asks rather than promises where nothing can be installed for you', () => {
    const { container } = render(<UpdateNotice version="0.2.0" applies="on-reopen" />);
    expect(container.textContent).toContain('close and reopen');
    expect(container.textContent).not.toContain('when you quit');
  });

  /**
   * A deployment that would not say what to call itself is no reason to say
   * nothing: a number is more useful than "a new version", and "a new version" is
   * much more useful than silence.
   */
  it('says something useful when the version is not known', () => {
    const { container } = render(<UpdateNotice version={null} applies="on-reopen" />);
    expect(container.textContent).toContain('A new version is ready');
  });

  /**
   * `status`, not `alert`: an alert interrupts a screen reader mid-sentence,
   * which is the exact rudeness this notice is designed around.
   */
  it('is announced politely, or it has missed its own point', () => {
    const { getByRole } = render(<UpdateNotice version="0.2.0" applies="on-quit" />);
    expect(getByRole('status')).toBeDefined();
  });
});
