import type { Vec3 } from '../core/structure.js';

/** Authoring rectangles are inclusive; core Box remains half-open. */
export type RectXZ = Readonly<{ x0: number; x1: number; z0: number; z1: number }>;
export function assertRect(rect: RectXZ) {
  if (![rect.x0, rect.x1, rect.z0, rect.z1].every(Number.isSafeInteger) || rect.x0 > rect.x1 || rect.z0 > rect.z1)
    throw new Error('Expected a nonempty inclusive integer rectangle');
}
export function assertPoint(point: readonly number[]) {
  if (point.length !== 3 || !point.every(Number.isSafeInteger)) throw new Error('Expected an integer Vec3');
}
export function unitInterval(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be in [0,1]`);
}
/** Stateless coordinate random: traversal order does not affect placement. */
export function coordinateRandom(x: number, y: number, z: number, seed = 0, channel = 0) {
  let h =
    Math.imul(x, 73856093) ^
    Math.imul(y, 83492791) ^
    Math.imul(z, 19349663) ^
    Math.imul(seed, 1597334677) ^
    Math.imul(channel, 381201581);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Face-connected voxel path, including both endpoints. Useful for solid branches. */
export function voxelPath(points: readonly Vec3[]): Vec3[] {
  points.forEach(assertPoint);
  if (!points.length) return [];
  const result: Vec3[] = [[...points[0]]];
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1],
      end = points[i];
    const steps = Math.max(...end.map((v, axis) => Math.abs(v - start[axis])));
    let current: Vec3 = [...start];
    for (let n = 1; n <= steps; n++) {
      const target = start.map((v, axis) => Math.round(v + ((end[axis] - v) * n) / steps));
      for (const axis of [0, 1, 2])
        while (current[axis] !== target[axis]) {
          current = [...current];
          current[axis] += Math.sign(target[axis] - current[axis]);
          result.push(current);
        }
    }
  }
  return result;
}
