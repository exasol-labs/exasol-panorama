import { useEffect, useRef } from 'react';
import type { EntityActionId, EntityId } from '@panorama/core';
import type { CreateEngineOptions, ForeignKeyFollow, PanoramaEngine } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  InteractionController,
  PanoramaRenderer,
  createPanoramaEngine,
  drawingScale,
} from '@panorama/renderer';
import type { FrameStats } from '@panorama/renderer';
import { reportTiming } from './shell-agent.js';
import type { Workspace } from './workspace.js';

/**
 * The Panorama canvas.
 *
 * React owns this element and nothing inside it. Scrolling, dragging and
 * resizing never trigger reconciliation: they change world or session state
 * and the next GPU frame reflects it.
 */

export interface PanoramaCanvasProps {
  readonly workspace: Workspace;
  /** Receives the renderer once the engine is up, for XR and instrumentation. */
  readonly onReady?: (renderer: PanoramaRenderer, backend: PanoramaEngine['backend']) => void;
  /** Polled by the overlay; deliberately not React state. */
  readonly statsRef?: { current: FrameStats | null };
  /** Overridden by tests to run against the headless engine. */
  readonly engineOptions?: CreateEngineOptions;
  /** Reports a failure to start the renderer. Silence here reads as "broken". */
  readonly onError?: (message: string) => void;
  /** Performs a halo action; the canvas only reports the intent. */
  readonly onAction?: (entityId: EntityId, action: EntityActionId) => void;
  /** Follows a clicked foreign key cell. */
  readonly onFollowForeignKey?: (follow: ForeignKeyFollow) => void;
}

