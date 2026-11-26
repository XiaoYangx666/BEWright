import { resolve } from 'node:path';
import type { Vec3 } from '../../core/structure.js';
import { requireSidecar, runSidecarJson } from '../../project/sidecar.js';
import { validateWorldDirectory } from './world.js';

export type WorldReadbackOptions = Readonly<{
  world: string;
  output: string;
  origin: Vec3;
  size: Vec3;
  dimension?: number;
  binary?: string;
}>;

/**
 * Read a region of an existing Bedrock world back into an mcstructure file so
 * an import can be checked independently of the sidecar's self-report.
 */
export async function exportWorldRegion(options: WorldReadbackOptions) {
  const world = await validateWorldDirectory(options.world);
  const binary = options.binary ? resolve(options.binary) : requireSidecar('blockwright-world-export');
  const output = resolve(options.output);
  const [x, y, z] = options.origin;
  const [sx, sy, sz] = options.size;
  const args = [
    '--world',
    world,
    '--output',
    output,
    '--x',
    String(x),
    '--y',
    String(y),
    '--z',
    String(z),
    '--size-x',
    String(sx),
    '--size-y',
    String(sy),
    '--size-z',
    String(sz),
    '--dimension',
    String(options.dimension ?? 0),
  ];
  const result = await runSidecarJson<{ ok: boolean; output: string; size: number[] }>(binary, args, 'World export');
  return { output: result.output, size: result.size as unknown as Vec3 };
}
