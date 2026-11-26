import { cp, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import nbt from 'prismarine-nbt';
import { TARGET } from '../../blocks/target.js';
import { assertBox, contains, type Box, type State, Structure } from '../../core/structure.js';
import { validateBlockState } from '../../blocks/registry.js';
import { requireSidecar, runSidecarJson, sidecarBinary } from '../../project/sidecar.js';
import { blockIndexLayers } from './mcstructure.js';
export { cargoExecutable } from '../../project/sidecar.js';

export type WorldPlacement = {
  world: string;
  structure: string;
  position: readonly [number, number, number];
  dimension?: number;
  rotation?: 0 | 90 | 180 | 270;
  mirrorX?: boolean;
  mirrorZ?: boolean;
  backup?: boolean;
  binary?: string;
};

type DirectWorldPlacement = Omit<WorldPlacement, 'structure'> & {
  /** Direct, unrotated placements only. Skip columns containing no writes. */
  skipEmptyChunks?: boolean;
};

export type WorldPlacementResult = {
  backupPath?: string;
  touchedChunks: number;
  /** Cells actually written (non-void). */
  placedBlocks: number;
  /** Bounding-box volume the sidecar scanned, including void cells. */
  regionCells: number;
  initializedChunks: number;
  chunkVersion: number;
};

type WorldWriterReport = WorldPlacementResult & { ok: boolean };

export function defaultWorldWriterBinary() {
  return sidecarBinary('blockwright-world');
}

function worldWriterBinary(override?: string) {
  return override ? resolve(override) : requireSidecar('blockwright-world');
}

async function requireFile(path: string, label: string) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} not found: ${path}`);
}

export async function validateWorldDirectory(path: string) {
  const world = resolve(path);
  const info = await stat(world).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`World directory not found: ${world}`);
  await requireFile(join(world, 'level.dat'), 'level.dat');
  await requireFile(join(world, 'db', 'CURRENT'), 'Bedrock LevelDB db/CURRENT');
  return world;
}

function timestamp() {
  return new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
}

export async function backupWorld(world: string) {
  const target = join(dirname(world), `${basename(world)}.blockwright-backup-${timestamp()}-${randomUUID().slice(0, 8)}`);
  // `cp` creates the destination itself: pre-creating it made every backup of an
  // existing world fail with EEXIST under `errorOnExist`.
  await cp(world, target, { recursive: true, force: false, errorOnExist: true });
  return target;
}

function u32(value: number) {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32LE(value);
  return result;
}
function i32(value: number) {
  const result = Buffer.allocUnsafe(4);
  result.writeInt32LE(value);
  return result;
}
function text(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
}

/** Preflight used cells without serializing the model or touching a world. */
export function validateDirectStructure(structure: Structure, region: Box): void {
  assertBox(region);
  const ids = new Set<number>();
  structure.forEach((_x, _y, _z, id) => ids.add(id), region);
  for (const id of ids) {
    const state = structure.palette[id];
    if (!state) throw new Error(`Missing palette state ${id}`);
    validateBlockState(state);
  }
}

const DIRECT_STRUCTURE_MAGIC = 'BLKWRDIR';
const DIRECT_STRUCTURE_VERSION = 1;
/**
 * Block records per streamed chunk (1 MiB). The encoder never builds a
 * per-cell object graph: it writes straight into one bounded scratch buffer and
 * hands that buffer to the writer, so peak memory is the palette plus a chunk
 * rather than a copy of the whole placement.
 */
const DIRECT_STRUCTURE_RECORDS = 65536;
const DIRECT_STRUCTURE_RECORD_BYTES = 16;

function paletteEntry(state: State): Buffer {
  const parts: Buffer[] = [text(state.name)];
  const entries = Object.entries(state.states).sort(([a], [b]) => a.localeCompare(b));
  parts.push(u32(entries.length));
  for (const [key, value] of entries) {
    parts.push(text(key));
    if (typeof value === 'string') parts.push(Buffer.from([0]), text(value));
    else if (typeof value === 'number') parts.push(Buffer.from([1]), i32(value));
    else parts.push(Buffer.from([2, value ? 1 : 0]));
  }
  return Buffer.concat(parts);
}

type DirectStructurePlan = {
  /** Magic word through the palette table: everything before the block table. */
  header: Buffer;
  blocks: number;
  remap: Map<number, number>;
};

/**
 * One pass for the used palette, the block count and the header. The count has
 * to be known before the records are produced (the protocol prefixes them), and
 * knowing it up front is what lets a caller preallocate instead of growing.
 */
function directStructurePlan(structure: Structure, region: Box): DirectStructurePlan {
  const ids = new Set<number>();
  let blocks = 0;
  structure.forEach((_x, _y, _z, id) => {
    ids.add(id);
    blocks++;
  }, region);
  const orderedIds = [...ids].sort((a, b) => a - b);
  const palette = orderedIds.map((id) => {
    const state = structure.palette[id];
    if (!state) throw new Error(`Missing palette state ${id}`);
    validateBlockState(state);
    return paletteEntry(state);
  });
  const size = region.max.map((value, axis) => value - region.min[axis]) as [number, number, number];
  const header = Buffer.concat([
    Buffer.from(DIRECT_STRUCTURE_MAGIC),
    u32(DIRECT_STRUCTURE_VERSION),
    ...size.map(i32),
    i32(TARGET.blockVersion),
    u32(palette.length),
    ...palette,
  ]);
  return { header, blocks, remap: new Map(orderedIds.map((id, index) => [id, index + 1])) };
}

/** Block records in bounded chunks, in the same order `Structure.forEach` visits cells. */
function* directStructureRecords(
  structure: Structure,
  region: Box,
  remap: Map<number, number>,
  recordsPerChunk: number,
): Generator<Buffer> {
  const chunkBytes = recordsPerChunk * DIRECT_STRUCTURE_RECORD_BYTES;
  const [minX, minY, minZ] = region.min;
  let scratch = Buffer.allocUnsafe(chunkBytes);
  let offset = 0,
    written = 0;
  // One 16x16 column at a time, in ascending chunk order: the writer holds a
  // single chunk and flushes it when the column changes, so neither side ever
  // keeps the whole placement. Chunk cells stay in storage order, so sorting the
  // chunk list does not reorder records inside a chunk.
  for (const {
    origin: [ox, oy, oz],
    cells,
  } of [...structure.chunksIn(region)].sort(
    (a, b) => a.origin[0] - b.origin[0] || a.origin[2] - b.origin[2] || a.origin[1] - b.origin[1],
  )) {
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i];
      if (!id) continue;
      const x = ox + Math.floor(i / 256),
        y = oy + (Math.floor(i / 16) % 16),
        z = oz + (i % 16);
      if (!contains(region, x, y, z)) continue;
      offset = scratch.writeUInt32LE(x - minX, offset);
      offset = scratch.writeUInt32LE(y - minY, offset);
      offset = scratch.writeUInt32LE(z - minZ, offset);
      offset = scratch.writeUInt32LE(remap.get(id)!, offset);
      if (++written === recordsPerChunk) {
        yield scratch;
        scratch = Buffer.allocUnsafe(chunkBytes);
        offset = 0;
        written = 0;
      }
    }
  }
  if (offset > 0) yield scratch.subarray(0, offset);
}

export type DirectStructureStream = Readonly<{
  /** Cells actually written (non-void), known before the first chunk is produced. */
  blocks: number;
  /** Header, block count and records; each chunk is bounded by `recordsPerChunk`. */
  chunks: Iterable<Buffer>;
}>;

/**
 * Streamed form of the direct writer protocol. The world writer feeds these
 * chunks into the sidecar's stdin, so a placement only ever holds one chunk
 * instead of a buffer as large as the placement itself.
 */
export function directStructureStream(
  structure: Structure,
  region: Box,
  options: { recordsPerChunk?: number } = {},
): DirectStructureStream {
  assertBox(region);
  const recordsPerChunk = options.recordsPerChunk ?? DIRECT_STRUCTURE_RECORDS;
  if (!Number.isSafeInteger(recordsPerChunk) || recordsPerChunk < 1)
    throw new Error(`recordsPerChunk must be a positive integer: ${recordsPerChunk}`);
  const plan = directStructurePlan(structure, region);
  return {
    blocks: plan.blocks,
    chunks: (function* () {
      yield plan.header;
      yield u32(plan.blocks);
      yield* directStructureRecords(structure, region, plan.remap, recordsPerChunk);
    })(),
  };
}

/**
 * Encodes the in-memory model for the direct world writer protocol.
 * This is deliberately not an mcstructure file: the optional exporter remains
 * separate, while new-world imports send the model straight to the sidecar.
 *
 * The payload is one exact-size buffer (no per-cell arrays, no buffer per
 * number). Use `directStructureStream` when the placement is large enough that
 * even one payload buffer is too much.
 */
export function encodeDirectStructure(structure: Structure, region: Box): Buffer {
  assertBox(region);
  const plan = directStructurePlan(structure, region);
  const out = Buffer.allocUnsafe(plan.header.length + 4 + plan.blocks * DIRECT_STRUCTURE_RECORD_BYTES);
  plan.header.copy(out, 0);
  let offset = out.writeUInt32LE(plan.blocks, plan.header.length);
  for (const chunk of directStructureRecords(structure, region, plan.remap, DIRECT_STRUCTURE_RECORDS)) {
    chunk.copy(out, offset);
    offset += chunk.length;
  }
  if (offset !== out.length) throw new Error(`Direct structure payload length mismatch: ${offset} of ${out.length}`);
  return out;
}

function assertAligned(options: Omit<WorldPlacement, 'structure'>) {
  const [x, , z] = options.position;
  if (x % 16 !== 0 || z % 16 !== 0)
    throw new Error('The current bedrock-world placement API requires x and z to be multiples of 16');
}

function placementArgs(options: Omit<WorldPlacement, 'structure'>, world: string, source: string[]) {
  const [x, y, z] = options.position;
  const args = [
    'place',
    '--world',
    world,
    ...source,
    '--x',
    String(x),
    '--y',
    String(y),
    '--z',
    String(z),
    '--dimension',
    String(options.dimension ?? 0),
    '--rotation',
    String(options.rotation ?? 0),
  ];
  if (options.mirrorX) args.push('--mirror-x');
  if (options.mirrorZ) args.push('--mirror-z');
  return args;
}

/**
 * Non-void cells of an mcstructure file, read independently of the sidecar.
 * Accepts both layout versions (version 2 files may carry a single layer).
 */
export function countMcstructureCells(bytes: Buffer) {
  const tree = nbt.parseUncompressed(bytes, 'little') as unknown as {
    value: { structure: { value: { block_indices: unknown } } };
  };
  const [primary = []] = blockIndexLayers(tree.value.structure.value.block_indices);
  let count = 0;
  for (const id of primary) if (id >= 0) count++;
  return count;
}

async function placeDirectStructureInWorld(
  structure: Structure,
  region: Box,
  options: DirectWorldPlacement,
): Promise<WorldPlacementResult> {
  const world = await validateWorldDirectory(options.world);
  assertAligned(options);
  if (options.skipEmptyChunks && (options.rotation || options.mirrorX || options.mirrorZ))
    throw new Error('Skipping empty chunks requires an unrotated, unmirrored direct placement');
  const binary = worldWriterBinary(options.binary);
  // Planning (palette, block count, header) happens here, before the backup and
  // the spawn; the records are produced lazily as the sidecar drains stdin.
  const payload = directStructureStream(structure, region);
  const backupPath = options.backup === false ? undefined : await backupWorld(world);
  const args = placementArgs(options, world, ['--direct-stdin']);
  if (options.skipEmptyChunks) args.push('--skip-empty-chunks');
  const result = await runSidecarJson<WorldWriterReport>(binary, args, 'World writer', payload.chunks);
  return {
    backupPath,
    touchedChunks: result.touchedChunks,
    placedBlocks: payload.blocks,
    regionCells: result.placedBlocks,
    initializedChunks: result.initializedChunks,
    chunkVersion: result.chunkVersion,
  };
}

export async function placeStructureInWorld(options: WorldPlacement): Promise<WorldPlacementResult> {
  const world = await validateWorldDirectory(options.world);
  const structure = resolve(options.structure);
  await requireFile(structure, 'Structure file');
  assertAligned(options);
  const binary = worldWriterBinary(options.binary);
  const backupPath = options.backup === false ? undefined : await backupWorld(world);
  const args = placementArgs(options, world, ['--structure', structure]);
  const result = await runSidecarJson<WorldWriterReport>(binary, args, 'World writer');
  const bytes = await readFile(structure);
  return {
    backupPath,
    touchedChunks: result.touchedChunks,
    placedBlocks: countMcstructureCells(bytes),
    regionCells: result.placedBlocks,
    initializedChunks: result.initializedChunks,
    chunkVersion: result.chunkVersion,
  };
}

export async function writeStructureToWorld(
  structure: Structure,
  region: Box,
  options: DirectWorldPlacement,
) {
  return await placeDirectStructureInWorld(structure, region, options);
}
