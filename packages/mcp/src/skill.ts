/**
 * The skill: what an agent can do here, and where the text of it comes from.
 *
 * The tool list says what may be called and the handshake says what this server
 * is for; neither says how the pieces go together, and an agent that has to work
 * that out by trying things spends its first several calls learning what a page
 * could have told it. So there is a page, and it is served over the protocol.
 *
 * The page is `docs/AGENT-SKILL.md` and nothing here holds a copy of it. It is a
 * document first — reviewed, formatted and read by people like the rest of
 * `docs/` — and the server reads that file rather than a constant compiled from
 * it, so an edit to the documentation *is* an edit to what agents are told. This
 * file holds only what the protocol needs to describe it, which does not change
 * when the prose does.
 *
 * Nothing here touches a file system: the page is imported by the browser as well,
 * and the reading happens in the one place that knows it is running on somebody's
 * computer — the development-server plugin.
 */

export const SKILL_NAME = 'panorama';

export const SKILL_TITLE = 'Driving Panorama, the spatial canvas';

export const SKILL_SUMMARY =
  'Everything this server can do and how the pieces fit: the boxes on the canvas, the command and history model, charts and their named data sets, what a picked mark means, cross-filtering, and the feedback that says whether a picture is right.';

/** Where the same text can be read as a resource. */
export const SKILL_URI = 'panorama://skill';

/** Where the document lives, relative to the repository root. */
export const SKILL_PATH = 'docs/AGENT-SKILL.md';

/**
 * The document, without the note that explains it to whoever opens the file.
 *
 * An HTML comment at the top says where the text is served and that it is the
 * source; that is for a reader of the repository and noise to a reader of the
 * skill, so it is dropped on the way out.
 */
export const skillText = (document: string): string =>
  document.replace(/^\s*<!--[\s\S]*?-->\s*/u, '');
