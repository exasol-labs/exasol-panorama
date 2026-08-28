import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { isTableEntity } from '@panorama/core';
import type { FrameStats, PanoramaRenderer } from '@panorama/renderer';
import { PanoramaCanvas } from '../src/panorama/PanoramaCanvas.js';
import { createAppHarness, firstTableId } from './harness.js';

/**
 * The canvas runs against the headless engine, which exercises the whole
 * wiring — engine, renderer, interaction, event plumbing — without a GPU.
 */

/** The most recent observer's callback, so a test can drive a resize. */
let observed: (() => void) | null = null;

class TestResizeObserver {
  constructor(private readonly callback: () => void) {
    observed = callback;
  }
  observe(): void {
    this.callback();
  }
  disconnect(): void {}
  unobserve(): void {}
}

/** The size `getBoundingClientRect` reports, which a resize test changes. */
let laidOutAs = { width: 1_000, height: 800 };

/**
 * The listeners a density media query is holding, so a test can move the window
 * onto another display.
 *
 * jsdom has no `matchMedia` at all, so without this the canvas never hears about
 * a change of display and the code that answers one is never run.
 */
let densityListeners: Array<() => void> = [];

/** Moves the window to a display of a different density, and says so. */
const moveToDisplay = (ratio: number): void => {
  Object.defineProperty(globalThis, 'devicePixelRatio', { value: ratio, configurable: true });
  // A copy, because each listener re-arms by replacing itself.
  for (const listener of [...densityListeners]) listener();
};

/** jsdom has no 2D context; the glyph atlas only needs a permissive stub. */
const stubContext = (): unknown => {
  const state: Record<string, unknown> = {
    measureText: (text: string) => ({
      width: text.length * 6,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 6,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    canvas: null,
  };
  return new Proxy(state, {
    get: (target, property) =>
      property in target ? target[property as string] : (): undefined => undefined,
    set: (target, property, value) => {
      target[property as string] = value;
      return true;
    },
  });
};

const withCanvasEnvironment = (): void => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const prototype = globalThis.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  prototype['setPointerCapture'] = (): void => {};
  prototype['releasePointerCapture'] = (): void => {};
  prototype['hasPointerCapture'] = (): boolean => true;
  prototype['getContext'] = stubContext;
  laidOutAs = { width: 1_000, height: 800 };
  // Both the canvas and the div that hosts it: jsdom has no layout, and the canvas
  // is now sized from its host — which is the authority in a browser too, and the
  // only one that has a rectangle before the canvas has been inserted.
  const rect = (): DOMRect =>
    ({
      left: 0,
      top: 0,
      width: laidOutAs.width,
      height: laidOutAs.height,
      right: laidOutAs.width,
      bottom: laidOutAs.height,
      x: 0,
      y: 0,
    }) as DOMRect;
  prototype['getBoundingClientRect'] = rect;
  densityListeners = [];
  Object.defineProperty(globalThis, 'devicePixelRatio', { value: 1, configurable: true });
  (globalThis as unknown as Record<string, unknown>)['matchMedia'] = (query: string) => ({
    media: query,
    matches: true,
    addEventListener: (_: string, listener: () => void): void => {
      densityListeners.push(listener);
    },
    removeEventListener: (_: string, listener: () => void): void => {
      densityListeners = densityListeners.filter((one) => one !== listener);
    },
  });
  (globalThis.HTMLDivElement.prototype as unknown as Record<string, unknown>)[
    'getBoundingClientRect'
  ] = rect;
};

const mount = async (): Promise<{
  harness: ReturnType<typeof createAppHarness>;
  canvas: HTMLCanvasElement;
  statsRef: { current: FrameStats | null };
  unmount: () => void;
}> => {
  withCanvasEnvironment();
  const harness = createAppHarness();
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });

  const statsRef: { current: FrameStats | null } = { current: null };
  const ready = vi.fn();
  const view = render(
    <PanoramaCanvas
      workspace={harness.workspace}
      statsRef={statsRef}
      onReady={ready}
      engineOptions={{ headless: true }}
    />,
  );
  await waitFor(() => expect(ready).toHaveBeenCalled());
  const canvas = view.container.querySelector('canvas');
  if (canvas === null) throw new Error('expected a canvas');
  return { harness, canvas, statsRef, unmount: view.unmount };
};

