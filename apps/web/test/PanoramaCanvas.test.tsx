import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { isTableEntity } from '@panorama/core';
import type { FrameStats } from '@panorama/renderer';
import { PanoramaCanvas } from '../src/panorama/PanoramaCanvas.js';
import { createAppHarness, firstTableId } from './harness.js';

/**
 * The canvas runs against the headless engine, which exercises the whole
 * wiring — engine, renderer, interaction, event plumbing — without a GPU.
 */

class TestResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    this.callback();
  }
  disconnect(): void {}
  unobserve(): void {}
}

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
  prototype['getBoundingClientRect'] = (): DOMRect =>
    ({
      left: 0,
      top: 0,
      width: 1_000,
      height: 800,
      right: 1_000,
      bottom: 800,
      x: 0,
      y: 0,
    }) as DOMRect;
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
    const field = document.createElement('textarea');
    document.body.append(field);
    act(() => {
      fireEvent.keyDown(field, { key: 'z', metaKey: true });
      fireEvent.keyDown(field, { key: 'Escape' });
    });
    expect(harness.workspace.core.world.entities.get(id)?.transform.x).toBe(100);
    expect(harness.workspace.core.session.selection).toHaveLength(1);

    field.remove();
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
