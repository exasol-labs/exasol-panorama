import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { Scene } from '@babylonjs/core/scene.js';

/**
 * Unlit materials.
 *
 * Nothing in a data grid is shaded. With `disableLighting` there is no light
 * contribution at all, so the *emissive* term is what reaches the screen —
 * white emissive is what lets vertex colours through unmodified. (A black
 * emissive renders every quad black; verified against both backends with
 * `scripts/probe`.) Using `StandardMaterial` rather than a custom shader keeps
 * one code path across WebGL and WebGPU.
 */

const configureUnlit = (material: StandardMaterial): void => {
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.White();
  material.specularColor = Color3.Black();
  material.ambientColor = Color3.Black();
  material.backFaceCulling = false;
  // Everything is drawn in painter's order at z = 0; depth writes would make
  // coincident quads flicker.
  material.disableDepthWrite = true;
};

export const createSolidMaterial = (scene: Scene, name = 'panorama-solid'): StandardMaterial => {
  const material = new StandardMaterial(name, scene);
  configureUnlit(material);
  material.useAlphaFromDiffuseTexture = false;
  material.alpha = 1;
  return material;
};

export interface GlyphMaterial {
  readonly material: StandardMaterial;
  readonly texture: DynamicTexture;
}

export const createGlyphMaterial = (
  scene: Scene,
  size: number,
  name = 'panorama-glyphs',
): GlyphMaterial => {
  const texture = new DynamicTexture(
    `${name}-atlas`,
    { width: size, height: size },
    scene,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.hasAlpha = true;
  const material = new StandardMaterial(name, scene);
  configureUnlit(material);
  material.diffuseTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.opacityTexture = null;
  return { material, texture };
};
