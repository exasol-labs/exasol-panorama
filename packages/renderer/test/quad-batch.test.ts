import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { QuadBatch } from '@panorama/renderer';

let engine: NullEngine;
let scene: Scene;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

const red = [1, 0, 0, 1] as const;

describe('QuadBatch', () => {
  it('builds four vertices and six indices per quad', () => {
    const batch = new QuadBatch({ name: 'q', scene });
    batch.begin();
    batch.push(10, 20, 0, 100, 50, red);
    batch.commit();

    expect(batch.quadCount).toBe(1);
    // Buffers are allocated at capacity; unused quads stay collapsed.
    expect(batch.mesh.getTotalVertices()).toBe(batch.capacity * 4);
    expect(batch.mesh.getTotalIndices()).toBe(batch.capacity * 6);
    expect(batch.mesh.isEnabled()).toBe(true);

    const positions = batch.mesh.getVerticesData(VertexBuffer.PositionKind);
    // Quads are laid out top-left, top-right, bottom-right, bottom-left.
    expect(Array.from(positions?.slice(0, 12) ?? [])).toEqual([
      10, 20, 0, 110, 20, 0, 110, -30, 0, 10, -30, 0,
    ]);
  });

  it('repeats the colour on every vertex', () => {
    const batch = new QuadBatch({ name: 'q', scene });
    batch.begin();
    batch.push(0, 0, 0, 10, 10, [0.25, 0.5, 0.75, 0.5]);
    batch.commit();
    const colors = batch.mesh.getVerticesData(VertexBuffer.ColorKind);
    expect(Array.from(colors?.slice(0, 8) ?? [])).toEqual([
      0.25, 0.5, 0.75, 0.5, 0.25, 0.5, 0.75, 0.5,
    ]);
  });

  it('writes texture coordinates only when textured', () => {
    const plain = new QuadBatch({ name: 'plain', scene });
    plain.begin();
    plain.push(0, 0, 0, 1, 1, red, [0.1, 0.2, 0.3, 0.4]);
    plain.commit();
    expect(plain.mesh.getVerticesData(VertexBuffer.UVKind)).toBeNull();

    const textured = new QuadBatch({ name: 'textured', scene, textured: true });
    textured.begin();
    textured.push(0, 0, 0, 1, 1, red, [0.1, 0.2, 0.3, 0.4]);
    textured.commit();
    const uvs = Array.from(textured.mesh.getVerticesData(VertexBuffer.UVKind)?.slice(0, 8) ?? []);
    // Atlas rows map straight onto texture coordinates: no V flip.
    [0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.1, 0.4].forEach((expected, index) => {
      expect(uvs[index]).toBeCloseTo(expected, 6);
    });
  });

  it('defaults texture coordinates to the whole atlas', () => {
    const batch = new QuadBatch({ name: 'q', scene, textured: true });
    batch.begin();
    batch.push(0, 0, 0, 1, 1, red);
    batch.commit();
    expect(Array.from(batch.mesh.getVerticesData(VertexBuffer.UVKind)?.slice(0, 8) ?? [])).toEqual([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]);
  });

  it('reuses its buffers across frames', () => {
    const batch = new QuadBatch({ name: 'q', scene, initialCapacity: 16 });
    for (let frame = 0; frame < 5; frame += 1) {
      batch.begin();
      for (let quad = 0; quad < 10; quad += 1) batch.push(quad, 0, 0, 1, 1, red);
      batch.commit();
    }
    expect(batch.capacity).toBe(16);
    expect(batch.quadCount).toBe(10);
    expect(batch.mesh.getTotalVertices()).toBe(64);
  });

  it('grows when a frame needs more quads', () => {
    const batch = new QuadBatch({ name: 'q', scene, initialCapacity: 16 });
    batch.begin();
    for (let quad = 0; quad < 100; quad += 1) batch.push(quad, 0, 0, 1, 1, red);
    batch.commit();
    expect(batch.capacity).toBeGreaterThanOrEqual(100);
    expect(batch.mesh.getTotalVertices()).toBe(batch.capacity * 4);
  });

  it('collapses quads a later frame stopped using', () => {
    const batch = new QuadBatch({ name: 'q', scene, initialCapacity: 16 });
    batch.begin();
    batch.push(0, 0, 0, 10, 10, red);
    batch.push(100, 0, 0, 10, 10, red);
    batch.commit();

    batch.begin();
    batch.push(0, 0, 0, 10, 10, red);
    batch.commit();

    const positions = batch.mesh.getVerticesData(VertexBuffer.PositionKind);
    // The second quad's vertices are zeroed, so it rasterises to nothing.
    expect(Array.from(positions?.slice(12, 24) ?? [])).toEqual(new Array(12).fill(0));
    expect(Array.from(positions?.slice(0, 3) ?? [])).toEqual([0, 0, 0]);
  });

  it('grows without corrupting the frame in progress', () => {
    const batch = new QuadBatch({ name: 'q', scene, initialCapacity: 16 });
    batch.begin();
    for (let quad = 0; quad < 40; quad += 1) batch.push(quad * 10, 0, 0, 5, 5, red);
    batch.commit();

    const positions = batch.mesh.getVerticesData(VertexBuffer.PositionKind);
    expect(positions?.[0]).toBe(0);
    expect(positions?.[39 * 12]).toBe(390);
    expect(batch.mesh.getTotalIndices()).toBe(batch.capacity * 6);
  });

  it('disables itself when a frame draws nothing', () => {
    const batch = new QuadBatch({ name: 'q', scene });
    batch.begin();
    batch.push(0, 0, 0, 1, 1, red);
    batch.commit();
    batch.begin();
    batch.commit();
    expect(batch.quadCount).toBe(0);
    expect(batch.mesh.isEnabled()).toBe(false);
  });

  it('accepts a material and disposes cleanly', () => {
    const batch = new QuadBatch({ name: 'q', scene });
    const material = new StandardMaterial('m', scene);
    batch.setMaterial(material);
    expect(batch.mesh.material).toBe(material);
    batch.dispose();
    expect(batch.mesh.isDisposed()).toBe(true);
  });

  it('enforces a minimum capacity', () => {
    expect(new QuadBatch({ name: 'q', scene, initialCapacity: 1 }).capacity).toBe(16);
  });
});
