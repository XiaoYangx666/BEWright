import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { CHUNK, type Box, type Structure } from '../core/structure.js';
import { atomicWrite } from '../project/paths.js';
import type { MeshData, MeshDiagnostic } from './mesher.js';
import type { LightCacheRef } from './light-cache.js';

/**
 * On-disk mesh cache: one packed file per chunk, written once and reused across
 * builds. Packing matters because the naive form both dominated the build's write
 * time and bloated the cache — it wrote nine files per chunk, each opened with a
 * full mkdir/write/unlink/rename, and stored the mesh as 32 bytes per vertex:
 *
 *   - every quad became six independent vertices, repeating one rectangle's
 *     colour six times;
 *   - block and sky light are integers 0..15 yet took two float32 each;
 *   - a quad's colour is one of a handful of values per chunk yet took 12 bytes.
 *
 * So colours and alphas become small per-chunk tables with one index per vertex,
 * light and sky share a byte, and positions are stored relative to their chunk as
 * scaled int16 whenever that is exact. Every step is verified while packing and
 * falls back to raw float32, so decoding reproduces the mesher's buffers exactly.
 *
 * Layout (little-endian uint32 header, then blocks in this order):
 *   magic | version | positionScale | flags | colorCount | alphaCount |
 *   opaqueVerts | translucentVerts | byteLength
 *   colour table | alpha table |
 *   opaque positions | opaque colour index | opaque light+sky |
 *   translucent positions | translucent colour index | translucent light+sky |
 *   translucent alpha index
 */

/** Buffer order is part of `MeshData` and of what a decoder returns; append only. */
export const MESH_BUFFERS = [
  'positions',
  'colors',
  'lights',
  'skies',
  'translucentPositions',
  'translucentColors',
  'translucentLights',
  'translucentSkies',
  'translucentAlphas',
] as const;

export type MeshBufferName = (typeof MESH_BUFFERS)[number];
export type MeshBuffers = Record<MeshBufferName, Float32Array>;

const MAGIC = 0xb1_0d_1e56;
const HEADER_U32 = 9;
const HEADER_BYTES = HEADER_U32 * 4;
const FLAG_RAW_POSITIONS = 1;
const FLAG_RAW_LIGHT = 2;
const FLAG_RAW_COLORS = 4;
const FLAG_RAW_ALPHAS = 8;

/**
 * Bumped whenever the mesher's output for identical input can change (algorithm,
 * packed layout, material table). A mismatch invalidates every cached entry.
 */
export const MESH_CACHE_VERSION = 7;

/** Positions are chunk-local, so both packing and decoding need the chunk origin. */
export type Origin = readonly number[];

const NEEDS_ORIGIN = 'Mesh positions are chunk-local, so the chunk origin is required';

/** Chunk-local coordinates at one shared scale, or null when that is not exact. */
function scalePositions(buffers: readonly Float32Array[], origin: Origin, scale: number) {
  const scaled: Buffer[] = [];
  for (const source of buffers) {
    const out = new Int16Array(source.length);
    for (let i = 0; i < source.length; i++) {
      const value = (source[i] - origin[i % 3]) * scale;
      const rounded = Math.round(value);
      if (rounded !== value || rounded < -32768 || rounded > 32767) return null;
      out[i] = rounded;
    }
    scaled.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  }
  return scaled;
}

