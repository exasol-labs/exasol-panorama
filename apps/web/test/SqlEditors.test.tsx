import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EntityId } from '@panorama/core';
import { DERIVED_TABLE } from '@panorama/core';
import type { TableEntity } from '@panorama/core';
import { CameraController, previewEntity } from '@panorama/renderer';
import type { PanoramaRenderer } from '@panorama/renderer';
import { SqlEditors, splitSqlReferences } from '../src/panorama/SqlEditors.js';
import { createAppHarness, firstTableId } from './harness.js';

/**
 * The editor is real DOM over the canvas, so it is tested as DOM: typing,
 * shortcuts, and following the camera.
 */

interface Mounted {
  readonly harness: ReturnType<typeof createAppHarness>;
  readonly tableId: EntityId;
  readonly camera: CameraController;
  readonly errors: (string | null)[];
  frame(): Promise<void>;
}

/** Runs one animation frame's worth of the overlay's positioning loop. */
const mount = async (): Promise<Mounted> => {
  const harness = createAppHarness();
  await harness.workspace.connect({
    url: 'wss://x',
    credentials: { kind: 'token', token: 't' },
  });
  await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
  const { tableId } = await harness.workspace.openQuery(firstTableId(harness));

  const camera = new CameraController();
  camera.setViewport({ width: 1_000, height: 800 });
  camera.moveTo(0, 0);
  // Mirrors `PanoramaRenderer.drawnEntity`, so a test sees the same geometry the
  // canvas would draw — drag previews included.
  const rendererRef = {
    current: {
      camera,
      drawnEntity: (entity: TableEntity) =>
        previewEntity(
          entity,
          harness.workspace.core.session.drag,
          harness.workspace.core.session.pointer?.world ?? null,
          harness.workspace.core.constraints,
        ),
    } as unknown as PanoramaRenderer,
  };

  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

  const errors: (string | null)[] = [];
  render(
    <SqlEditors
      workspace={harness.workspace}
      rendererRef={rendererRef}
      onError={(message) => errors.push(message)}
    />,
  );

  const frame = async (): Promise<void> => {
    const pending = callbacks.splice(0, callbacks.length);
    await act(async () => {
      for (const callback of pending) callback(0);
      await Promise.resolve();
    });
  };
  // Two frames: the first discovers the box and renders its element, the
  // second is the earliest one that can position an element that now exists.
  await frame();
  await frame();
  return { harness, tableId, camera, errors, frame };
};