export const PanoramaCanvas = ({
  workspace,
  onReady,
  statsRef,
  engineOptions,
  onError,
  onAction,
  onFollowForeignKey,
}: PanoramaCanvasProps): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Whether the canvas has been shown, so its appearance is timed exactly once. */
  const shownOnce = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    /**
     * Brings up the renderer on a canvas of its own and proves it can draw a
     * frame before handing it the render loop.
     *
     * Every attempt gets a *new* canvas element. A WebGL or WebGPU context is
     * bound to its canvas for that canvas's lifetime, so a second attempt on
     * the same element cannot get a context at all — it fails with a misleading
     * "not supported". This is also why a StrictMode remount must not share the
     * element: disposing the first engine would tear down the second's context.
     */
    const attempt = async (
      preferWebGPU: boolean,
    ): Promise<{
      canvas: HTMLCanvasElement;
      created: Awaited<ReturnType<typeof createPanoramaEngine>>;
      renderer: PanoramaRenderer;
      interaction: InteractionController;
    }> => {
      /**
       * Created outside the document, and put into it once it has been sized and
       * drawn.
       *
       * An attempt at the preferred backend that fails leaves a canvas with a
       * graphics context and nothing in it, and on WKWebView that happens on every
       * launch: it offers WebGPU, and Panorama's WebGPU path does not work there.
       * A canvas that was never in the document cannot be shown, so the failed
       * attempt costs nothing to look at.
       */
      const canvas = host.ownerDocument.createElement('canvas');
      canvas.className = 'pn-canvas';
      canvas.tabIndex = 0;
      try {
        const created = await createPanoramaEngine(canvas, { preferWebGPU, ...engineOptions });
        try {
          const renderer = new PanoramaRenderer({
            core: workspace.core,
            engine: created.engine,
            views: workspace,
            theme: DEFAULT_TABLE_THEME,
            pixelRatio: drawingScale(),
            beforeFrame: (deltaMs) => {
              workspace.update(deltaMs);
              if (statsRef !== undefined) statsRef.current = renderer.stats;
            },
          });
          const interaction = new InteractionController({
            core: workspace.core,
            camera: renderer.camera,
            host: workspace,
            theme: DEFAULT_TABLE_THEME,
            ...(onAction === undefined ? {} : { onAction }),
            ...(onFollowForeignKey === undefined ? {} : { onFollowForeignKey }),
          });
          // One frame up front, all the way to the drawing buffer: a backend that
          // cannot draw fails here, not silently on every animation frame after.
          renderer.draw();
          return { canvas, created, renderer, interaction };
        } catch (error) {
          created.engine.dispose();
          throw error;
        }
      } catch (error) {
        canvas.remove();
        throw error;
      }
    };

    void (async (): Promise<void> => {
      let started;
      try {
        started = await attempt(true);
      } catch (error) {
        console.warn('[panorama] preferred backend failed; retrying with WebGL', error);
        started = await attempt(false);
      }
      const { canvas, created, renderer, interaction } = started;

      if (disposed) {
        renderer.dispose();
        created.engine.dispose();
        canvas.remove();
        return;
      }

      /**
       * The canvas is drawn larger than the window shows, and clipped to it.
       *
       * This is the whole answer to resize flicker, and it is worth saying why
       * the obvious approach cannot be made to work. Sizing the drawing buffer to
       * the window means reallocating it on every step of a drag; allocating a
       * buffer empties it, and a multi-sampled buffer the size of a window is
       * megabytes of GPU memory to hand back and take again sixty times a second.
       * Two things then go wrong at once. The compositor can see the buffer after
       * it is emptied and before it is drawn, which is a flash of the page
       * behind. And on macOS the reallocation is slow enough that the web process
       * misses the deadline the window server gives it during a live resize, at
       * which point AppKit shows the frame it already had, *scaled* to the new
       * size — the picture visibly zooming for a frame.
       *
       * So the buffer is not resized when the window is. It is allocated once, as
       * large as the display could ever require, and the host clips it. Resizing
       * the window then changes a clip rectangle and nothing else: not one pixel
       * of the canvas is reallocated, redrawn differently, or moved. The window
       * uncovers more of a picture that was already there, or covers some of it
       * up. There is no moment for anything to flicker in, because there is no
       * moment in which the canvas is any different.
       *
       * It grows if it ever has to — a larger display, a denser one — and never
       * shrinks, because shrinking is a reallocation with nothing to gain.
       *
       * What this costs is drawing the whole display's worth of pixels even when
       * the window is small, and holding a buffer that size. Both are bounded by
       * the display, which is what a maximised window already costs, and the
       * scene is two draw calls of flat quads — so the bill is a fraction of the
       * fill rate on any machine that can run this at all. It is worth it: it is
       * the difference between a resize that is smooth and one that is not.
       */
      let buffer = { width: 0, height: 0, ratio: 0 };

      /**
       * The largest the canvas could ever need to be, in CSS pixels.
       *
       * The window cannot be dragged larger than the display it is on, so the
       * display is the bound — and taking the host's own size into account too
       * means nothing is assumed about how the two relate.
       */
      const roomFor = (visible: { width: number; height: number }) => ({
        width: Math.max(visible.width, globalThis.screen?.width ?? 0),
        height: Math.max(visible.height, globalThis.screen?.height ?? 0),
      });

      /**
       * Matches the canvas to the window, and draws if that changed anything.
       *
       * Called from a `ResizeObserver`, whose callback runs after layout and
       * before the frame is painted, so a change lands in the same frame as the
       * layout that prompted it rather than a frame later.
       *
       * Almost every call takes the cheap path: the window has changed size, the
       * buffer has not, and all that happens is that the camera is told how much
       * of the picture is on screen — which moves nothing, because the projection
       * is unchanged. The frame is drawn anyway, so that a window which has just
       * grown shows current content in the strip it uncovered rather than
       * whatever was last drawn there.
       */
      let seen = { width: 0, height: 0 };
      const resize = (): void => {
        const { width, height } = host.getBoundingClientRect();
        const ratio = drawingScale();
        const wanted = roomFor({ width, height });
        const grow =
          ratio !== buffer.ratio || wanted.width > buffer.width || wanted.height > buffer.height;
        // A notification that changed nothing draws nothing.
        if (!grow && width === seen.width && height === seen.height) return;
        seen = { width, height };
        if (grow) {
          // Assigning the scaling level makes the engine resize itself off the
          // element's CSS size, so it is only ever assigned when it changed.
          if (ratio !== buffer.ratio) created.engine.setHardwareScalingLevel(1 / ratio);
          // Never smaller than it already is: shrinking costs a reallocation and
          // buys nothing back that the window might not immediately want again.
          buffer = {
            width: Math.max(buffer.width, wanted.width),
            height: Math.max(buffer.height, wanted.height),
            ratio,
          };
          canvas.style.width = `${buffer.width}px`;
          canvas.style.height = `${buffer.height}px`;
          renderer.resize(buffer.width, buffer.height);
          created.engine.setSize(
            Math.max(1, Math.round(buffer.width * ratio)),
            Math.max(1, Math.round(buffer.height * ratio)),
          );
        }
        renderer.setVisible(width, height);
        try {
          renderer.draw();
        } catch {
          // A frame that cannot be drawn here cannot be drawn by the loop
          // either, and the loop is where a persistent failure is reported.
        }
      };

      /**
       * A move onto a display of a different pixel density, or a different size.
       *
       * Neither changes the window's size in CSS pixels, so no resize observer
       * fires, and the canvas would stay at the old display's resolution — sharp
       * on one monitor, soft on the other — or too small to cover the new one. A
       * media query on the current density is the notification for the first, and
       * catches the second in practice because the two go together; it has to be
       * replaced each time, because it asks about one specific value.
       */
      let density: MediaQueryList | null = null;
      const onDensityChange = (): void => {
        watchDensity();
        resize();
      };
      // Declared, rather than assigned to a const, so it and its listener can name
      // each other: re-arming is the point of the listener.
      function watchDensity(): void {
        density?.removeEventListener('change', onDensityChange);
        density =
          globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`) ?? null;
        density?.addEventListener('change', onDensityChange);
      }

      const pointerOf = (
        event: PointerEvent | WheelEvent,
      ): { screenX: number; screenY: number } => {
        const rect = canvas.getBoundingClientRect();
        return { screenX: event.clientX - rect.left, screenY: event.clientY - rect.top };
      };

      const onPointerDown = (event: PointerEvent): void => {
        canvas.setPointerCapture(event.pointerId);
        interaction.onPointerDown({ ...pointerOf(event), button: event.button });
        canvas.style.cursor = interaction.cursor;
      };
      const onPointerMove = (event: PointerEvent): void => {
        interaction.onPointerMove(pointerOf(event));
        canvas.style.cursor = interaction.cursor;
      };
      const onPointerUp = (event: PointerEvent): void => {
        if (canvas.hasPointerCapture(event.pointerId))
          canvas.releasePointerCapture(event.pointerId);
        interaction.onPointerUp(pointerOf(event));
        canvas.style.cursor = interaction.cursor;
      };
      const onPointerLeave = (): void => {
        interaction.onPointerLeave();
        canvas.style.cursor = 'default';
      };
      const onWheel = (event: WheelEvent): void => {
        // The canvas owns the gesture; the page must not scroll behind it.
        event.preventDefault();
        interaction.onWheel(
          {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          },
          pointerOf(event),
        );
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        // A canvas shortcut must never fire while the user is typing: the SQL
        // editor is real DOM, so ⌘Z there means "undo my typing", not "undo the
        // last command", and Escape means "leave the field".
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLInputElement)
        ) {
          return;
        }
        const accel = event.metaKey || event.ctrlKey;
        if (accel && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) workspace.core.redo();
          else workspace.core.undo();
          return;
        }
        if (event.key === 'Escape') {
          // Columns first: Escape backs out of the narrower selection, so
          // letting go of a few columns does not also let go of the table they
          // are in. A second press clears the table.
          if (workspace.core.session.selectedColumns.length > 0) {
            workspace.core.dispatchSession({ type: 'SetSelectedColumns', ids: [] });
            return;
          }
          workspace.core.dispatchSession({ type: 'SetSelection', ids: [] });
        }
      };

      // Sized and drawn, then shown: the first composite that includes the canvas
      // already has a picture in it. Measured from the host, which is the only
      // one of the two with a rectangle before the canvas has been inserted — and
      // the authority on the canvas's size afterwards too.
      resize();
      host.append(canvas);

      const observer = new ResizeObserver(resize);
      observer.observe(host);
      watchDensity();

      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointerleave', onPointerLeave);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      globalThis.addEventListener('keydown', onKeyDown);

      renderer.start((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[panorama] a frame failed to render', error);
        onError?.(`Rendering stopped: ${message}`);
      });
      onReady?.(renderer, created.backend);

      // The moment the application *appears*, which is what the instantness
      // requirement is about — see `reportTiming`. Reported from here rather than
      // from the first frame, because by now it is the frame of the backend that
      // survived: a failed attempt at the preferred backend draws a frame too, on
      // a canvas that was never in the document, and on WKWebView it does so on
      // every single launch. Timed on the animation frame that assembles the
      // first composite the canvas is part of; everything expensive about a first
      // frame — compiling the shaders, rasterising the glyphs — has happened by
      // then, on the two frames drawn above.
      if (!shownOnce.current) {
        shownOnce.current = true;
        requestAnimationFrame(() => reportTiming('first frame drawn'));
      }

      cleanup = (): void => {
        observer.disconnect();
        density?.removeEventListener('change', onDensityChange);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('wheel', onWheel);
        globalThis.removeEventListener('keydown', onKeyDown);
        renderer.dispose();
        created.engine.dispose();
        canvas.remove();
      };
    })().catch((error: unknown) => {
      // A renderer that fails to start must say so. Swallowing this leaves the
      // canvas blank and every interaction looking like it did nothing.
      const message = error instanceof Error ? error.message : String(error);
      console.error('[panorama] renderer failed to start', error);
      onError?.(`The renderer failed to start: ${message}`);
    });

    return (): void => {
      disposed = true;
      cleanup?.();
    };
  }, [workspace, onReady, statsRef, engineOptions, onError, onAction, onFollowForeignKey]);

  return <div ref={hostRef} className="pn-canvas-host" />;
};
