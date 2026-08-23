import { describe, expect, it } from 'vitest';
import {
  ZERO_VEC3,
  addVec3,
  clamp,
  rectContains,
  rectsIntersect,
  subtractVec3,
  vec3,
  vec3Equals,
} from '@panorama/core';

describe('vectors', () => {
  it('defaults z to zero', () => {
    expect(vec3(1, 2)).toEqual({ x: 1, y: 2, z: 0 });
    expect(vec3(1, 2, 3).z).toBe(3);
    expect(ZERO_VEC3).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('adds and subtracts componentwise', () => {
    expect(addVec3(vec3(1, 2, 3), vec3(10, 20, 30))).toEqual({ x: 11, y: 22, z: 33 });
    expect(subtractVec3(vec3(10, 20, 30), vec3(1, 2, 3))).toEqual({ x: 9, y: 18, z: 27 });
  });

  it('compares componentwise', () => {
    expect(vec3Equals(vec3(1, 2, 3), vec3(1, 2, 3))).toBe(true);
    expect(vec3Equals(vec3(1, 2, 3), vec3(1, 2, 4))).toBe(false);
    expect(vec3Equals(vec3(1, 2, 3), vec3(1, 9, 3))).toBe(false);
    expect(vec3Equals(vec3(1, 2, 3), vec3(9, 2, 3))).toBe(false);
  });
});

describe('rectangles', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };

  it('treats the top-left edge as inside and the bottom-right as outside', () => {
    expect(rectContains(rect, 10, 20)).toBe(true);
    expect(rectContains(rect, 109.9, 69.9)).toBe(true);
    expect(rectContains(rect, 110, 70)).toBe(false);
    expect(rectContains(rect, 9, 30)).toBe(false);
    expect(rectContains(rect, 30, 19)).toBe(false);
  });

  it('detects overlap', () => {
    expect(rectsIntersect(rect, { x: 0, y: 0, width: 20, height: 30 })).toBe(true);
    expect(rectsIntersect(rect, { x: 200, y: 20, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect(rect, { x: 10, y: 200, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect(rect, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
