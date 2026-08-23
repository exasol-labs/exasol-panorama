/**
 * Minimal 3D geometry. Panorama is spatial even on the desktop: entities carry
 * a z coordinate from the start so the desktop and XR cameras look at the same
 * document rather than two parallel worlds.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Size2 {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const vec3 = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

export const ZERO_VEC3: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

export const addVec3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const subtractVec3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

export const vec3Equals = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

export const rectContains = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Clamps `value` into `[min, max]`. Returns `min` when the range is inverted. */
export const clamp = (value: number, min: number, max: number): number => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};