const asBytes = (array: Float32Array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

/**
 * Fixed-point when the chunk allows it, raw float32 otherwise.
 *
 * Representability is monotone in the scale: a coordinate that is exact at some
 * power of two stays exact at every larger one, because `(p - origin) * 2S` is
 * just twice the integer `(p - origin) * S`. So the largest scale that still fits
 * int16 is the only candidate worth trying, and one failed check proves that no
 * scale works. Glass insets are a plain 0.04, which has no exact binary
 * fraction, so decorative chunks fall back while cube-heavy ones stay compact.
 */
function encodePositions(buffers: readonly Float32Array[], origin: Origin) {
  let widest = 0;
  for (const source of buffers)
    for (let i = 0; i < source.length; i++) {
      const local = Math.abs(source[i] - origin[i % 3]);
      if (!(local > widest)) continue;
      widest = local;
    }
  const scale = widest === 0 ? 1 : 2 ** Math.min(30, Math.floor(Math.log2(32767 / widest)));
  if (scale < 1) return { buffers: buffers.map(asBytes), scale: 1, raw: true };
  const scaled = scalePositions(buffers, origin, scale);
  if (scaled) return { buffers: scaled, scale, raw: false };
  return { buffers: buffers.map(asBytes), scale: 1, raw: true };
}

/** Distinct-value table for a channel whose values repeat in long runs. */
function encodeTable(values: Float32Array, stride: number, limit: number) {
  // The index width follows the limit, and the reader must agree on it.
  const keys = limit <= 255 ? new Uint8Array(values.length / stride) : new Uint16Array(values.length / stride);
  const table: number[] = [];
  const distinct = () => table.length / stride;
  const matches = (entry: number, base: number) => {
    for (let channel = 0; channel < stride; channel++)
      if (table[entry * stride + channel] !== values[base + channel]) return false;
    return true;
  };
  // The six vertices of a merged rectangle share one colour, so most lookups are
  // answered by the previous entry; the table itself stays tiny, which makes a
  // scan cheaper than hashing a string key per run.
  let previous = -1;
  for (let i = 0; i < keys.length; i++) {
    const base = i * stride;
    if (previous >= 0 && matches(previous, base)) {
      keys[i] = previous;
      continue;
    }
    let found = -1;
    for (let entry = 0; entry < distinct(); entry++)
      if (matches(entry, base)) {
        found = entry;
        break;
      }
    if (found < 0) {
      if (distinct() >= limit) return null;
      found = distinct();
      for (let channel = 0; channel < stride; channel++) table.push(values[base + channel]);
    }
    previous = found;
    keys[i] = found;
  }
  return { table: Float32Array.from(table), keys };
}

/** float32 of k/15, so a level can be recognised without re-rounding per vertex. */
const LEVELS = Float32Array.from({ length: 16 }, (_, k) => Math.fround(k / 15));

/** Light and sky are always k/15; packing them into one byte must never round. */
function packLightSky(lights: Float32Array, skies: Float32Array) {
  const packed = new Uint8Array(lights.length);
  for (let i = 0; i < lights.length; i++) {
    const level = Math.round(lights[i] * 15);
    const sky = Math.round(skies[i] * 15);
    if (level < 0 || level > 15 || sky < 0 || sky > 15) return null;
    if (lights[i] !== LEVELS[level] || skies[i] !== LEVELS[sky]) return null;
    packed[i] = level * 16 + sky;
  }
  return packed;
}

export function packMeshData(data: MeshData, origin: Origin): Buffer {
  if (origin.length !== 3) throw new Error(NEEDS_ORIGIN);
  const opaqueVerts = data.positions.length / 3;
  const translucentVerts = data.translucentPositions.length / 3;

  // One flag per channel covers both passes, so a channel is either compact or
  // raw as a whole.
  const opaqueColors = encodeTable(data.colors, 3, 65535);
  const translucentColors = encodeTable(data.translucentColors, 3, 65535);
  const colorTable =
    opaqueColors && translucentColors ? { opaque: opaqueColors, translucent: translucentColors } : null;
  const alphas = encodeTable(data.translucentAlphas, 1, 255);
  const opaqueLight = packLightSky(data.lights, data.skies);
  const translucentLight = packLightSky(data.translucentLights, data.translucentSkies);
  const positions = encodePositions([data.positions, data.translucentPositions], origin);
  let flags = 0;
  if (positions.raw) flags |= FLAG_RAW_POSITIONS;
  if (!opaqueLight || !translucentLight) flags |= FLAG_RAW_LIGHT;
  if (!colorTable) flags |= FLAG_RAW_COLORS;
  if (!alphas) flags |= FLAG_RAW_ALPHAS;

  // One colour table serves both passes: opaque and translucent share a palette.
  const colors =
    colorTable === null
      ? null
      : {
          table: Float32Array.from([...colorTable.opaque.table, ...colorTable.translucent.table]),
          opaqueIndex: colorTable.opaque.keys,
          translucentIndex: Uint16Array.from(
            colorTable.translucent.keys,
            (value) => value + colorTable.opaque.table.length / 3,
          ),
        };
  const lightBytes = (packed: Uint8Array | null, levels: Float32Array, skies: Float32Array) =>
    packed
      ? Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength)
      : Buffer.concat([asBytes(levels), asBytes(skies)]);
  const blocks = [
    colors ? Buffer.from(colors.table.buffer, colors.table.byteOffset, colors.table.byteLength) : Buffer.alloc(0),
    alphas ? asBytes(alphas.table) : Buffer.alloc(0),
    positions.buffers[0]!,
    colors
      ? Buffer.from(colors.opaqueIndex.buffer, colors.opaqueIndex.byteOffset, colors.opaqueIndex.byteLength)
      : asBytes(data.colors),
    lightBytes(opaqueLight, data.lights, data.skies),
    positions.buffers[1]!,
    colors
      ? Buffer.from(
          colors.translucentIndex.buffer,
          colors.translucentIndex.byteOffset,
          colors.translucentIndex.byteLength,
        )
      : asBytes(data.translucentColors),
    lightBytes(translucentLight, data.translucentLights, data.translucentSkies),
    alphas
      ? Buffer.from(alphas.keys.buffer, alphas.keys.byteOffset, alphas.keys.byteLength)
      : asBytes(data.translucentAlphas),
  ];
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(MESH_CACHE_VERSION, 4);
  header.writeUInt32LE(positions.scale, 8);
  header.writeUInt32LE(flags, 12);
  header.writeUInt32LE(colors ? colors.table.length / 3 : 0, 16);
  header.writeUInt32LE(alphas ? alphas.table.length : 0, 20);
  header.writeUInt32LE(opaqueVerts, 24);
  header.writeUInt32LE(translucentVerts, 28);
  header.writeUInt32LE(HEADER_BYTES + blocks.reduce((total, block) => total + block.length, 0), 32);
  return Buffer.concat([header, ...blocks]);
}

