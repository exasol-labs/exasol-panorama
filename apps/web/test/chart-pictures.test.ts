import { describe, expect, it, vi } from 'vitest';
import type { ChartSpec, EntityId, SessionState, TableEntity } from '@panorama/core';
import { applySessionCommand, emptySession } from '@panorama/core';
import type { ChartData, ChartDrawList, ChartSurface } from '@panorama/chart';
import { ChartPictures, chartDataNote } from '../src/panorama/chart-pictures.js';
import { createAppHarness, firstTableId } from './harness.js';

/**
 * The picture half of a chart, on its own.
 *
 * Worth testing here rather than only through the workspace, because that is the
 * point of it being its own object: what a chart reduced to, what it drew and
 * what the pointer is doing to it needs no canvas, no placement and no document.
 */

const SPEC: ChartSpec = {
  type: 'bar',
  category: 'COUNTRY',
  values: ['REVENUE'],
  aggregate: 'sum',
};

const DATA: ChartData = {
  categories: ['Sweden', 'France'],
  values: ['Sweden', 'France'],
  series: [{ name: 'REVENUE', values: [10, 20] }],
  rows: 2,
  basis: 'exact',
};

const TYPOGRAPHY = {
  measureText: (text: string, size: number) => text.length * size,
  fontFamily: 'x',
};

const drawn = (mark?: { series: number; data: number }): ChartDrawList => ({
  polygons: [
    {
      corners: [0, 0, 10, 0, 10, 10, 0, 10],
      color: [0, 0, 1, 1],
      ...(mark === undefined ? {} : { mark }),
    },
  ],
  texts: [
    {
      x: 2,
      y: 2,
      width: 8,
      height: 6,
      text: 'in',
      align: 'left',
      fontSize: 6,
      color: [0, 0, 0, 1],
    },
  ],
});

interface Setup {
  pictures: ChartPictures;
  readonly surface: ChartSurface & { updates: number };
  session: SessionState;
  wanted: boolean;
  readonly changes: number[];
}

const setup = (options: { reduce?: () => Promise<ChartData | null> } = {}): Setup => {
  let updates = 0;
  const surface = {
    get updates() {
      return updates;
    },
    update: () => {
      updates += 1;
    },
    point: () => null,
    draw: () => drawn({ series: 0, data: 0 }),
    toSvg: () => '<svg/>',
    dispose: () => {},
  } as unknown as ChartSurface & { updates: number };
  // One object, handed to the closures below as well as to the test: a copy
  // would leave the test setting fields nothing reads.
  const state = {
    surface,
    session: emptySession(),
    wanted: true,
    changes: [] as number[],
  } as Setup as { -readonly [K in keyof Setup]: Setup[K] };
  state.pictures = new ChartPictures({
    reduce: options.reduce ?? (() => Promise.resolve(DATA)),
    surface,
    theme: () => ({
      background: [1, 1, 1, 1],
      text: [0, 0, 0, 1],
      axis: [0, 0, 0, 1],
      grid: [0, 0, 0, 0.1],
      series: [[0, 0, 1, 1]],
      fontSize: 11,
    }),
    session: () => state.session,
    stillWanted: () => state.wanted,
    onChange: () => state.changes.push(1),
  });
  return state as Setup;
};

describe('what a chart reduced to', () => {
  it('says nothing has been chosen when the specification cannot be drawn', async () => {
    const box = setup();
    await box.pictures.load('table:1' as EntityId, 'table:0' as EntityId, {
      ...SPEC,
      category: '',
    });
    expect(box.pictures.stateOf('table:1' as EntityId)).toEqual({ status: 'unset' });
  });

  it('reads the rows, and says when there were none', async () => {
    const box = setup();
    await box.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    expect(box.pictures.stateOf('table:1' as EntityId)).toEqual({ status: 'ready', data: DATA });
    const empty = setup({ reduce: () => Promise.resolve(null) });
    await empty.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    expect(empty.pictures.stateOf('table:1' as EntityId)).toEqual({ status: 'empty' });
  });

  it("reports a failure in the database's own words", async () => {
    const box = setup({ reduce: () => Promise.reject(new Error('no such column')) });
    await box.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    expect(box.pictures.stateOf('table:1' as EntityId)).toEqual({
      status: 'failed',
      error: 'no such column',
    });
    const odd = setup({ reduce: () => Promise.reject('a bare string') });
    await odd.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    expect(odd.pictures.stateOf('table:1' as EntityId)).toMatchObject({ error: 'a bare string' });
  });

  it('drops an answer that is no longer the question', async () => {
    // A control moved again while the last answer was in flight.
    const box = setup();
    box.wanted = false;
    await box.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    expect(box.pictures.stateOf('table:1' as EntityId)).toEqual({ status: 'loading' });
  });
});

