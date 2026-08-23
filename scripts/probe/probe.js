/**
 * Renderer recipe probe.
 *
 * A scratch pad for settling questions about the graphics stack that can only
 * be answered by a real GPU — which material configuration lets vertex colours
 * through, which texture-coordinate orientation matches the atlas upload, and
 * so on. Edit the variants, run `npm run probe`, and read `probe.png`.
 *
 * It currently checks atlas orientation: exactly one variant shows a red "A".
 */
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

const canvas = document.querySelector('#c');
const engine = new Engine(canvas, false, { alpha: false });
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0.4, 0, 1);

const camera = new FreeCamera('cam', new Vector3(0, 0, -10), scene);
camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = 600;
camera.orthoTop = 0;
camera.orthoBottom = -120;
camera.setTarget(new Vector3(0, 0, 0));

/** An atlas holding a big white "A" in the top-left 64x64 cell. */
const makeAtlas = (invertYOnUpdate) => {
  const texture = new DynamicTexture(
    `atlas-${String(invertYOnUpdate)}`,
    { width: 256, height: 256 },
    scene,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  texture.hasAlpha = true;
  const context = texture.getContext();
  context.font = '600 56px sans-serif';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#ffffff';
  context.fillText('A', 4, 52);
  texture.update(invertYOnUpdate);
  return texture;
};

/**
 * Four combinations of atlas upload orientation and quad V coordinates. The
 * correct one shows a red "A" on green; the rest show nothing.
 */
const CELL = 64 / 256;
const variants = {
  a_flipV_noInvert: { flip: true, invertY: false },
  b_plainV_noInvert: { flip: false, invertY: false },
  c_flipV_invert: { flip: true, invertY: true },
  d_plainV_invert: { flip: false, invertY: true },
};

let index = 0;
for (const [name, variant] of Object.entries(variants)) {
  const mesh = new Mesh(name, scene);
  const x = index * 100;
  const v0 = variant.flip ? 1 - 0 : 0;
  const v1 = variant.flip ? 1 - CELL : CELL;
  const positions = new Float32Array([x, 0, 0, x + 100, 0, 0, x + 100, -100, 0, x, -100, 0]);
  const colors = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, v0, CELL, v0, CELL, v1, 0, v1]);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
  mesh.setIndices(new Uint32Array([0, 1, 2, 0, 2, 3]), 4, true);
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = true;
  const material = new StandardMaterial(`${name}-mat`, scene);
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.specularColor = Color3.Black();
  material.ambientColor = Color3.Black();
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseTexture = makeAtlas(variant.invertY);
  material.useAlphaFromDiffuseTexture = true;
  mesh.material = material;
  index += 1;
}

globalThis.__probe = { names: Object.keys(variants) };

engine.runRenderLoop(() => scene.render());
