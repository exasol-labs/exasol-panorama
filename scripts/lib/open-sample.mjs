/**
 * Puts one of the synthetic relations on the canvas, for a probe that needs data
 * without a database in the room.
 *
 * Through the workspace rather than through the interface, and that is the point
 * rather than a convenience. There is no longer anything in the sidebar offering
 * these — somebody who opens Panorama has come to look at their own data — so a
 * probe that clicked its way in would be testing an affordance that no longer
 * exists. It asks the document to open a table, which is the same thing the
 * explorer, a followed key and an agent's `open_table` all end up doing.
 *
 * The relations themselves are in `apps/web/src/panorama/demo.ts`.
 */

/** Where the synthetic relations live. Nothing in the interface names it. */
export const SAMPLE_SCHEMA = 'PANORAMA_DEMO';

/**
 * Opens one and waits for it to settle.
 *
 * The wait is for the rows rather than for the box: opening resolves when the
 * table is in the document, and the first block of cells arrives after that. A
 * probe that measures pixels needs the cells.
 */
export const openSample = async (page, table, settle = 900) => {
  const opened = await page.evaluate(
    ([schema, name]) => globalThis.__panorama.openTable({ schema, table: name }),
    [SAMPLE_SCHEMA, table],
  );
  if (typeof opened !== 'string') {
    throw new Error(`could not open ${SAMPLE_SCHEMA}.${table}`);
  }
  await page.waitForTimeout(settle);
  return opened;
};
