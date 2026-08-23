import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { GlyphAtlas } from '../text/glyph-atlas.js';
import { CanvasGlyphRasterizer } from '../text/canvas-rasterizer.js';
import type { CanvasRenderingContext2DLike } from '../text/canvas-rasterizer.js';
import { createGlyphMaterial } from './materials.js';

/**
 * The text subsystem, behind one seam.
 *
 * The grid depends on `GlyphAtlas` and a material, never on how glyphs are
 * produced. Swapping the canvas atlas for a dedicated MSDF renderer later
 * means replacing this factory and nothing else.
 */

export interface TextSystem {
  readonly atlas: GlyphAtlas;
  readonly material: Material;
  /** Re-uploads the atlas bitmap to the GPU. */
  upload(): void;
  dispose(): void;
}

export type TextSystemFactory = (scene: Scene, size: number, pixelRatio: number) => TextSystem;

/** Texture dimension cap; beyond this the atlas stops growing with the ratio. */
const MAX_ATLAS_PIXELS = 4_096;

export const createCanvasTextSystem: TextSystemFactory = (scene, size, pixelRatio) => {
  // Rasterising at the device pixel ratio needs proportionally more room, or a
  // Retina atlas would hold a quarter of the glyphs.
  const pixels = Math.min(MAX_ATLAS_PIXELS, Math.round(size * pixelRatio));
  const glyphMaterial = createGlyphMaterial(scene, pixels);
  const context = glyphMaterial.texture.getContext() as unknown as CanvasRenderingContext2DLike;
  const atlas = new GlyphAtlas({
    width: pixels,
    height: pixels,
    scale: pixelRatio,
    rasterizer: new CanvasGlyphRasterizer({
      context,
      width: pixels,
      height: pixels,
      pixelRatio,
    }),
  });
  return {
    atlas,
    material: glyphMaterial.material,
    upload: (): void => {
      // `invertY: false` keeps atlas pixel rows aligned with texture
      // coordinates; `QuadBatch` relies on it.
      glyphMaterial.texture.update(false);
    },
    dispose: (): void => {
      glyphMaterial.texture.dispose();
      glyphMaterial.material.dispose();
    },
  };
};
