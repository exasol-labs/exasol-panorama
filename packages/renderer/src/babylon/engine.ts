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
      // Table text must stay crisp; the browser must not resample the canvas.
      alpha: false,
    }),
    backend: 'webgl',
  };
};
