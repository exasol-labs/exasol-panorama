/**
 * Finds a table's halo buttons by feel rather than by arithmetic.
 *
 * The halo turns a corner: the buttons that act on the box run along the top,
 * the ones that make a new box run down the right edge, and close sits on the
 * corner between them. Their widths differ and each line grows as actions are
 * added, so a fixed pitch drifts silently the moment the halo changes — which is
 * exactly what it did once already. Hovering asks the halo where its buttons
 * are, which proves each one is hit-testable where it is drawn and keeps the
 * checks honest without copying the layout arithmetic into them.
 *
 * The sweep is measured in screen pixels, because that is what the halo is
 * measured in: its buttons are the same size however far the camera is.
 */

/** Matches the renderer's theme: button, gap and distance out from the table. */
const BUTTON = 22;
const GAP = 6;
const OFFSET = 8;

/** Screen point of the corner button's centre, from a table's world rect. */
export const haloCorner = (rect, toScreen) => {
  const topRight = toScreen({ x: rect.x + rect.width, y: rect.y });
  return { x: topRight.x + OFFSET + BUTTON / 2, y: topRight.y - OFFSET - BUTTON / 2 };
};

/**
 * Sweeps both lines of the halo and reports where each action turned out to be.
 *
 * `activateAt` is a world point on the table itself: the halo only exists while
 * the table is activated, so the pointer has to be on the box before it reaches
 * for a button.
 */
export const sweepHalo = async ({ page, rect, toScreen, activateAt, step = 4, wait = 35 }) => {
  const found = new Map();
  const hoveredAction = () =>
    page.evaluate(() => globalThis.__panorama.core.session.hoveredAction?.action ?? null);

  const start = toScreen(activateAt ?? { x: rect.x + 40, y: rect.y + 12 });
  await page.mouse.move(start.x, start.y);
  await page.waitForTimeout(200);

  const note = async (point) => {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(wait);
    const action = await hoveredAction();
    if (action !== null && !found.has(action)) found.set(action, point);
  };

  const corner = haloCorner(rect, toScreen);
  await note(corner);
  // Along the top, leftwards from the corner: far enough to pass three spelled-out
  // format buttons and the pencil beyond them.
  for (let offset = BUTTON / 2 + GAP; offset < 260; offset += step) {
    await note({ x: corner.x - offset, y: corner.y });
  }
  // Then down the right edge, from the corner. Every button in the column shares
  // its inner edge with the corner, so the corner's own centre line crosses all
  // of them however wide they are.
  for (let offset = BUTTON / 2 + GAP; offset < 130; offset += step) {
    await note({ x: corner.x, y: corner.y + offset });
  }
  return found;
};
