import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import {
  createCanvasTextSystem,
  createPanoramaEngine,
  createSolidMaterial,
  isWebGPUSupported,
} from '@panorama/renderer';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPanoramaEngine', () => {
  it('creates a headless engine for tests', async () => {
    const created = await createPanoramaEngine(null as never, { headless: true });
    expect(created.backend).toBe('null');
    expect(created.engine).toBeInstanceOf(NullEngine);
    created.engine.dispose();
  });
});

describe('isWebGPUSupported', () => {
  it('reports support', async () => {
    vi.spyOn(WebGPUEngine, 'IsSupportedAsync', 'get').mockResolvedValue(true);
    await expect(isWebGPUSupported()).resolves.toBe(true);
  });

  it('treats a throwing probe as unsupported', async () => {
    vi.spyOn(WebGPUEngine, 'IsSupportedAsync', 'get').mockImplementation(() => {
      throw new Error('no navigator.gpu');
    });
    await expect(isWebGPUSupported()).resolves.toBe(false);
  });
});

describe('materials', () => {
  it('creates an unlit vertex-coloured material', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const material = createSolidMaterial(scene);
    expect(material.disableLighting).toBe(true);
    expect(material.disableDepthWrite).toBe(true);
    expect(material.backFaceCulling).toBe(false);
    // White emissive is what carries vertex colour through an unlit material.
    expect(material.emissiveColor.r).toBe(1);
    expect(material.specularColor.r).toBe(0);
    scene.dispose();
    engine.dispose();
  });
});

/** A permissive 2D context: any method is a no-op, any property readable. */
const fakeCanvas = (size: number): unknown => {
  const context: Record<string, unknown> = {
    canvas: null,
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const proxy = new Proxy(context, {
    get: (target, property) =>
      property in target ? target[property as string] : (): undefined => undefined,
    set: (target, property, value) => {
      target[property as string] = value;
      return true;
    },
  });
  return { width: size, height: size, getContext: (): unknown => proxy };
};

describe('createCanvasTextSystem', () => {
  it('builds an atlas backed by a dynamic texture', () => {
    const engine = new NullEngine();
    vi.spyOn(engine, 'createCanvas').mockImplementation(
      (width: number, height: number) => fakeCanvas(Math.max(width, height)) as never,
    );
    const scene = new Scene(engine);
    const system = createCanvasTextSystem(scene, 128, 1);

    expect(system.atlas.width).toBe(128);
    expect(system.material).toBeDefined();
    // Rasterising and uploading must not throw on any backend.
    expect(() => system.atlas.slot({ char: 'A', fontSize: 12, bold: false })).not.toThrow();
    expect(() => system.upload()).not.toThrow();
    expect(() => system.dispose()).not.toThrow();

    scene.dispose();
    engine.dispose();
  });
});