describe('the SQL editor overlay', () => {
  it('offers a field holding the statement the box starts with', async () => {
    const { harness, tableId } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    expect((field as HTMLTextAreaElement).value).toBe(harness.workspace.queryDraft(tableId));
  });

  it('records typing as a draft rather than a command', async () => {
    const { harness, tableId } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    const before = harness.workspace.core.history.commits.size;

    fireEvent.change(field, { target: { value: 'SELECT 1 FROM "PANORAMA_TEST"."SALES"' } });
    expect(harness.workspace.queryDraft(tableId)).toBe('SELECT 1 FROM "PANORAMA_TEST"."SALES"');
    expect(harness.workspace.core.history.commits.size).toBe(before);
  });

  it('runs the statement on the accelerator and turns the box into its result', async () => {
    const { harness, tableId, frame } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    fireEvent.change(field, { target: { value: 'SELECT 1 FROM "PANORAMA_TEST"."SALES"' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(harness.workspace.core.world.entities.get(tableId)).toMatchObject({ mode: 'result' });
    });
    // The editor takes itself away once the box is showing rows.
    await frame();
    expect(screen.queryByLabelText('SQL statement')).toBeNull();
  });

  it('runs the statement from the button too', async () => {
    const { harness, tableId } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(harness.workspace.core.world.entities.get(tableId)).toMatchObject({ mode: 'result' });
    });
  });

  it('reports a failed statement instead of swallowing it', async () => {
    const { harness, errors } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(errors.some((message) => message?.includes('Enter a statement') === true)).toBe(true);
    });
    expect(harness.workspace.editingQueryTables()).toHaveLength(1);
  });

  it('follows the box as the camera pans and zooms', async () => {
    const { camera, frame } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    // The positioned element, not the field's immediate parent: the field sits
    // inside a frame that also holds the colouring behind it.
    const box = field.closest<HTMLElement>('.pn-sql-editor');
    if (box === null) throw new Error('expected a positioned box');

    const first = box.style.transform;
    const firstWidth = box.style.width;
    camera.moveTo(200, 120);
    await frame();
    expect(box.style.transform).not.toBe(first);

    camera.setScale(2);
    await frame();
    // Twice the zoom, twice the width on screen.
    expect(Number.parseFloat(box.style.width)).toBeCloseTo(Number.parseFloat(firstWidth) * 2, 1);
  });

  it('keeps up with the box while it is being dragged', async () => {
    const { harness, tableId, camera, frame } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    // The positioned element, not the field's immediate parent: the field sits
    // inside a frame that also holds the colouring behind it.
    const box = field.closest<HTMLElement>('.pn-sql-editor');
    if (box === null) throw new Error('expected a positioned box');
    const before = box.style.transform;

    const entity = harness.workspace.core.world.entities.get(tableId);
    if (entity === undefined || entity.type !== 'table') throw new Error('expected the box');
    const start = entity.transform;

    // A drag is session state and is only committed on release, so the field has
    // to follow the *previewed* transform. Reading the committed one would pin
    // it in place for the whole drag and snap it over at the end.
    harness.workspace.core.dispatchSession({
      type: 'BeginDrag',
      drag: {
        kind: 'move-entity',
        entityId: tableId,
        pointerStart: { x: start.x, y: start.y },
        entityStart: { x: start.x, y: start.y, z: 0 },
      },
    });
    harness.workspace.core.dispatchSession({
      type: 'SetPointer',
      pointer: {
        world: { x: start.x + 120, y: start.y + 45, z: 0 },
        screenX: 0,
        screenY: 0,
      },
    });
    await frame();

    expect(box.style.transform).not.toBe(before);
    const moved = /translate\(([-\d.]+)px, ([-\d.]+)px\)/u.exec(box.style.transform);
    const held = /translate\(([-\d.]+)px, ([-\d.]+)px\)/u.exec(before);
    if (moved === null || held === null) throw new Error('expected a translate');
    // Exactly the drag delta at this zoom, not a fraction of it and not a frame late.
    expect(Number(moved[1]) - Number(held[1])).toBeCloseTo(120 * camera.scale, 6);
    expect(Number(moved[2]) - Number(held[2])).toBeCloseTo(45 * camera.scale, 6);
  });

  it('keeps up with the box while it is being resized', async () => {
    const { harness, tableId, camera, frame } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    // The positioned element, not the field's immediate parent: the field sits
    // inside a frame that also holds the colouring behind it.
    const box = field.closest<HTMLElement>('.pn-sql-editor');
    if (box === null) throw new Error('expected a positioned box');
    const entity = harness.workspace.core.world.entities.get(tableId);
    if (entity === undefined || entity.type !== 'table') throw new Error('expected the box');
    const start = entity.transform;
    const before = Number.parseFloat(box.style.width);

    harness.workspace.core.dispatchSession({
      type: 'BeginDrag',
      drag: {
        kind: 'resize-entity',
        entityId: tableId,
        handle: 'right',
        pointerStart: { x: start.x + start.width, y: start.y },
        entityStart: { x: start.x, y: start.y, z: 0 },
        widthStart: start.width,
        heightStart: start.height,
      },
    });
    harness.workspace.core.dispatchSession({
      type: 'SetPointer',
      pointer: {
        world: { x: start.x + start.width + 80, y: start.y, z: 0 },
        screenX: 0,
        screenY: 0,
      },
    });
    await frame();
    // A resize is previewed the same way a move is, so the field grows with it.
    expect(Number.parseFloat(box.style.width) - before).toBeCloseTo(80 * camera.scale, 6);
  });

  it('steps aside when the camera is too far out to type', async () => {
    const { camera, frame } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    // The positioned element, not the field's immediate parent: the field sits
    // inside a frame that also holds the colouring behind it.
    const box = field.closest<HTMLElement>('.pn-sql-editor');
    if (box === null) throw new Error('expected a positioned box');
    expect(box.style.visibility).toBe('visible');

    camera.setScale(0.2);
    await frame();
    expect(box.style.visibility).toBe('hidden');
  });

  it('goes back to the result on Escape once there is one', async () => {
    const { harness, tableId, frame } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(harness.workspace.hasQueryResult(tableId)).toBe(true);
    });

    harness.workspace.editQuery(tableId);
    await frame();
    fireEvent.keyDown(await screen.findByLabelText('SQL statement'), { key: 'Escape' });
    await waitFor(() => {
      expect(harness.workspace.core.world.entities.get(tableId)).toMatchObject({ mode: 'result' });
    });
    expect(field).toBeDefined();
  });

  it('ignores Escape while there is no result to go back to', async () => {
    const { harness, tableId } = await mount();
    fireEvent.keyDown(await screen.findByLabelText('SQL statement'), { key: 'Escape' });
    expect(harness.workspace.core.world.entities.get(tableId)).toMatchObject({ mode: 'editing' });
  });

  it('survives the box being closed under it', async () => {
    const { harness, tableId, frame } = await mount();
    await harness.workspace.closeTable(tableId);
    // The element is still mounted for one frame after the entity is gone.
    await expect(frame()).resolves.toBeUndefined();
    await frame();
    expect(screen.queryByLabelText('SQL statement')).toBeNull();
  });

  it('reports a thrown non-error as text rather than losing it', async () => {
    const { harness, errors } = await mount();
    // A rejection that is not an Error must still reach the user.
    vi.spyOn(harness.workspace, 'runQuery').mockRejectedValue('database is on fire');
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(errors).toContain('database is on fire');
    });
  });

  it('draws nothing at all when no box is being edited', async () => {
    const { harness, tableId, frame } = await mount();
    harness.workspace.core.dispatch({ type: 'SetTableMode', tableId, mode: 'result' });
    await frame();
    expect(screen.queryByLabelText('SQL statement')).toBeNull();
  });
});