describe('what a chart drew', () => {
  const laid = async (): Promise<Setup> => {
    const box = setup();
    await box.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    return box;
  };

  it('says what it is waiting for before there is anything to draw', () => {
    const box = setup();
    expect(box.pictures.view('table:1' as EntityId, SPEC, 100, 80, TYPOGRAPHY)).toMatchObject({
      note: 'Reading…',
      chart: { polygons: [], texts: [] },
    });
  });

  it('says why there is nothing, and marks a failure as a caveat', async () => {
    const failed = setup({ reduce: () => Promise.reject(new Error('gone')) });
    await failed.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    expect(failed.pictures.view('table:1' as EntityId, SPEC, 100, 80, TYPOGRAPHY)).toMatchObject({
      note: 'gone',
      caution: true,
    });
    const unset = setup();
    await unset.pictures.load('table:1' as EntityId, 'table:0' as EntityId, {
      ...SPEC,
      category: '',
    });
    expect(unset.pictures.view('table:1' as EntityId, SPEC, 100, 80, TYPOGRAPHY)?.note).toBe(
      'Choose a column to chart',
    );
    const empty = setup({ reduce: () => Promise.resolve(null) });
    await empty.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    expect(empty.pictures.view('table:1' as EntityId, SPEC, 100, 80, TYPOGRAPHY)?.note).toBe(
      'No rows to chart',
    );
  });

  it('lays out once for a specification, a size and a set of numbers', async () => {
    const box = await laid();
    const view = (spec: ChartSpec, width = 300): unknown =>
      box.pictures.view('table:1' as EntityId, spec, width, 200, TYPOGRAPHY);
    view(SPEC);
    expect(box.surface.updates).toBe(1);
    // The same specification object, so nothing is laid out again — this runs
    // once per chart per frame, and comparing by identity is the whole point.
    view(SPEC);
    view(SPEC);
    expect(box.surface.updates).toBe(1);
    // A different size, or a different specification, is a different picture.
    view(SPEC, 320);
    expect(box.surface.updates).toBe(2);
    view({ ...SPEC });
    expect(box.surface.updates).toBe(3);
  });

  it('applies the pointer and the selection, and remembers that it did', async () => {
    const box = await laid();
    const mark = { entityId: 'table:1' as EntityId, series: 0, data: 0 };
    const view = (): unknown =>
      box.pictures.view('table:1' as EntityId, SPEC, 300, 200, TYPOGRAPHY);
    const plain = (view() as { chart: ChartDrawList }).chart;
    expect(view()).toMatchObject({ chart: plain });

    box.session = applySessionCommand(box.session, { type: 'SetHoveredMark', target: mark });
    const hovered = (view() as { chart: ChartDrawList }).chart;
    expect(hovered).not.toBe(plain);
    // Nothing has crossed a boundary since, so the same geometry comes back.
    expect((view() as { chart: ChartDrawList }).chart).toBe(hovered);

    box.session = applySessionCommand(box.session, { type: 'SetSelectedMarks', targets: [mark] });
    expect((view() as { chart: ChartDrawList }).chart).not.toBe(hovered);
  });

  it('has no geometry, no figure and no mark before it has drawn', () => {
    const box = setup();
    const entity = { id: 'table:1', transform: { width: 400, height: 300 }, mode: 'result' };
    expect(box.pictures.geometry('table:1' as EntityId)).toBeNull();
    expect(box.pictures.figure(entity as unknown as TableEntity)).toBeNull();
    expect(box.pictures.markAt(entity as unknown as TableEntity, 10, 10)).toBeNull();
  });

  it('forgets a chart that has been closed', async () => {
    const box = await laid();
    box.pictures.view('table:1' as EntityId, SPEC, 300, 200, TYPOGRAPHY);
    expect(box.pictures.geometry('table:1' as EntityId)).not.toBeNull();
    box.pictures.forget('table:1' as EntityId);
    expect(box.pictures.stateOf('table:1' as EntityId)).toBeUndefined();
    expect(box.pictures.geometry('table:1' as EntityId)).toBeNull();
  });
});

describe('what the canvas made of it', () => {
  it('reports the box, what it covers, and any label outside it', async () => {
    const box = setup();
    await box.pictures.load('table:1' as EntityId, 'table:0' as EntityId, SPEC);
    box.pictures.view('table:1' as EntityId, SPEC, 8, 8, TYPOGRAPHY);
    const geometry = box.pictures.geometry('table:1' as EntityId);
    expect(geometry).toMatchObject({ width: 8, height: 8, polygons: 1, texts: 1 });
    expect(geometry?.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    // The label runs past a box this small, and is named rather than counted.
    expect(geometry?.clipped).toEqual(['in']);
  });

  it('says what a picture cannot say about itself', () => {
    expect(chartDataNote(DATA)).toBe('2 rows');
    expect(chartDataNote({ ...DATA, basis: 'sampled' })).toBe('first 2 rows');
    expect(chartDataNote({ ...DATA, gathered: 1 })).toBe('2 rows · 1 more category not shown');
    expect(chartDataNote({ ...DATA, gathered: 4 })).toBe('2 rows · 4 more categories not shown');
  });
});

describe('the picture through the workspace', () => {
  it('is the same object the canvas asks for, and it points at marks', async () => {
    const harness = createAppHarness({
      chartSurface: {
        update: () => {},
        point: () => null,
        draw: () => drawn({ series: 0, data: 1 }),
        toSvg: () => '<svg/>',
        dispose: () => {},
      },
    });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const { tableId: chartId } = await harness.workspace.openChart(firstTableId(harness));
    harness.workspace.setChartDraft(chartId, SPEC);
    await harness.drive(Promise.resolve());
    const entity = harness.workspace.core.world.entities.get(chartId) as TableEntity;
    harness.workspace.chartFor(entity, 300, 200, TYPOGRAPHY);
    // Through the box's own coordinates: the picture starts below the title bar.
    expect(harness.workspace.chartMarkAt(chartId, 4, 4)).toBeNull();
    expect(harness.workspace.chartMarkAt('table:nope' as EntityId, 4, 4)).toBeNull();
  });
});