/** Inverse of `packMeshData`, in TypeScript. Kept in step with the browser reader
 *  by a test that decodes the same chunk through both. */
export function unpackMeshData(buffer: Buffer | Uint8Array, origin: Origin): MeshBuffers {
  if (origin.length !== 3) throw new Error(NEEDS_ORIGIN);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER_BYTES || view.getUint32(0, true) !== MAGIC)
    throw new Error('Not a blockwright mesh chunk');
  if (view.getUint32(4, true) !== MESH_CACHE_VERSION)
    throw new Error(`Mesh cache version mismatch: found ${view.getUint32(4, true)}, expected ${MESH_CACHE_VERSION}`);
  if (view.getUint32(32, true) !== bytes.byteLength) throw new Error('Truncated mesh chunk');
  const scale = view.getUint32(8, true);
  const flags = view.getUint32(12, true);
  const colorCount = view.getUint32(16, true);
  const alphaCount = view.getUint32(20, true);
  const opaqueVerts = view.getUint32(24, true);
  const translucentVerts = view.getUint32(28, true);

  let offset = HEADER_BYTES;
  /** Copies, so later blocks stay aligned and outlive the source buffer. */
  const take = (byteLength: number) => {
    const slice = bytes.slice(offset, offset + byteLength);
    offset += byteLength;
    return slice;
  };
  const colorTable = new Float32Array(take(colorCount * 12).buffer);
  const alphaTable = new Float32Array(take(alphaCount * 4).buffer);
  const readPositions = (count: number) => {
    if (flags & FLAG_RAW_POSITIONS) return new Float32Array(take(count * 12).buffer);
    const local = new Int16Array(take(count * 6).buffer);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < out.length; i++) out[i] = origin[i % 3] + local[i] / scale;
    return out;
  };
  const readColors = (count: number) => {
    if (flags & FLAG_RAW_COLORS) return new Float32Array(take(count * 12).buffer);
    const index = new Uint16Array(take(count * 2).buffer);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++)
      for (let channel = 0; channel < 3; channel++) out[i * 3 + channel] = colorTable[index[i] * 3 + channel];
    return out;
  };
  const readLight = (count: number, prefix: 'lights' | 'translucentLights') => {
    const levels = new Float32Array(count);
    const skies = new Float32Array(count);
    if (flags & FLAG_RAW_LIGHT) {
      levels.set(new Float32Array(take(count * 8).buffer, 0, count));
      skies.set(new Float32Array(take(count * 8).buffer, 0, count));
    } else {
      const packed = take(count);
      for (let i = 0; i < count; i++) {
        levels[i] = Math.fround((packed[i] >> 4) / 15);
        skies[i] = Math.fround((packed[i] & 15) / 15);
      }
    }
    void prefix;
    return { levels, skies };
  };

  const result = {} as MeshBuffers;
  result.positions = readPositions(opaqueVerts);
  result.colors = readColors(opaqueVerts);
  const opaqueLight = readLight(opaqueVerts, 'lights');
  result.lights = opaqueLight.levels;
  result.skies = opaqueLight.skies;
  result.translucentPositions = readPositions(translucentVerts);
  result.translucentColors = readColors(translucentVerts);
  const translucentLight = readLight(translucentVerts, 'translucentLights');
  result.translucentLights = translucentLight.levels;
  result.translucentSkies = translucentLight.skies;
  if (flags & FLAG_RAW_ALPHAS) result.translucentAlphas = new Float32Array(take(translucentVerts * 4).buffer);
  else {
    const index = take(translucentVerts);
    const out = new Float32Array(translucentVerts);
    for (let i = 0; i < out.length; i++) out[i] = alphaTable[index[i]];
    result.translucentAlphas = out;
  }
  return result;
}

