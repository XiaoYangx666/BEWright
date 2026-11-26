import type { Box, Vec3 } from '../../core/structure.js';

export function toVec3(value: readonly number[]): Vec3 {
  return [value[0]!, value[1]!, value[2]!];
}

export function emptyBox(): Box {
  return { min: [0, 0, 0], max: [0, 0, 0] };
}

export function growBox(box: Box, position: Vec3): Box {
  return {
    min: [Math.min(box.min[0], position[0]), Math.min(box.min[1], position[1]), Math.min(box.min[2], position[2])],
    max: [
      Math.max(box.max[0], position[0] + 1),
      Math.max(box.max[1], position[1] + 1),
      Math.max(box.max[2], position[2] + 1),
    ],
  };
}
