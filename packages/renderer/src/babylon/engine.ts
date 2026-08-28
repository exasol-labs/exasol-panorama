import { Engine } from '@babylonjs/core/Engines/engine.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';

/**
 * Engine creation.
 *
 * WebGPU is the primary performance target; WebGL stays as a compatibility
 * fallback so the application still runs where WebGPU is unavailable.
 *
 * One call creates exactly one engine and throws if it cannot. It deliberately
 * does *not* fall back internally: a canvas can only ever hold one graphics
 * context, so retrying with another backend needs a fresh canvas element, and
 * only the caller that owns the DOM can provide one.
 */

export type EngineBackend = 'webgpu' | 'webgl' | 'null';

export interface PanoramaEngine {
  readonly engine: AbstractEngine;
  readonly backend: EngineBackend;
}

export interface CreateEngineOptions {
  /** Set to false to force the WebGL backend. */
  readonly preferWebGPU?: boolean;
  readonly antialias?: boolean;
  /** Headless engine for tests and server-side layout checks. */
  readonly headless?: boolean;
}

/**
 * Device pixels per CSS pixel, capped.
 *
 * Everything that has to agree about resolution reads it here: the drawing
 * buffer's size and the glyph atlas it is drawn with. Past 2x the extra pixels
 * cost a real amount of fill rate and show nobody anything.
 */
export const drawingScale = (): number => Math.min(2, globalThis.devicePixelRatio || 1);

export const isWebGPUSupported = async (): Promise<boolean> => {
  try {
    return await WebGPUEngine.IsSupportedAsync;
  } catch {
    return false;
  }
};

export const createPanoramaEngine = async (
  canvas: HTMLCanvasElement,
  options: CreateEngineOptions = {},
): Promise<PanoramaEngine> => {
  if (options.headless === true) {
    return { engine: new NullEngine(), backend: 'null' };
  }
  if (options.preferWebGPU !== false && (await isWebGPUSupported())) {
    const engine = new WebGPUEngine(canvas, {
      antialias: options.antialias ?? true,
      stencil: false,
    });
    await engine.initAsync();
    return { engine, backend: 'webgpu' };
  }
  return {
    engine: new Engine(canvas, options.antialias ?? true, {
      preserveDrawingBuffer: false,
      stencil: false,
      /**
       * With an alpha channel, deliberately.
       *
       * A drawing buffer is emptied whenever it is allocated. Without alpha,
       * "empty" composites as opaque black; with it, the page shows through —
       * and the page behind the canvas is painted the same grey the scene clears
       * to (`canvasBackground` here, `--pn-bg` there). So the one state the
       * canvas can be in that nothing drew is indistinguishable from a drawn
       * frame, which is the difference between a flicker and no flicker.
       *
       * It costs nothing in sharpness: what keeps text crisp is the drawing
       * buffer being sized in device pixels, which `PanoramaCanvas` does.
       */
      alpha: true,
    }),
    backend: 'webgl',
  };
};