/**
 * Browser-side reader, injected into both preview pages so the format has a
 * second implementation only where one is unavoidable. A test evaluates this
 * source and checks it against `unpackMeshData` on real chunks.
 */
export function meshChunkDecoderSource() {
  return `const chunkOriginFor = (prefix) => {
  // Prefixes end in \`<mesh prefix>.<cx>,<cy>,<cz>\`, so the key follows the last dot.
  const base = prefix.slice(prefix.lastIndexOf('/') + 1);
  const parts = base.slice(base.lastIndexOf('.') + 1).split(',');
  return [Number(parts[0]) * ${CHUNK}, Number(parts[1]) * ${CHUNK}, Number(parts[2]) * ${CHUNK}];
};
const decodeMeshChunk = (bytes, origin) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < ${HEADER_BYTES} || view.getUint32(0, true) !== ${MAGIC}) return null;
  if (view.getUint32(4, true) !== ${MESH_CACHE_VERSION}) throw new Error('Stale mesh chunk: rebuild it');
  if (view.getUint32(32, true) !== bytes.byteLength) throw new Error('Truncated mesh chunk');
  const scale = view.getUint32(8, true), flags = view.getUint32(12, true);
  const colorCount = view.getUint32(16, true), alphaCount = view.getUint32(20, true);
  const opaqueVerts = view.getUint32(24, true), translucentVerts = view.getUint32(28, true);
  let offset = ${HEADER_BYTES};
  const take = (byteLength) => {
    const slice = bytes.slice(offset, offset + byteLength);
    offset += byteLength;
    return slice;
  };
  const colorTable = new Float32Array(take(colorCount * 12).buffer);
  const alphaTable = new Float32Array(take(alphaCount * 4).buffer);
  const readPositions = (count) => {
    if (flags & ${FLAG_RAW_POSITIONS}) return new Float32Array(take(count * 12).buffer);
    const local = new Int16Array(take(count * 6).buffer);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < out.length; i++) out[i] = origin[i % 3] + local[i] / scale;
    return out;
  };
  const readColors = (count) => {
    if (flags & ${FLAG_RAW_COLORS}) return new Float32Array(take(count * 12).buffer);
    const index = new Uint16Array(take(count * 2).buffer);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++)
      for (let channel = 0; channel < 3; channel++) out[i * 3 + channel] = colorTable[index[i] * 3 + channel];
    return out;
  };
  const readLight = (count) => {
    const levels = new Float32Array(count), skies = new Float32Array(count);
    if (flags & ${FLAG_RAW_LIGHT}) {
      levels.set(new Float32Array(take(count * 8).buffer, 0, count));
      skies.set(new Float32Array(take(count * 8).buffer, 0, count));
    } else {
      const packed = take(count);
      for (let i = 0; i < count; i++) {
        levels[i] = Math.fround((packed[i] >> 4) / 15);
        skies[i] = Math.fround((packed[i] & 15) / 15);
      }
    }
    return { levels, skies };
  };
  const result = {};
  result.positions = readPositions(opaqueVerts);
  result.colors = readColors(opaqueVerts);
  const opaqueLight = readLight(opaqueVerts);
  result.lights = opaqueLight.levels;
  result.skies = opaqueLight.skies;
  result.translucentPositions = readPositions(translucentVerts);
  result.translucentColors = readColors(translucentVerts);
  const translucentLight = readLight(translucentVerts);
  result.translucentLights = translucentLight.levels;
  result.translucentSkies = translucentLight.skies;
  if (flags & ${FLAG_RAW_ALPHAS}) result.translucentAlphas = new Float32Array(take(translucentVerts * 4).buffer);
  else {
    const index = take(translucentVerts);
    const out = new Float32Array(translucentVerts);
    for (let i = 0; i < out.length; i++) out[i] = alphaTable[index[i]];
    result.translucentAlphas = out;
  }
  return result;
};`;
}

