import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Rgba } from '../theme.js';

/**
 * A batched quad mesh.
 *
 * Forty rows of ten columns is four hundred cells, and none of them may become
 * a scene node. Everything a table draws goes into two of these: one for solid
 * quads, one for glyphs. Draw calls then scale with rendering features, not
 * with table size.
 */

export interface QuadBatchOptions {
  readonly name: string;
  readonly scene: Scene;
  /** Reserve texture coordinates; required for the glyph batch. */
  readonly textured?: boolean;
  readonly initialCapacity?: number;
}

const VERTICES_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

export class QuadBatch {
  readonly mesh: Mesh;
  readonly #textured: boolean;
  #capacity: number;
  #positions: Float32Array;
  #colors: Float32Array;
  #uvs: Float32Array;
  #indices: Uint32Array;
  #count = 0;
  /** Quads written to the GPU last frame; used to clear what is now unused. */
  #drawnCount = 0;
  #uploadedCapacity = -1;

  constructor(options: QuadBatchOptions) {
    this.#textured = options.textured ?? false;
    this.#capacity = Math.max(16, options.initialCapacity ?? 1_024);
    this.#positions = new Float32Array(this.#capacity * VERTICES_PER_QUAD * 3);
    this.#colors = new Float32Array(this.#capacity * VERTICES_PER_QUAD * 4);
    this.#uvs = new Float32Array(this.#capacity * VERTICES_PER_QUAD * 2);
    this.#indices = new Uint32Array(this.#capacity * INDICES_PER_QUAD);
    for (let quad = 0; quad < this.#capacity; quad += 1) {
      const base = quad * VERTICES_PER_QUAD;
      this.#indices.set(
        [base, base + 1, base + 2, base, base + 2, base + 3],
        quad * INDICES_PER_QUAD,
      );
    }
    this.mesh = new Mesh(options.name, options.scene);
    this.mesh.useVertexColors = true;
    this.mesh.hasVertexAlpha = true;
    this.mesh.isPickable = false;
    // The table is drawn back-to-front in a strict order; depth testing would
    // fight with coincident quads at the same z.
    this.mesh.alwaysSelectAsActiveMesh = true;
  }

  get quadCount(): number {
    return this.#count;
  }

  get capacity(): number {
    return this.#capacity;
  }

  setMaterial(material: Material): void {
    this.mesh.material = material;
  }

  /** Starts a new frame. Buffers are reused; nothing is reallocated. */
  begin(): void {
    this.#count = 0;
  }

  #grow(required: number): void {
    let capacity = this.#capacity;
    while (capacity < required) capacity *= 2;
    const positions = new Float32Array(capacity * VERTICES_PER_QUAD * 3);
    const colors = new Float32Array(capacity * VERTICES_PER_QUAD * 4);
    const uvs = new Float32Array(capacity * VERTICES_PER_QUAD * 2);
    positions.set(this.#positions);
    colors.set(this.#colors);
    uvs.set(this.#uvs);
    this.#positions = positions;
    this.#colors = colors;
    this.#uvs = uvs;
    // Indices depend only on capacity, so they are built once per growth and
    // never touched again — the index buffer is uploaded once, not per frame.
    this.#indices = new Uint32Array(capacity * INDICES_PER_QUAD);
    for (let quad = 0; quad < capacity; quad += 1) {
      const base = quad * VERTICES_PER_QUAD;
      this.#indices.set(
        [base, base + 1, base + 2, base, base + 2, base + 3],
        quad * INDICES_PER_QUAD,
      );
    }
    this.#capacity = capacity;
  }

  /**
   * Adds a quad in Babylon world space. Panorama's world uses +y downwards, so
   * callers pass an already-flipped `y`; this is the single conversion point.
   */
  push(
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    color: Rgba,
    uv?: readonly [number, number, number, number],
  ): void {
    if (this.#count + 1 > this.#capacity) this.#grow(this.#count + 1);
    const quad = this.#count;
    const position = quad * VERTICES_PER_QUAD * 3;
    const colorOffset = quad * VERTICES_PER_QUAD * 4;
    const uvOffset = quad * VERTICES_PER_QUAD * 2;

    const left = x;
    const right = x + width;
    const top = y;
    const bottom = y - height;

    this.#positions.set([left, top, z, right, top, z, right, bottom, z, left, bottom, z], position);
    for (let vertex = 0; vertex < VERTICES_PER_QUAD; vertex += 1) {
      this.#colors.set(color, colorOffset + vertex * 4);
    }
    if (this.#textured) {
      // The atlas is uploaded without inverting Y, so a texture coordinate maps
      // straight onto an atlas pixel row — no flip here or anywhere else.
      const [u0, v0, u1, v1] = uv ?? [0, 0, 1, 1];
      this.#uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], uvOffset);
    }
    this.#count += 1;
  }

  /**
   * Uploads the frame.
   *
   * The GPU buffers are always the full capacity: a graphics buffer cannot be
   * resized by writing more data into it, so the vertex count stays constant
   * between growths and quads that are no longer used collapse to a degenerate
   * triangle, which the rasteriser discards for free.
   */
  commit(): void {
    if (this.#count < this.#drawnCount) {
      // Collapse the quads this frame stopped using.
      this.#positions.fill(
        0,
        this.#count * VERTICES_PER_QUAD * 3,
        this.#drawnCount * VERTICES_PER_QUAD * 3,
      );
    }
    this.#drawnCount = this.#count;

    const grew = this.#uploadedCapacity !== this.#capacity;
    if (grew) {
      this.#uploadedCapacity = this.#capacity;
      this.mesh.setVerticesData(VertexBuffer.PositionKind, this.#positions, true);
      this.mesh.setVerticesData(VertexBuffer.ColorKind, this.#colors, true);
      if (this.#textured) {
        this.mesh.setVerticesData(VertexBuffer.UVKind, this.#uvs, true);
      }
      this.mesh.setIndices(this.#indices, this.#capacity * VERTICES_PER_QUAD, true);
    } else {
      this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.#positions, false, false);
      this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.#colors, false, false);
      if (this.#textured) {
        this.mesh.updateVerticesData(VertexBuffer.UVKind, this.#uvs, false, false);
      }
    }
    this.mesh.setEnabled(this.#count > 0);
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
