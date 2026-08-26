/**
 * Text with its URLs made clickable.
 *
 * Some messages exist to send the user somewhere. The one that matters here is
 * the self-signed-certificate notice: a browser will not let a page make an
 * exception for a `wss://` handshake, so the only way through is to visit the
 * host over `https://` and accept the warning there. Telling someone to open a
 * URL and then making them retype it is a needless step in the middle of an
 * instruction, so the URL in a message is a link.
 *
 * Messages are plain strings all the way from the driver — they cross the worker
 * boundary as `{ code, message }` — so the links are found in the text rather
 * than described alongside it. That keeps the protocol as narrow as it was and
 * works for any message that happens to name a URL.
 */

/**
 * Only `http` and `https` are recognised. Not a general linkifier: anything
 * else a scheme could name is not something a message should be able to make
 * one click away.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gu;

/**
 * Punctuation at the end of a match belongs to the sentence rather than to the
 * URL — `open https://host.` links the host, not the full stop.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;

export interface LinkedTextProps {
  readonly text: string;
}

export const LinkedText = ({ text }: LinkedTextProps): React.JSX.Element => {
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const href = match[0].replace(TRAILING_PUNCTUATION, '');
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      // A new tab, always: the certificate exception is accepted somewhere
      // else, and navigating this tab away would take the whole workspace with
      // it — every open table, and any statement being written.
      <a key={`${start}`} href={href} target="_blank" rel="noreferrer">
        {href}
      </a>,
    );
    cursor = start + href.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
};
