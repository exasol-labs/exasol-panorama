import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LinkedText } from '@panorama/ui';

const linkIn = (text: string): HTMLAnchorElement[] => {
  const { container } = render(<LinkedText text={text} />);
  return [...container.querySelectorAll('a')];
};

describe('LinkedText', () => {
  it('leaves text with no URL exactly as it is', () => {
    const { container } = render(<LinkedText text="Authentication failed" />);
    expect(container.textContent).toBe('Authentication failed');
    expect(container.querySelector('a')).toBeNull();
  });

  it('makes a URL clickable without changing the sentence around it', () => {
    const text = 'open https://localhost:8563 in a browser tab and accept the warning';
    const { container } = render(<LinkedText text={text} />);
    // The message still reads exactly as it did.
    expect(container.textContent).toBe(text);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://localhost:8563');
    expect(link.textContent).toBe('https://localhost:8563');
  });

  it('opens in a new tab, so the workspace is not navigated away from', () => {
    const [link] = linkIn('see https://example.test/help');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer');
  });

  it('leaves sentence punctuation out of the link', () => {
    for (const [text, href] of [
      ['open https://localhost:8563.', 'https://localhost:8563'],
      ['open https://localhost:8563, then reconnect', 'https://localhost:8563'],
      ['see (https://example.test/a)', 'https://example.test/a'],
      ['really? https://example.test/a?b=1', 'https://example.test/a?b=1'],
    ] as const) {
      const { container } = render(<LinkedText text={text} />);
      expect(container.querySelector('a')?.getAttribute('href')).toBe(href);
      // Nothing is lost from the sentence, punctuation included.
      expect(container.textContent).toBe(text);
    }
  });

  it('links every URL in a message', () => {
    const links = linkIn('try https://a.test or https://b.test first');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });

  it('links a URL at either end of the text', () => {
    expect(linkIn('https://a.test is the host')[0]?.getAttribute('href')).toBe('https://a.test');
    expect(linkIn('the host is https://a.test')[0]?.getAttribute('href')).toBe('https://a.test');
    expect(linkIn('https://a.test')[0]?.getAttribute('href')).toBe('https://a.test');
  });

  it('links nothing but http and https', () => {
    for (const text of [
      'run javascript:alert(1) now',
      'open file:///etc/passwd',
      'connect to wss://localhost:8563',
      'mail me at someone@example.test',
    ]) {
      const { container } = render(<LinkedText text={text} />);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe(text);
    }
  });

  it('makes the certificate advice one click away', () => {
    // The shape of the message this exists for. The driver owns the wording —
    // `unreachableMessage` in `@panorama/exasol`, whose own test pins it — and
    // this package only renders whatever string it is handed.
    const message =
      'Cannot reach wss://localhost:8563. If the database uses a self-signed ' +
      'certificate, open https://localhost:8563 in a browser tab and accept the ' +
      'warning first, then reconnect.';
    const { container } = render(<LinkedText text={message} />);
    expect(container.textContent).toBe(message);
    // The `wss://` the message opens with is not a link; the `https://` is.
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://localhost:8563');
  });
});