describe('colouring the name a box calls its input by', () => {
  it('cuts a statement into the parts that are the name and the parts that are not', () => {
    expect(splitSqlReferences(`SELECT *\nFROM ${DERIVED_TABLE}\nWHERE X > 0`)).toEqual([
      { text: 'SELECT *\nFROM ', reference: false },
      { text: DERIVED_TABLE, reference: true },
      { text: '\nWHERE X > 0', reference: false },
    ]);
  });

  it('starts with the name when the statement does', () => {
    expect(splitSqlReferences(DERIVED_TABLE)).toEqual([{ text: DERIVED_TABLE, reference: true }]);
  });

  it('leaves a statement that does not mention it in one piece', () => {
    expect(splitSqlReferences('SELECT 1')).toEqual([{ text: 'SELECT 1', reference: false }]);
    expect(splitSqlReferences('')).toEqual([]);
  });

  it('marks it in the field, behind the text being typed', async () => {
    const { harness } = await mount();
    const field = await screen.findByLabelText('SQL statement');
    fireEvent.change(field, { target: { value: `SELECT *\nFROM ${DERIVED_TABLE}` } });

    const box = field.closest<HTMLElement>('.pn-sql-editor');
    const marks = box?.querySelectorAll('.pn-sql-reference') ?? [];
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe(DERIVED_TABLE);
    // The colouring is a copy of the same text, so it must say the same thing.
    expect(box?.querySelector('.pn-sql-backdrop')?.textContent).toBe(
      `SELECT *\nFROM ${DERIVED_TABLE}\n`,
    );
    expect(
      harness.workspace.queryDraft(harness.workspace.editingQueryTables()[0] as EntityId),
    ).toBe(`SELECT *\nFROM ${DERIVED_TABLE}`);
  });

  it('keeps the colouring under the text as the field scrolls', async () => {
    await mount();
    const field = await screen.findByLabelText('SQL statement');
    const backdrop = field
      .closest<HTMLElement>('.pn-sql-editor')
      ?.querySelector<HTMLElement>('.pn-sql-backdrop');
    if (backdrop === null || backdrop === undefined) throw new Error('expected a backdrop');

    field.scrollTop = 40;
    field.scrollLeft = 12;
    fireEvent.scroll(field);
    expect(backdrop.scrollTop).toBe(40);
    expect(backdrop.scrollLeft).toBe(12);
  });
});