export type CachedView = {
  /** File-name prefix shared by every chunk of this mesh, relative to the cache directory. */
  prefix: string;
  chunks: string[];
  quads: number;
  bytes: number;
  diagnostics: MeshDiagnostic[];
  config?: string;
  parts?: Record<string, { prefix: string; quads: number; diagnostics: MeshDiagnostic[] }>;
};

export type MeshCacheIndex = {
  version: number;
  views: Record<string, CachedView>;
  world?: { palette: string; chunks: Record<string, string> };
  light?: LightCacheRef;
};

export const MESH_INDEX_FILE = 'index.json';

export function emptyMeshCacheIndex(): MeshCacheIndex {
  return { version: MESH_CACHE_VERSION, views: {} };
}

/**
 * Content fingerprint of everything a view's meshes are derived from. Two views
 * with the same fingerprint produce byte-identical meshes, so they share one
 * packed prefix on disk and only one of them is ever meshed.
 *
 * Lighting samples the whole structure, not just the meshed region, so the world
 * hash always covers every chunk. That makes the fingerprint conservative — an
 * edit outside a view still re-meshes it — but never wrong.
 */
export function meshFingerprint(world: Structure, region: Box, style: Readonly<Record<string, string>>, lit: boolean) {
  const hash = createHash('sha256');
  hash.update(`v${MESH_CACHE_VERSION}|r${region.min.join(',')}:${region.max.join(',')}|l${lit ? 1 : 0}|s`);
  for (const name of Object.keys(style).sort()) hash.update(`${name}=${style[name]};`);
  // Chunk keys sort lexicographically, which is stable regardless of insertion order.
  for (const key of [...world.chunks.keys()].sort()) {
    hash.update(key);
    hash.update(
      Buffer.from(world.chunks.get(key)!.cells.buffer, world.chunks.get(key)!.cells.byteOffset, CHUNK ** 3 * 2),
    );
  }
  return hash.digest('hex').slice(0, 16);
}

export function meshConfigFingerprint(region: Box, style: Readonly<Record<string, string>>, lit: boolean) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([region, Object.entries(style).sort(([a], [b]) => a.localeCompare(b)), lit]));
  return hash.digest('hex').slice(0, 16);
}

export function meshWorldSignature(world: Structure) {
  const palette = createHash('sha256').update(JSON.stringify(world.palette)).digest('hex');
  const codes = world.palette.map((state) => createHash('sha256').update(JSON.stringify(state)).digest());
  const chunks: Record<string, string> = {};
  for (const [key, chunk] of world.chunks) {
    const semantic = Buffer.allocUnsafe(chunk.cells.length * 8);
    for (let i = 0; i < chunk.cells.length; i++) codes[chunk.cells[i]].copy(semantic, i * 8, 0, 8);
    chunks[key] = createHash('sha256').update(semantic).digest('hex').slice(0, 16);
  }
  return { palette, chunks };
}

