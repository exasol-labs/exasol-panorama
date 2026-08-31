/**
 * The skills: what an agent can do here, and where the text of them comes from.
 *
 * The tool list says what may be called and the handshake says what this server
 * is for; neither says how the pieces go together, and an agent that has to work
 * that out by trying things spends its first several calls learning what a page
 * could have told it. So there are pages, and they are served over the protocol.
 *
 * Two of them, and the split is by *audience within a session* rather than by
 * subject. The first is read once, before anything is open, and is about the
 * whole interface. The second is read only when a chart is being written, is
 * three times the length, and is almost entirely about a library this server does
 * not otherwise mention. Folded into one page it would be paid for by every agent
 * that never writes an option; left out it would be rediscovered a refusal at a
 * time, which is what it was.
 *
 * Nothing here holds a copy of either. They are documents first — reviewed,
 * formatted and read by people like the rest of `docs/` — and the server reads
 * those files rather than constants compiled from them, so an edit to the
 * documentation *is* an edit to what agents are told. This file holds only what
 * the protocol needs to describe them, which does not change when the prose does.
 *
 * Nothing here touches a file system either: the pages are imported by the
 * browser as well, and the reading happens in the one place that knows it is
 * running on somebody's computer — the development-server plugin.
 */

/**
 * The tool that reads them out.
 *
 * A tool as well as a prompt and a resource, because a client that shows only
 * tools shows only tools — and a page an agent cannot reach is a page nobody
 * reads. First in the list, since it is what to call first.
 *
 * One tool for both pages rather than one each: the second is a chapter of the
 * first and is named by the first, so an agent arrives at it having been told
 * what it is for. A second entry in the tool list would be a second thing to
 * choose between before knowing that either is relevant.
 */
export const SKILL_TOOL = 'skill';

/** What the tool's `page` argument takes, and what it means. */
export type SkillPageId = 'interface' | 'charts';

/** One page: a document, and the several ways the protocol can offer it. */
export interface SkillPage {
  /** What `skill(page:)` asks for it by. */
  readonly id: SkillPageId;
  /** What a client listing prompts shows, and asks for it by. */
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  /** Where the same text can be read as a resource. */
  readonly uri: string;
  /** Where the document lives, relative to the repository root. */
  readonly path: string;
}

export const SKILL_PAGES: readonly SkillPage[] = Object.freeze([
  {
    id: 'interface',
    name: 'panorama',
    title: 'Driving Panorama, the spatial canvas',
    summary:
      'Everything this server can do and how the pieces fit: the boxes on the canvas, the command and history model, charts and their named data sets, what a picked mark means, cross-filtering, and the feedback that says whether a picture is right.',
    uri: 'panorama://skill',
    path: 'docs/AGENT-SKILL.md',
  },
  {
    id: 'charts',
    name: 'panorama-charts',
    title: 'Writing charts in Panorama',
    summary:
      "Writing an ECharts option through Panorama's seam: which series draw and which are inert, how the four kinds of data set reach an option, the handful of settings that are silently dropped, and how to compose a picture that survives the query changing.",
    uri: 'panorama://skill/charts',
    path: 'docs/AGENT-SKILL-CHARTS.md',
  },
]);

/** The page every door opens onto when nothing said which. */
export const DEFAULT_SKILL_PAGE = SKILL_PAGES[0] as SkillPage;

/**
 * The pages a server has in hand, by id.
 *
 * A record rather than a list because a build without its documents beside it has
 * *some* of them — and a page that could not be read should be missing rather
 * than empty. Absent altogether, the handshake claims no prompts and no
 * resources.
 */
export type SkillTexts = Readonly<Partial<Record<SkillPageId, string>>>;

/** The page asked for by each of the three names a client might use. */
export const skillPageById = (id: unknown): SkillPage | undefined =>
  SKILL_PAGES.find((page) => page.id === id);

export const skillPageByName = (name: unknown): SkillPage | undefined =>
  SKILL_PAGES.find((page) => page.name === name);

export const skillPageByUri = (uri: unknown): SkillPage | undefined =>
  SKILL_PAGES.find((page) => page.uri === uri);

/** The pages actually in hand, in the order they are listed. */
export const skillPagesIn = (texts: SkillTexts | undefined): readonly SkillPage[] =>
  texts === undefined ? [] : SKILL_PAGES.filter((page) => texts[page.id] !== undefined);

/**
 * The document, without the note that explains it to whoever opens the file.
 *
 * An HTML comment at the top says where the text is served and that it is the
 * source; that is for a reader of the repository and noise to a reader of the
 * skill, so it is dropped on the way out.
 */
export const skillText = (document: string): string =>
  document.replace(/^\s*<!--[\s\S]*?-->\s*/u, '');