describe('PanoramaCanvas', () => {
  /**
   * Everything that was ever visible during a resize came from the drawing buffer
   * being reallocated while the window was being dragged. Allocating a buffer
   * empties it, and nothing refills it until something draws, so the compositor
   * gets a chance to see a canvas with nothing in it; and a buffer the size of a
   * window is slow enough to reallocate that on macOS the web process misses the
   * window server's deadline and the last frame is shown scaled instead.
   *
   * So the buffer is not reallocated when the window is resized. It is made as
   * large as the display could ever need, once, and the window clips it: a resize
   * changes how much of the picture is on screen and nothing whatever about the
   * picture. `viewport` below is what is drawn, `visible` is what the window
   * shows, and the test of the whole design is that dragging a window smaller
   * leaves the first completely untouched.
   */
  it('clips the canvas to the window rather than resizing it', async () => {
    withCanvasEnvironment();
    const harness = createAppHarness();
    const statsRef: { current: FrameStats | null } = { current: null };
    let ready: PanoramaRenderer | null = null;
    let framesWhenReady = -1;
    const view = render(
      <PanoramaCanvas
        workspace={harness.workspace}
        statsRef={statsRef}
        onReady={(renderer) => {
          ready = renderer;
          framesWhenReady = statsRef.current?.frames ?? 0;
        }}
        engineOptions={{ headless: true }}
      />,
    );
    await waitFor(() => expect(ready).not.toBeNull());
    const renderer = ready as unknown as PanoramaRenderer;

    // Sized and drawn before it was reported ready, which is to say in the task
    // that created it and before it was put into the document. The first
    // composite that includes the canvas already has a picture in it.
    expect(framesWhenReady).toBeGreaterThan(0);
    // Drawn to cover the display or the host, whichever is larger. jsdom reports
    // no display at all, so here that is the host — and the grow path below is
    // what a real browser takes once, at startup, and then never again.
    expect(renderer.camera.viewport).toEqual({ width: 1_000, height: 800 });
    expect(renderer.camera.visible).toEqual({ width: 1_000, height: 800 });

    // A window dragged past what has been allocated grows it, once.
    laidOutAs = { width: 1_200, height: 900 };
    act(() => observed?.());
    expect(renderer.camera.viewport).toEqual({ width: 1_200, height: 900 });
    expect(renderer.camera.visible).toEqual({ width: 1_200, height: 900 });

    // And then dragged smaller — repeatedly, as a drag arrives. This is the case
    // that used to flicker, and now nothing is reallocated at all: what is drawn
    // does not change, and the window simply shows less of it. Each step still
    // draws, so the strip a later step uncovers is current rather than stale.
    let drawn = statsRef.current?.frames ?? 0;
    for (const size of [
      { width: 1_100, height: 850 },
      { width: 1_000, height: 780 },
      { width: 980, height: 700 },
    ]) {
      laidOutAs = size;
      act(() => observed?.());
      expect(renderer.camera.viewport).toEqual({ width: 1_200, height: 900 });
      expect(renderer.camera.visible).toEqual(size);
      expect(statsRef.current?.frames).toBe(++drawn);
    }

    // An observer firing on an unchanged layout costs nothing at all.
    act(() => observed?.());
    expect(statsRef.current?.frames).toBe(drawn);

    view.unmount();
  });

  /**
   * A window dragged from a laptop screen to an external monitor changes how many
   * device pixels a CSS pixel is worth without changing the window's size in CSS
   * pixels at all — so no resize observer fires, and nothing else would notice.
   * Left alone, the canvas keeps the old display's resolution: sharp on one
   * monitor and soft on the other.
   */
  it('follows the window onto a display of a different density', async () => {
    withCanvasEnvironment();
    const harness = createAppHarness();
    const statsRef: { current: FrameStats | null } = { current: null };
    let ready: PanoramaRenderer | null = null;
    const view = render(
      <PanoramaCanvas
        workspace={harness.workspace}
        statsRef={statsRef}
        onReady={(renderer) => {
          ready = renderer;
        }}
        engineOptions={{ headless: true }}
      />,
    );
    await waitFor(() => expect(ready).not.toBeNull());
    const renderer = ready as unknown as PanoramaRenderer;
    // Watched rather than read back: the headless engine reports a hardware
    // scaling level of 1 whatever it is told, so what it was *asked* for is the
    // only evidence there is.
    const engine = renderer.scene.scene.getEngine();
    const sized = vi.spyOn(engine, 'setSize');
    const scaled = vi.spyOn(engine, 'setHardwareScalingLevel');
    const drawn = statsRef.current?.frames ?? 0;

    act(() => moveToDisplay(2));

    // Two device pixels per CSS pixel: half a CSS pixel each, and a buffer twice
    // the size of the 1000x800 the window still is. A frame is drawn into it
    // here rather than left to the loop.
    expect(scaled).toHaveBeenCalledWith(0.5);
    expect(sized).toHaveBeenCalledWith(2_000, 1_600);
    expect(statsRef.current?.frames).toBe(drawn + 1);
    // The window has not changed size, so what the camera projects and what it
    // shows are both exactly what they were.
    expect(renderer.camera.viewport).toEqual({ width: 1_000, height: 800 });
    expect(renderer.camera.visible).toEqual({ width: 1_000, height: 800 });

    // And back again, re-armed: the query asks about one specific density, so
    // hearing about a second change means having replaced it after the first.
    act(() => moveToDisplay(1));
    expect(scaled).toHaveBeenLastCalledWith(1);
    expect(sized).toHaveBeenLastCalledWith(1_000, 800);

    view.unmount();
    // Nothing left listening on a display that is no longer being drawn to.
    expect(densityListeners).toHaveLength(0);
  });

  it('renders frames and reports stats without React state', async () => {
    const { statsRef, unmount } = await mount();
    await waitFor(() => expect(statsRef.current?.frames ?? 0).toBeGreaterThan(0));
    expect(statsRef.current?.tables).toBe(1);
    unmount();
  });

  it('drags a table with the pointer and commits one command', async () => {
    const { harness, canvas, unmount } = await mount();
    const id = firstTableId(harness);
    const commitsBefore = harness.workspace.core.history.commits.size;

    // The table sits at the world origin; the viewport centre is world (0, 0),
    // so client (600, 415) lands on the title bar, clear of the resize margin.
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700, clientY: 465 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 700, clientY: 465 });
    });

    expect(harness.workspace.core.history.commits.size).toBe(commitsBefore + 1);
    expect(harness.workspace.core.world.entities.get(id)?.transform.x).toBe(100);
    unmount();
  });

  it('scrolls the table body with the wheel', async () => {
    const { harness, canvas, unmount } = await mount();
    const view = harness.workspace.viewOfTable(firstTableId(harness));

    act(() => {
      fireEvent.wheel(canvas, { clientX: 600, clientY: 600, deltaY: 240, deltaMode: 0 });
    });
    expect(view?.vertical.target).toBe(240);
    unmount();
  });

  it('pans the canvas with the wheel over empty space', async () => {
    const { harness, canvas, unmount } = await mount();
    act(() => {
      fireEvent.wheel(canvas, { clientX: 30, clientY: 30, deltaY: 100, deltaMode: 0 });
    });
    expect(harness.workspace.viewOfTable(firstTableId(harness))?.vertical.target).toBe(0);
    unmount();
  });

  it('clears hover when the pointer leaves', async () => {
    const { harness, canvas, unmount } = await mount();
    act(() => {
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
    });
    expect(harness.workspace.core.session.hovered).not.toBeNull();

    act(() => {
      fireEvent.pointerLeave(canvas, { pointerId: 1 });
    });
    expect(harness.workspace.core.session.hovered).toBeNull();
    unmount();
  });

  it('undoes and redoes with the keyboard', async () => {
    const { harness, canvas, unmount } = await mount();
    const id = firstTableId(harness);
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700, clientY: 415 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 700, clientY: 415 });
    });
    expect(harness.workspace.core.world.entities.get(id)?.transform.x).toBe(100);

    act(() => {
      fireEvent.keyDown(globalThis, { key: 'z', metaKey: true });
    });
    expect(harness.workspace.core.world.entities.get(id)?.transform.x).toBe(0);

    act(() => {
      fireEvent.keyDown(globalThis, { key: 'Z', metaKey: true, shiftKey: true });
    });
    expect(harness.workspace.core.world.entities.get(id)?.transform.x).toBe(100);
    unmount();
  });

  it('leaves the keyboard alone while the user is typing', async () => {
    const { harness, canvas, unmount } = await mount();
    const id = firstTableId(harness);
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700, clientY: 415 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 700, clientY: 415 });
    });
    expect(harness.workspace.core.world.entities.get(id)?.transform.x).toBe(100);
    expect(harness.workspace.core.session.selection).toHaveLength(1);

    // The SQL editor is real DOM on top of the canvas. ⌘Z there means "undo my
    // typing" and Escape means "leave the field" — neither is a canvas command.
    // A textarea and a single-line input alike: the filter box is as much a place
    // to type as the editor is.
    const field = document.createElement('textarea');
    const box = document.createElement('input');
    document.body.append(field, box);
    act(() => {
      fireEvent.keyDown(field, { key: 'z', metaKey: true });
      fireEvent.keyDown(field, { key: 'Escape' });
      fireEvent.keyDown(box, { key: 'z', metaKey: true });
      fireEvent.keyDown(box, { key: 'Escape' });
    });
    expect(harness.workspace.core.world.entities.get(id)?.transform.x).toBe(100);
    expect(harness.workspace.core.session.selection).toHaveLength(1);

    field.remove();
    box.remove();
    unmount();
  });

  it('clears the selection with Escape', async () => {
    const { harness, canvas, unmount } = await mount();
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
    });
    expect(harness.workspace.core.session.selection).toHaveLength(1);

    act(() => {
      fireEvent.keyDown(globalThis, { key: 'Escape' });
    });
    expect(harness.workspace.core.session.selection).toEqual([]);
    unmount();
  });

  it('lets go of the columns first, and the table only on a second Escape', async () => {
    const { harness, canvas, unmount } = await mount();
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 600, clientY: 415 });
    });
    const entity = [...harness.workspace.core.world.entities.values()][0];
    if (entity === undefined || !isTableEntity(entity)) throw new Error('expected a table');
    const columns = entity.columns.slice(0, 2).map((column) => column.id);
    act(() => {
      harness.workspace.core.dispatchSession({ type: 'SetSelectedColumns', ids: columns });
    });

    act(() => {
      fireEvent.keyDown(globalThis, { key: 'Escape' });
    });
    // The columns go; the table stays active, so it can be worked on further.
    expect(harness.workspace.core.session.selectedColumns).toEqual([]);
    expect(harness.workspace.core.session.selection).toHaveLength(1);

    act(() => {
      fireEvent.keyDown(globalThis, { key: 'Escape' });
    });
    expect(harness.workspace.core.session.selection).toEqual([]);
    unmount();
  });

  it('ignores unrelated keystrokes', async () => {
    const { harness, unmount } = await mount();
    const commits = harness.workspace.core.history.commits.size;
    act(() => {
      fireEvent.keyDown(globalThis, { key: 'a' });
    });
    expect(harness.workspace.core.history.commits.size).toBe(commits);
    unmount();
  });

  it('disposes an engine that finished initialising after unmount', async () => {
    withCanvasEnvironment();
    const harness = createAppHarness();
    const view = render(
      <PanoramaCanvas workspace={harness.workspace} engineOptions={{ headless: true }} />,
    );
    // Unmount in the same tick, before the async engine creation resolves.
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.workspace.core.world.entities.size).toBe(0);
  });

  it('stops rendering once unmounted', async () => {
    const { statsRef, unmount } = await mount();
    await waitFor(() => expect(statsRef.current?.frames ?? 0).toBeGreaterThan(0));
    unmount();
    const frames = statsRef.current?.frames ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statsRef.current?.frames ?? 0).toBe(frames);
  });
});

