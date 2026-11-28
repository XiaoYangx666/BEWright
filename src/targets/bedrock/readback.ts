import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { AIR, assertBox, block, Structure, type Box, type State, type Vec3 } from '../../core/structure.js';
import { requireSidecar, runSidecar, runSidecarJson } from '../../project/sidecar.js';
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

/** Keep sidecar allocations bounded even for full-height regions. */
export function readbackTiles(regions: readonly Box[]): Box[] {
  const tiles = new Map<string, Box>();
  const width = 64;
  for (const region of regions) {
    assertBox(region);
    const { min, max } = region;
    for (let x = min[0]; x < max[0]; x += width)
      for (let y = min[1]; y < max[1]; y += width)
        for (let z = min[2]; z < max[2]; z += width) {
          const tile: Box = {
            min: [x, y, z],
            max: [Math.min(max[0], x + width), Math.min(max[1], y + width), Math.min(max[2], z + width)],
          };
          tiles.set([...tile.min, ...tile.max].join(','), tile);
        }
  }
  return [...tiles.values()];
}

export async function exportWorldTiles(world: string, output: string, tiles: readonly Box[]) {
  const binary = requireSidecar('blockwright-world-export');
  const result = await runSidecarJson<{ ok: boolean; regions: number }>(
    binary,
    ['--world', await validateWorldDirectory(world), '--output', resolve(output), '--regions-stdin'],
    'World readback (run "bewright sidecar build" if the binary is out of date)',
    Buffer.from(JSON.stringify(tiles)),
  );
  if (result.regions !== tiles.length) throw new Error('Incomplete world readback');
  return tiles.map((bounds, index) => ({ bounds, file: `${index}.mcstructure` }));
}

/** Separate length-prefixed frames without buffering the complete world readback. */
async function* readFrames(stream: Readable) {
  const length = Buffer.allocUnsafe(4);
  let frame: Buffer | undefined;
  let used = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    for (let offset = 0; offset < chunk.length;) {
      const buffer = frame ?? length;
      const size = Math.min(buffer.length - used, chunk.length - offset);
      chunk.copy(buffer, used, offset, offset + size);
      used += size;
      offset += size;
      if (used !== buffer.length) continue;
      used = 0;
      if (frame) {
        yield frame;
        frame = undefined;
      } else {
        const bytes = length.readUInt32LE();
        if (bytes < 4 || bytes > 8 * 1024 * 1024) throw new Error('Invalid world readback frame length');
        frame = Buffer.allocUnsafe(bytes);
      }
    }
  }
  if (frame || used) throw new Error('Truncated world readback frame');
}

function loadFrame(blocks: Structure, bounds: Box, frame: Buffer) {
  const [x, y, z] = bounds.min;
  const [sx, sy, sz] = bounds.max.map((end, axis) => end - bounds.min[axis]);
  const volume = sx * sy * sz;
  const dataOffset = 4 + frame.readUInt32LE();
  if (frame.length !== dataOffset + volume * 2) throw new Error('Invalid world readback tile size');
  const palette = JSON.parse(frame.toString('utf8', 4, dataOffset)) as State[];
  const ids = palette.map((state) => (state.name === AIR.name ? 0 : blocks.intern(block(state.name, state.states))));
  for (let i = 0; i < volume; i++) {
    const id = ids[frame.readUInt16LE(dataOffset + i * 2)];
    if (id === undefined) throw new Error('Invalid world readback palette index');
    if (id) blocks.setId(x + Math.floor(i / (sy * sz)), y + (Math.floor(i / sz) % sy), z + (i % sz), id);
  }
}

/** Read primary blocks directly from the sidecar. World air stays implicit. */
export async function readWorldBlocks(world: string, regions: readonly Box[]) {
  const blocks = new Structure(false);
  if (regions.length === 0) return blocks;
  const binary = requireSidecar('blockwright-world-export');
  const tiles = readbackTiles(regions);
  const path = await validateWorldDirectory(world);
  let index = 0;
  try {
    await runSidecar(
      binary,
      ['--world', path, '--blocks-stdin'],
      Buffer.from(JSON.stringify(tiles)),
      async (stdout) => {
        for await (const frame of readFrames(stdout)) {
          if (index >= tiles.length) throw new Error('Unexpected world readback tile');
          loadFrame(blocks, tiles[index++], frame);
        }
        if (index !== tiles.length) throw new Error('Incomplete world readback');
      },
    );
  } catch (error) {
    throw new Error(
      `World readback failed. Run "bewright sidecar build" if your sidecar is outdated. ${String(error)}`,
      { cause: error },
    );
  }
  return blocks;
}
