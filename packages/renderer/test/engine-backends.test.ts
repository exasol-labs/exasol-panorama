import { describe, expect, it, vi } from 'vitest';

let webgpuInitFails = false;
const webgpuInit = vi.fn(async () => {
  if (webgpuInitFails) throw new Error('adapter lost');
  return undefined;
});
const webglConstructed: unknown[] = [];
const webgpuConstructed: unknown[] = [];
let webgpuSupported = true;

vi.mock('@babylonjs/core/Engines/webgpuEngine.js', () => ({
  WebGPUEngine: class {
    static get IsSupportedAsync(): Promise<boolean> {
      return Promise.resolve(webgpuSupported);
    }
    initAsync = webgpuInit;
    constructor(canvas: unknown, options: unknown) {
      webgpuConstructed.push({ canvas, options });
    }
  },
}));

vi.mock('@babylonjs/core/Engines/engine.js', () => ({
  Engine: class {
    constructor(canvas: unknown, antialias: unknown, options: unknown) {
      webglConstructed.push({ canvas, antialias, options });
    }
  },
}));

const { createPanoramaEngine } = await import('@panorama/renderer');

describe('engine backend selection', () => {
  it('prefers WebGPU when it is available', async () => {
    webgpuSupported = true;
    const canvas = {} as HTMLCanvasElement;
    const created = await createPanoramaEngine(canvas);
    expect(created.backend).toBe('webgpu');
    expect(webgpuInit).toHaveBeenCalledTimes(1);
    expect(webgpuConstructed[0]).toMatchObject({ canvas, options: { antialias: true } });
  });

  it('falls back to WebGL when WebGPU is unavailable', async () => {
    webgpuSupported = false;
    const created = await createPanoramaEngine({} as HTMLCanvasElement, { antialias: false });
    expect(created.backend).toBe('webgl');
    expect(webglConstructed[0]).toMatchObject({ antialias: false });
  });

  it('can be forced onto WebGL', async () => {
    webgpuSupported = true;
    webgpuInitFails = false;
    const created = await createPanoramaEngine({} as HTMLCanvasElement, { preferWebGPU: false });
    expect(created.backend).toBe('webgl');
  });

  it('reports a failed WebGPU start rather than retrying on the same canvas', async () => {
    webgpuSupported = true;
    webgpuInitFails = true;
    const before = webglConstructed.length;

    // A canvas keeps its first graphics context for life, so a second attempt
    // on the same element could never get one. Retrying is the caller's job,
    // with a fresh canvas; this function reports the failure instead.
    await expect(createPanoramaEngine({} as HTMLCanvasElement)).rejects.toThrow('adapter lost');
    expect(webglConstructed).toHaveLength(before);
    webgpuInitFails = false;
  });
});