describe('startup failures', () => {
  it('retries on a fresh canvas when the preferred backend fails', async () => {
    withCanvasEnvironment();
    const harness = createAppHarness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renderer = await import('@panorama/renderer');
    const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');

    const canvases: unknown[] = [];
    vi.spyOn(renderer, 'createPanoramaEngine').mockImplementation(async (canvas, options) => {
      canvases.push(canvas);
      if (options?.preferWebGPU !== false) throw new Error('adapter lost');
      return { engine: new NullEngine(), backend: 'webgl' as const };
    });

    const ready = vi.fn();
    const view = render(<PanoramaCanvas workspace={harness.workspace} onReady={ready} />);
    await waitFor(() => expect(ready).toHaveBeenCalled());

    expect(ready).toHaveBeenCalledWith(expect.anything(), 'webgl');
    // A context is bound to its canvas for life, so the retry must use a new one.
    expect(canvases).toHaveLength(2);
    expect(canvases[0]).not.toBe(canvases[1]);
    // Only the surviving canvas is left in the DOM.
    expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    vi.restoreAllMocks();
    view.unmount();
  });

  it('reports a renderer that cannot start at all', async () => {
    withCanvasEnvironment();
    const harness = createAppHarness();
    const onError = vi.fn();
    const renderer = await import('@panorama/renderer');
    vi.spyOn(renderer, 'createPanoramaEngine').mockRejectedValue(new Error('no GPU here'));

    render(<PanoramaCanvas workspace={harness.workspace} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String(onError.mock.calls[0]?.[0])).toContain('no GPU here');
    vi.restoreAllMocks();
  });

  it('falls back to WebGL when the preferred backend cannot draw a frame', async () => {
    withCanvasEnvironment();
    const harness = createAppHarness();
    const ready = vi.fn();
    const onError = vi.fn();
    const renderer = await import('@panorama/renderer');
    const real = renderer.PanoramaRenderer.prototype.renderFrame;
    let calls = 0;
    vi.spyOn(renderer.PanoramaRenderer.prototype, 'renderFrame').mockImplementation(function (
      this: InstanceType<typeof renderer.PanoramaRenderer>,
      deltaMs?: number,
    ) {
      calls += 1;
      // Fail only the first backend's verification frame.
      if (calls === 1) throw new Error('backend cannot draw');
      return real.call(this, deltaMs);
    });

    const view = render(
      <PanoramaCanvas
        workspace={harness.workspace}
        onReady={ready}
        onError={onError}
        engineOptions={{ headless: true }}
      />,
    );
    await waitFor(() => expect(ready).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    view.unmount();
  });

  it('stops the loop and reports a frame that throws', async () => {
    withCanvasEnvironment();
    const harness = createAppHarness();
    const onError = vi.fn();
    const renderer = await import('@panorama/renderer');
    const real = renderer.PanoramaRenderer.prototype.renderFrame;
    let calls = 0;
    vi.spyOn(renderer.PanoramaRenderer.prototype, 'renderFrame').mockImplementation(function (
      this: InstanceType<typeof renderer.PanoramaRenderer>,
      deltaMs?: number,
    ) {
      calls += 1;
      // Survive verification, then fail inside the render loop.
      if (calls > 1) throw new Error('frame exploded');
      return real.call(this, deltaMs);
    });

    render(
      <PanoramaCanvas
        workspace={harness.workspace}
        onError={onError}
        engineOptions={{ headless: true }}
      />,
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String(onError.mock.calls[0]?.[0])).toContain('frame exploded');
    vi.restoreAllMocks();
  });
});
