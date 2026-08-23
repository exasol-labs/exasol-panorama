import { useEffect, useRef } from 'react';
import type { EntityActionId, EntityId } from '@panorama/core';
import type { CreateEngineOptions, ForeignKeyFollow, PanoramaEngine } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  InteractionController,
  PanoramaRenderer,
  createPanoramaEngine,
} from '@panorama/renderer';
import type { FrameStats } from '@panorama/renderer';
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
      const canvas = host.ownerDocument.createElement('canvas');
      canvas.className = 'pn-canvas';
      canvas.tabIndex = 0;
      host.append(canvas);
      try {
        const created = await createPanoramaEngine(canvas, { preferWebGPU, ...engineOptions });
        try {
          const renderer = new PanoramaRenderer({
            core: workspace.core,
            engine: created.engine,
            views: workspace,
            theme: DEFAULT_TABLE_THEME,
            pixelRatio: Math.min(2, globalThis.devicePixelRatio || 1),
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
          // One frame up front: a backend that cannot draw fails here, not
          // silently on every animation frame afterwards.
          renderer.renderFrame(0);
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

      const resize = (): void => {
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        renderer.resize(rect.width, rect.height);
        created.engine.resize();
      };

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
        const accel = event.metaKey || event.ctrlKey;
        if (accel && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) workspace.core.redo();
          else workspace.core.undo();
          return;
        }
        if (event.key === 'Escape') {
          workspace.core.dispatchSession({ type: 'SetSelection', ids: [] });
        }
      };

      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      resize();

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

      cleanup = (): void => {
        observer.disconnect();
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
