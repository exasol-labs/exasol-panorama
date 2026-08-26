import { chromium } from 'playwright';
import { haloCorner, sweepHalo } from './lib/halo-sweep.mjs';
import { connectorMidpoint } from './lib/connector-midpoint.mjs';

/**
 * Verifies the SQL halo button and the query editor in a real browser.
 *
 * There is no database here, so the *sample* tables must show the SQL button
 * greyed out — that is the honest user-facing path and it is checked first. The
 * editor box itself is then created directly through the workspace, so its
 * rendering and the DOM overlay that sits on it can be seen; running a
 * statement needs an engine and is covered by the test suite instead.
 */

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[console] ${m.text()}`);
});

const URL_UNDER_TEST = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';
await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'Hide' }).click();
await page.locator('[aria-label="Sample tables"] button:has-text("SAMPLE_100")').first().click();
await page.waitForTimeout(900);

const box = await page.locator('.pn-canvas').boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

/** Screen-to-world mapping, derived from live pointer state rather than assumed. */
const probe = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const pointer = globalThis.__panorama.core.session.pointer;
    return pointer === null ? null : { x: pointer.world.x, y: pointer.world.y };
  });
};
/**
 * Re-derives the mapping from live pointer state.
 *
 * Sampled again whenever it matters rather than once at the start: the camera
 * moves during this run — a box is created, selected and dragged — and a mapping
 * taken before that silently sends every later point to the wrong place. Which is
 * what it did: the halo checks below were reading `null` for want of a remap.
 */
let scale = 1;
let toScreen = (world) => world;
const remap = async () => {
  const worldA = await probe(centre.x, centre.y);
  const worldB = await probe(centre.x + 100, centre.y + 100);
  scale = 100 / (worldB.x - worldA.x);
  toScreen = (world) => ({
    x: centre.x + (world.x - worldA.x) * scale,
    y: centre.y + (world.y - worldA.y) * scale,
  });
  return worldA;
};
await remap();

const sampleId = await page.evaluate(() => globalThis.__panorama.core.world.order[0]);

// 1. A sample table reports SQL as unavailable, and says so under the pointer.
const disabled = await page.evaluate(
  (id) => globalThis.__panorama.disabledActionsFor(id),
  sampleId,
);

const buttonWorld = await page.evaluate((id) => {
  const entity = globalThis.__panorama.core.world.entities.get(id);
  // The SQL button is the left of the two, so two button widths from the edge.
  return { x: entity.transform.x + entity.transform.width - 33, y: entity.transform.y - 19 };
}, sampleId);
await page.mouse.move(centre.x, centre.y);
await page.waitForTimeout(150);
const buttonScreen = toScreen(buttonWorld);
await page.mouse.move(buttonScreen.x, buttonScreen.y);
await page.waitForTimeout(250);
const cursor = await page.evaluate(() => document.querySelector('.pn-canvas').style.cursor);
const hoveredAction = await page.evaluate(() => globalThis.__panorama.core.session.hoveredAction);
await page.screenshot({ path: 'scripts/shots/sql-disabled.png' });

// Clicking it must do nothing at all.
const tablesBefore = await page.evaluate(() => globalThis.__panorama.core.world.order.length);
await page.mouse.click(buttonScreen.x, buttonScreen.y);
await page.waitForTimeout(400);
const tablesAfter = await page.evaluate(() => globalThis.__panorama.core.world.order.length);

// 2. An editor box, created directly, renders and carries a live textarea.
const editorId = await page.evaluate(() => {
  const workspace = globalThis.__panorama;
  const base = workspace.core.world.entities.get(workspace.core.world.order[0]);
  // Built as a literal rather than through `openQuery`, which rightly refuses a
  // sample table. The shape is deliberately spelled out: if the entity model
  // changes, this check fails loudly instead of drifting.
  const entity = {
    id: workspace.core.ids.entity('table'),
    type: 'table',
    source: {
      kind: 'query',
      connectionId: 'connection:demo',
      sql: 'SELECT COUNTRY, SUM(REVENUE) AS TOTAL\nFROM "PANORAMA_DEMO"."SAMPLE_100"\nGROUP BY COUNTRY',
      label: 'PANORAMA_DEMO.SAMPLE_100 · SQL',
    },
    mode: 'editing',
    // Beside the table, measured from the table itself rather than from the
    // camera: where a table lands is the workspace's business and has changed
    // before, and a box overlapping it would put this box's halo band inside the
    // table's own bounds — where picking rightly prefers the table, and every
    // halo check below would quietly find nothing.
    transform: {
      x: base.transform.x + base.transform.width + 60,
      y: base.transform.y + 40,
      z: 0,
      width: 330,
      height: 175,
    },
    columns: [],
    view: { rowHeight: 24, headerHeight: 72, horizontalOffset: 0 },
  };
  const created = workspace.core.dispatch({ type: 'CreateTableEntity', entity });
  if (!created.ok) throw new Error(created.error.message);
  const bound = workspace.core.dispatch({
    type: 'CreateBinding',
    binding: {
      id: workspace.core.ids.binding(),
      kind: 'connector',
      fromId: base.id,
      toId: entity.id,
      from: { mode: 'auto' },
      to: { mode: 'auto' },
      directed: true,
      label:
        'SELECT COUNTRY, SUM(REVENUE) AS TOTAL FROM "PANORAMA_DEMO"."SAMPLE_100" GROUP BY COUNTRY',
      meta: { kind: 'query' },
    },
  });
  if (!bound.ok) throw new Error(bound.error.message);
  globalThis.__panoramaEditorId = entity.id;
  return entity.id;
});
await page.waitForTimeout(700);

/**
 * Dragging the box by its title bar must carry the field with it, frame for
 * frame. The field is DOM and the box is drawn by the GPU, so this measures the
 * gap between them at each step of a real drag rather than trusting that they
 * agree.
 */
const dragTrace = await (async () => {
  const rect0 = await page.evaluate(
    (id) => globalThis.__panorama.core.world.entities.get(id).transform,
    editorId,
  );
  const grip = toScreen({ x: rect0.x + rect0.width / 2, y: rect0.y + 12 });
  const worst = { gap: 0, moved: 0 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(grip.x + step * 14, grip.y + step * 9);
    await page.waitForTimeout(70);
    const drawn = await page.evaluate((id) => {
      const core = globalThis.__panorama.core;
      const entity = core.world.entities.get(id);
      const drag = core.session.drag;
      const pointer = core.session.pointer?.world ?? null;
      // The transform the canvas is drawing this frame.
      if (drag === null || pointer === null || drag.entityId !== id) return entity.transform;
      return {
        ...entity.transform,
        x: drag.entityStart.x + (pointer.x - drag.pointerStart.x),
        y: drag.entityStart.y + (pointer.y - drag.pointerStart.y),
      };
    }, editorId);
    const expectedTop = toScreen({ x: drawn.x, y: drawn.y + 26 });
    const actual = await page.locator('.pn-sql-editor').boundingBox();
    // The container's own top-left, so an exact match is expected.
    const gap = Math.max(Math.abs(actual.x - expectedTop.x), Math.abs(actual.y - expectedTop.y));
    worst.gap = Math.max(worst.gap, gap);
    worst.moved = Math.abs(actual.x - toScreen({ x: rect0.x, y: rect0.y }).x);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
  // Back where it started. The drag has been measured, and leaving the box on
  // top of the sample table would put its halo band inside that table's own
  // bounds — where picking rightly prefers the table, so every halo check below
  // would quietly find nothing.
  await page.evaluate(
    ({ id, to }) => {
      const applied = globalThis.__panorama.core.dispatch({
        type: 'MoveEntities',
        ids: [id],
        position: { x: to.x, y: to.y, z: 0 },
      });
      if (!applied.ok) throw new Error(applied.error.message);
    },
    { id: editorId, to: { x: rect0.x, y: rect0.y } },
  );
  await page.waitForTimeout(200);
  return worst;
})();

// The cancel button is inert during a first edit: there is no result behind the
// editor to go back to.
const firstEditDisabled = await page.evaluate(
  (id) => globalThis.__panorama.disabledActionsFor(id),
  editorId,
);
const editorRect = await page.evaluate(
  (id) => globalThis.__panorama.core.world.entities.get(id).transform,
  editorId,
);
const cancelPoint = toScreen({
  x: editorRect.x + editorRect.width - 11 - 2 * 28,
  y: editorRect.y - 19,
});
await page.mouse.move(cancelPoint.x, cancelPoint.y);
await page.waitForTimeout(250);
const cancelCursorWhileFirstEdit = await page.evaluate(
  () => document.querySelector('.pn-canvas').style.cursor,
);
await page.screenshot({
  path: 'scripts/shots/cancel-disabled.png',
  clip: {
    x: Math.max(0, Math.min(1300, cancelPoint.x - 40)),
    y: Math.max(0, Math.min(850, cancelPoint.y - 16)),
    width: 190,
    height: 70,
  },
});
await page.mouse.click(cancelPoint.x, cancelPoint.y);
await page.waitForTimeout(300);
const modeAfterDisabledClick = await page.evaluate(
  (id) => globalThis.__panorama.core.world.entities.get(id).mode,
  editorId,
);

const field = page.locator('textarea[aria-label="SQL statement"]');
const fieldCount = await field.count();
const fieldBox = fieldCount > 0 ? await field.boundingBox() : null;
const editorWorld = await page.evaluate(
  (id) => globalThis.__panorama.core.world.entities.get(id).transform,
  editorId,
);

// The overlay must sit on the box it belongs to, not somewhere else on screen.
const expected = toScreen({ x: editorWorld.x, y: editorWorld.y + 26 });
const offset =
  fieldBox === null
    ? null
    : { dx: Math.round(fieldBox.x - expected.x), dy: Math.round(fieldBox.y - expected.y) };

// Typing must reach the draft, and must not reach the canvas as a shortcut.
await field.click();
await page.keyboard.press('End');
await page.keyboard.type(' ORDER BY 2 DESC');
await page.waitForTimeout(200);
const draft = await page.evaluate((id) => globalThis.__panorama.queryDraft(id), editorId);
const commitsBefore = await page.evaluate(() => globalThis.__panorama.core.history.commits.size);
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
const commitsAfter = await page.evaluate(() => globalThis.__panorama.core.history.commits.size);
await page.screenshot({ path: 'scripts/shots/sql-editor.png' });

// A close-up of the box, to check the title bar the renderer draws above the
// editable field.
if (fieldBox !== null) {
  await page.screenshot({
    path: 'scripts/shots/sql-editor-title.png',
    clip: (() => {
      const x = Math.max(0, Math.min(1399, fieldBox.x - 20));
      const y = Math.max(0, Math.min(899, fieldBox.y - 60));
      return {
        x,
        y,
        width: Math.max(1, Math.min(1400 - x, fieldBox.width + 40)),
        height: Math.max(1, Math.min(900 - y, 130)),
      };
    })(),
  });
}

// The line's marker must read as SQL, not as a foreign key. Hover it to see the
// statement it stands for.
const ends = await page.evaluate((id) => {
  const core = globalThis.__panorama.core;
  const binding = [...core.world.bindings.values()].find((b) => b.toId === id);
  return {
    from: core.world.entities.get(binding.fromId).transform,
    to: core.world.entities.get(id).transform,
  };
}, editorId);
const markerScreen = toScreen(connectorMidpoint(ends.from, ends.to));
await page.mouse.move(markerScreen.x, markerScreen.y);
await page.waitForTimeout(350);
const revealed = await page.evaluate(() => {
  const session = globalThis.__panorama.core.session;
  return session.hoveredBinding ?? null;
});
await page.screenshot({ path: 'scripts/shots/sql-marker.png' });

// 3. As a derived table showing a result: a tinted title bar, and a halo with an
// edit button the ordinary tables do not have.
await page.evaluate((id) => {
  const core = globalThis.__panorama.core;
  const applied = core.dispatch({ type: 'SetTableMode', tableId: id, mode: 'result' });
  if (!applied.ok) throw new Error(applied.error.message);
}, editorId);
await page.waitForTimeout(400);

await remap();
const derivedRect = await page.evaluate(
  (id) => globalThis.__panorama.core.world.entities.get(id).transform,
  editorId,
);
const titleCentre = toScreen({ x: derivedRect.x + derivedRect.width / 2, y: derivedRect.y + 12 });
// Away from both tables first: the tint has to read as "derived" on its own,
// not only when the box happens to be under the pointer.
await page.mouse.move(centre.x - 480, centre.y + 380);
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/shots/derived-table.png' });
await page.mouse.move(titleCentre.x, titleCentre.y);
await page.waitForTimeout(300);

// Both lines of the halo, with the corner between them: the pencil and the
// export button along the top, the chart and the query button down the side.
const cornerPoint = haloCorner(derivedRect, toScreen);
await page.screenshot({
  path: 'scripts/shots/derived-halo.png',
  clip: {
    x: Math.max(0, Math.min(1180, cornerPoint.x - 180)),
    y: Math.max(0, Math.min(730, cornerPoint.y - 24)),
    width: 220,
    height: 120,
  },
});

const haloButtons = await sweepHalo({ page, rect: derivedRect, toScreen });
const buttonFor = (action) => ({
  action: haloButtons.has(action) ? action : null,
  point: haloButtons.get(action) ?? null,
});
const closeButton = buttonFor('close');
const sqlButton = buttonFor('sql');
const editButton = buttonFor('edit');

// The SQL button derives a further table rather than toggling this one.
const beforeDerive = await page.evaluate(() => globalThis.__panorama.core.world.order.length);
if (sqlButton.point === null) throw new Error('the halo had no SQL button to press');
await page.mouse.click(sqlButton.point.x, sqlButton.point.y);
await page.waitForTimeout(600);
const afterDerive = await page.evaluate(
  (id) => ({
    tables: globalThis.__panorama.core.world.order.length,
    sourceStillResult: globalThis.__panorama.core.world.entities.get(id)?.mode,
  }),
  editorId,
);

/**
 * The box just derived refines the one it came from, so its editor must show one
 * short line naming its input rather than the statement it is built on wrapped
 * in parentheses — and the composed statement, which is what would actually be
 * sent, must put the two levels back together.
 */
const chained = await page.evaluate((sourceId) => {
  const workspace = globalThis.__panorama;
  const derived = [...workspace.core.world.entities.values()].find(
    (entity) => entity.source?.derivedFrom === sourceId,
  );
  if (derived === undefined) return null;
  return {
    id: derived.id,
    draft: workspace.queryDraft(derived.id),
    composed: workspace.composedQuery(derived.id),
  };
}, editorId);

// The new box lands to the right of the one it refines, which is off the edge of
// the view here — so pan across before looking at it.
await page.mouse.move(900, 800);
await page.mouse.down();
await page.mouse.move(520, 800, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(400);
await remap();

// The name is coloured in the field the user types into. That field is DOM and
// can be read; the box drawn underneath it is pixels, so the screenshot is what
// says whether the GPU coloured it too.
const highlighted = await page.evaluate(() => ({
  marks: [...document.querySelectorAll('.pn-sql-reference')].map((node) => node.textContent),
  backdrop: document.querySelector('.pn-sql-backdrop')?.textContent ?? null,
}));
/**
 * The same box with the DOM overlay taken away: what XR and a screenshot see.
 * The colouring has to be there too, and it comes from the draw list rather than
 * from CSS, so this is the only way to look at it.
 */
const drawnShot = async () => {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.pn-sql-editor')) {
      node.style.display = 'none';
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'scripts/shots/sql-derived-drawn.png' });
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.pn-sql-editor')) {
      node.style.display = '';
    }
  });
  await page.waitForTimeout(200);
};

const chainedField = page.locator('textarea[aria-label="SQL statement"]').last();
const chainedBox = (await chainedField.count()) > 0 ? await chainedField.boundingBox() : null;
if (chainedBox !== null) {
  await drawnShot();
  await page.screenshot({
    path: 'scripts/shots/sql-derived-table.png',
    clip: {
      x: Math.max(0, chainedBox.x - 30),
      y: Math.max(0, chainedBox.y - 50),
      width: Math.min(1400 - Math.max(0, chainedBox.x - 30), chainedBox.width + 60),
      height: Math.min(900 - Math.max(0, chainedBox.y - 50), chainedBox.height + 100),
    },
  });
}

/**
 * The edit slot, now that the box shows a result: live, and it opens the
 * statement. Pressing it *back* needs a result the box actually produced, which
 * needs a database — so that direction is covered by the test suite, and what is
 * checked here is that the button correctly reports having nothing to return to.
 */
const enabledOnAResult = await page.evaluate(
  (id) => globalThis.__panorama.disabledActionsFor(id),
  editorId,
);
await page.mouse.click(editButton.point.x, editButton.point.y);
await page.waitForTimeout(400);
const afterPressingEdit = await page.evaluate(
  (id) => ({
    mode: globalThis.__panorama.core.world.entities.get(id).mode,
    disabled: globalThis.__panorama.disabledActionsFor(id),
  }),
  editorId,
);

/**
 * The editor steps aside when the camera is too far out to type in it. A plain
 * wheel scrolls the canvas; zooming needs the modifier, as it does in every
 * other map.
 */
await page.mouse.move(centre.x, centre.y);
await page.keyboard.down('Control');
for (let step = 0; step < 14; step += 1) await page.mouse.wheel(0, 240);
await page.keyboard.up('Control');
await page.waitForTimeout(500);
const hiddenWhenFar = await page.evaluate(() => {
  const element = document.querySelector('.pn-sql-editor');
  return element === null ? null : element.style.visibility;
});
await page.screenshot({ path: 'scripts/shots/sql-editor-far.png' });

console.log(
  JSON.stringify(
    {
      sampleDisabledActions: disabled,
      disabledCursor: cursor,
      hoveredActionWhileDisabled: hoveredAction,
      clickOnDisabledOpenedNothing: tablesBefore === tablesAfter,
      editorFieldPresent: fieldCount === 1,
      overlayOffsetFromBox: offset,

      overlayWidthMatchesBox:
        fieldBox === null ? null : Math.round(fieldBox.width) <= Math.round(330 * scale),
      draftEndsWithTypedText: draft?.endsWith(' ORDER BY 2 DESC'),
      undoInFieldLeftHistoryAlone: commitsBefore === commitsAfter,
      markerRevealedOnHover: revealed !== null,
      dragFollowedWithinPixels: Math.round(dragTrace.gap),
      dragActuallyMovedTheField: Math.round(dragTrace.moved) > 40,
      firstEditDisabledActions: firstEditDisabled,
      cancelCursorWhileFirstEdit,
      modeAfterClickingDisabledCancel: modeAfterDisabledClick,
      haloButtonsFound: [...haloButtons.keys()],
      haloOffersCloseSqlAndEdit: [closeButton.action, sqlButton.action, editButton.action],
      sqlDerivedANewTable: afterDerive.tables === beforeDerive + 1,
      chainedBoxDraft: chained?.draft ?? null,
      chainedBoxComposed: chained?.composed ?? null,
      referencesHighlighted: highlighted.marks,
      sourceStayedOnItsResult: afterDerive.sourceStillResult,
      editEnabledOnAResult: enabledOnAResult,
      modeAfterPressingEdit: afterPressingEdit.mode,
      // Nothing was ever run here, so there is still nothing to go back to.
      disabledAgainWithNoResultBehind: afterPressingEdit.disabled,
      visibilityWhenZoomedOut: hiddenWhenFar,
      problems,
    },
    null,
    2,
  ),
);
await browser.close();