/** Live prefixes and file names in a mesh cache directory, for index validation. */
export async function readMeshCacheDir(cacheDir: string): Promise<{ index: MeshCacheIndex; files: Set<string> }> {
  const files = new Set<string>(await readdir(cacheDir).catch(() => [] as string[]));
  if (!files.has(MESH_INDEX_FILE)) return { index: emptyMeshCacheIndex(), files };
  try {
    const index = JSON.parse(await readFile(join(cacheDir, MESH_INDEX_FILE), 'utf8')) as MeshCacheIndex;
    if (index.version !== MESH_CACHE_VERSION) return { index: emptyMeshCacheIndex(), files };
    return { index, files };
  } catch {
    // A corrupt index is a cache miss, never a build failure.
    return { index: emptyMeshCacheIndex(), files };
  }
}

export function cachedViewUsable(view: CachedView | undefined, files: ReadonlySet<string>): view is CachedView {
  if (!view) return false;
  return view.chunks.every((key) => files.has(`${view.parts?.[key]?.prefix ?? view.prefix}.${key}.bin`));
}

/** Writes `<baseName>.bin`; the caller composes the base name and reuses it as
 *  the prefix it records in `chunkFiles`, so writer and reader cannot drift. */
export async function writePackedMesh(cacheDir: string, baseName: string, data: MeshData, origin: Origin) {
  const buffer = packMeshData(data, origin);
  await atomicWrite(join(cacheDir, `${baseName}.bin`), buffer);
  return buffer.length;
}

/**
 * Writing is a cold build's largest single cost, and the filesystem prefers a
 * queue over one awaited file at a time. Kept bounded so a huge model cannot
 * hold thousands of packed buffers at once.
 */
export const WRITE_CONCURRENCY = 16;

export async function writePackedMeshes(
  cacheDir: string,
  items: readonly { baseName: string; data: MeshData; origin: Origin }[],
  concurrency = WRITE_CONCURRENCY,
) {
  let bytes = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      bytes += await writePackedMesh(cacheDir, item.baseName, item.data, item.origin);
    }
  });
  await Promise.all(workers);
  return bytes;
}

export async function writeMeshCacheIndex(cacheDir: string, index: MeshCacheIndex) {
  await atomicWrite(join(cacheDir, MESH_INDEX_FILE), JSON.stringify(index, null, 2));
}

/** Packed chunk names are `m<16 hex>.<chunk key>.bin`. */
const PACKED_NAME = /^m[0-9a-f]{16}\..*\.bin$/;
/** Pre-packed layout wrote one file per buffer; recognised so it is reclaimed. */
const LEGACY_NAME = new RegExp(
  `\\.(?:${['positions', 'colors', 'lights', 'skies', 'translucentPositions', 'translucentColors', 'translucentLights', 'translucentSkies', 'translucentAlphas'].join('|')})\\.bin$`,
);

/**
 * Drop packed chunks and legacy per-buffer files that the current index no
 * longer references, so the cache tracks its content instead of growing.
 * Only files matching this cache's own naming are touched, so a directory shared
 * with other content is never collateral damage.
 */
export async function pruneMeshCache(cacheDir: string, files: ReadonlySet<string>, index: MeshCacheIndex) {
  const live = new Set([MESH_INDEX_FILE]);
  for (const view of Object.values(index.views)) for (const key of view.chunks) live.add(`${view.parts?.[key]?.prefix ?? view.prefix}.${key}.bin`);
  await Promise.all(
    [...files]
      .filter((file) => !live.has(file) && (PACKED_NAME.test(file) || LEGACY_NAME.test(file)))
      .map((file) => rm(join(cacheDir, file), { force: true })),
  );
}

/** Scene-relative prefix for a packed chunk, e.g. `cache/meshes/<id>/m1a2b.<key>`. */
export function meshChunkPrefix(projectRoot: string, cacheDir: string, prefix: string, key: string) {
  return relative(projectRoot, join(cacheDir, `${prefix}.${key}`)).replaceAll('\\', '/');
}

/** Chunk key (`cx,cy,cz`) to its world-space origin, for the position codec. */
export function chunkOrigin(key: string): number[] {
  const [cx, cy, cz] = key.split(',').map(Number);
  return [cx * CHUNK, cy * CHUNK, cz * CHUNK];
}
