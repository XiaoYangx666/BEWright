import { colorProfile } from '../blocks/materials.js';
import { assertBox, CHUNK, type Box, type Structure } from '../core/structure.js';
import { mesh, type LightSampler, type MeshData } from './mesher.js';

/** Shared scene computation. Cache persistence and publication belong to callers. */
export function sceneMesher(
  world: Structure,
  region: Box,
  overrides: Readonly<Record<string, string>> = {},
  light?: LightSampler | null,
) {
  assertBox(region);
  const bounds: Box = { min: [...region.min], max: [...region.max] };
  const style = colorProfile(overrides);
  const chunk = (key: string): MeshData | null => {
    const source = world.chunks.get(key);
    if (!source || source.origin.some((v, axis) => v >= bounds.max[axis] || v + CHUNK <= bounds.min[axis])) return null;
    return mesh(world, bounds, key, style, light);
  };
  return {
    chunk,
    *chunks(keys: Iterable<string> = world.chunks.keys()) {
      for (const key of keys) yield [key, chunk(key)] as const;
    },
  };
}
