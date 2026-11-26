import { CHUNK, type Structure, type State } from '../core/structure.js';
import { registryBlock } from '../blocks/registry.js';

/**
 * Two-channel voxel light for the preview, driven by the pinned Bedrock
 * registry: `emitLight` seeds block light, `filterLight >= 15` blocks
 * propagation and any lower value is the per-cell attenuation cost.
 * Sky light is a second channel: direct columns run from the top of the
 * bounding volume down to the first opaque cell (attenuating through water
 * and foliage), then flood sideways under overhangs. Block light repairs
 * incrementally; opacity edits repair nearby sky columns, while chunk extent
 * changes recompute the whole sky field.
 */

/** Registry-driven emission with the few state-aware exceptions Bedrock encodes as states. */
export function lightEmission(state: State): number {
  const name = state.name.replace(/^minecraft:/, '');
  let emit: number;
  try {
    emit = registryBlock(name).emitLight;
  } catch {
    return 0; // Unknown names stay dark; the support gate reports them elsewhere.
  }
  if (!emit) {
    // Candles are dark by default and only emit while lit; brighter with more candles.
    if (/^(?:[a-z]+_)?candle$/.test(name) && state.states.lit === true)
      return Math.min(15, 3 * (Number(state.states.candles ?? 0) + 1));
    return 0;
  }
  if ((name === 'campfire' || name === 'soul_campfire') && state.states.extinguished === true) return 0;
  if (name === 'sea_pickle')
    return state.states.dead_bit === true ? 0 : Math.min(15, 6 + 3 * Number(state.states.cluster_count ?? 0));
  return emit;
}

/** Registry filterLight; >= 15 means the cell blocks light entirely. */
export function lightOpacity(state: State): number {
  try {
    return registryBlock(state.name.replace(/^minecraft:/, '')).filterLight;
  } catch {
    return 0; // Unknown names never block the preview's light.
  }
}

const OPAQUE = 255;
const AIR_COST = 1;
export type LightFieldSnapshot = Readonly<{
  version: 1;
  block: readonly (readonly [string, Uint8Array])[];
  sky: readonly (readonly [string, Uint8Array])[];
  signatures: readonly (readonly [string, Uint8Array])[];
}>;
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const localIndex = (x: number, y: number, z: number, cx: number, cy: number, cz: number) =>
  ((x - cx * CHUNK) * CHUNK + (y - cy * CHUNK)) * CHUNK + (z - cz * CHUNK);
const chunkKey = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;

/** Growable FIFO of fixed-stride int records; reuses one buffer without per-item allocation. */
class Int32Queue {
  private data = new Int32Array(1 << 14);
  private head = 0;
  private tail = 0;
  constructor(private readonly stride: number) {}
  get size() {
    return (this.tail - this.head) / this.stride;
  }
  push(a: number, b: number, c: number, d?: number) {
    if (this.tail + this.stride > this.data.length) this.compact();
    this.data[this.tail++] = a;
    this.data[this.tail++] = b;
    this.data[this.tail++] = c;
    if (d !== undefined) this.data[this.tail++] = d;
  }
  pop(target: number[]) {
    const base = this.head;
    this.head += this.stride;
    for (let i = 0; i < this.stride; i++) target[i] = this.data[base + i];
  }
  private compact() {
    const live = this.tail - this.head;
    const grown = new Int32Array(live + this.stride <= this.data.length
      ? this.data.length
      : Math.max(this.data.length * 2, live + this.stride * 64));
    grown.set(this.data.subarray(this.head, this.tail));
    this.data = grown;
    this.head = 0;
    this.tail = live;
  }
}

/**
 * Persistent per-chunk light grids for both channels. `compute` runs the full
 * baseline (block sources + sky columns and flood); `applyWorld` repairs block
 * light with removal/addition queues and repairs sky light when opacity changes.
 */
export class LightField {
  private readonly cost = new Map<string, Uint8Array>();
  private readonly block = new Map<string, Uint8Array>();
  private sky = new Map<string, Uint8Array>();
  private readonly cellSignatures = new Map<string, Uint8Array>();
  private world: Structure;
  private emitCache = new Uint8Array(1);
  private costCache = new Uint8Array(1);
  private readonly dirty = new Set<string>();
  private memoKey = '';
  private memoBlock: Uint8Array | undefined;
  private memoSky: Uint8Array | undefined;
  private memoCost: Uint8Array | undefined;

  private constructor(world: Structure) {
    this.world = world;
    this.refreshPalette();
  }

  /** Full baseline: every registered source, every sky column. */
  static compute(world: Structure): LightField {
    const field = new LightField(world);
    const signatures = field.signatures();
    for (const [key, chunk] of world.chunks) {
      field.installCost(key, chunk.cells);
      const grid = new Uint8Array(CHUNK ** 3);
      for (let i = 0; i < grid.length; i++) grid[i] = signatures[chunk.cells[i]];
      field.cellSignatures.set(key, grid);
    }
    const queue = new Int32Queue(3);
    for (const chunk of world.chunks.values())
      for (let i = 0; i < chunk.cells.length; i++) {
        const emit = field.emitCache[chunk.cells[i]];
        if (!emit) continue;
        const x = chunk.origin[0] + Math.floor(i / 256),
          y = chunk.origin[1] + (Math.floor(i / 16) % 16),
          z = chunk.origin[2] + (i % 16);
        field.write(x, y, z, emit, false);
        queue.push(x, y, z);
      }
    field.flood(queue);
    field.recomputeSky();
    field.dirty.clear();
    return field;
  }

  snapshot(): LightFieldSnapshot {
    const copy = (map: Map<string, Uint8Array>) => [...map].map(([key, grid]) => [key, grid.slice()] as const);
    return { version: 1, block: copy(this.block), sky: copy(this.sky), signatures: copy(this.cellSignatures) };
  }

  static fromSnapshot(world: Structure, snapshot: LightFieldSnapshot): LightField {
    if (snapshot.version !== 1) throw new Error('Unsupported light snapshot');
    const field = new LightField(world);
    const restore = (entries: readonly (readonly [string, Uint8Array])[], target: Map<string, Uint8Array>) => {
      for (const [key, grid] of entries) {
        if (!/^[-\d]+,[-\d]+,[-\d]+$/.test(key) || !(grid instanceof Uint8Array) || grid.length !== CHUNK ** 3 || target.has(key))
          throw new Error('Invalid light snapshot grid');
        target.set(key, grid.slice());
      }
    };
    restore(snapshot.block, field.block);
    restore(snapshot.sky, field.sky);
    restore(snapshot.signatures, field.cellSignatures);
    for (const [key, signatures] of field.cellSignatures) {
      const costs = new Uint8Array(CHUNK ** 3);
      for (let i = 0; i < costs.length; i++) costs[i] = (signatures[i] & 15) === 15 ? OPAQUE : (signatures[i] & 15);
      field.cost.set(key, costs);
    }
    return field;
  }

  /**
   * Swap in a rebuilt model and repair the field. `changed` lists chunk keys
   * whose placed content differs (added, removed or edited). Returns the chunk
   * keys whose light values actually changed; callers remesh those chunks.
   */
  applyWorld(world: Structure, changed: Iterable<string>): Set<string> {
    this.dirty.clear();
    const changedKeys = [...changed];
    this.world = world;
    this.refreshPalette();
    const newSig = this.signatures();

    // Voxel-level diff, expressed against the new palette so only light-relevant
    // edits (emission or filter change) enqueue repair work. A missing previous
    // model (first repair after a failed publish) diffs against plain air.
    const changedVoxels: number[] = [];
    let opacityChanged = false;
    let chunkTopologyChanged = false;
    for (const key of changedKeys) {
      const next = world.chunks.get(key);
      const previous = this.cellSignatures.get(key);
      if (!previous && !next) continue;
      if (!previous || !next) chunkTopologyChanged = true;
      if (next) this.installCost(key, next.cells);
      else this.cost.delete(key); // The light grid stays readable so removal can unwind through it.
      const [cx, cy, cz] = key.split(',').map(Number);
      const origin = next?.origin ?? [cx * CHUNK, cy * CHUNK, cz * CHUNK];
      const cellsNext = next?.cells;
      const nextSignatures = next ? new Uint8Array(CHUNK ** 3) : undefined;
      for (let i = 0; i < CHUNK ** 3; i++) {
        const before = previous?.[i] ?? AIR_COST;
        const after = cellsNext ? newSig[cellsNext[i]] : AIR_COST;
        if (nextSignatures) nextSignatures[i] = after;
        if (before === after) continue;
        if ((before & 15) !== (after & 15)) opacityChanged = true;
        changedVoxels.push(
          origin[0] + Math.floor(i / 256),
          origin[1] + (Math.floor(i / 16) % 16),
          origin[2] + (i % 16),
        );
      }
      if (nextSignatures) this.cellSignatures.set(key, nextSignatures);
      else this.cellSignatures.delete(key);
    }

    // Phase 1: clear every edited cell before unwinding, so removal passes see
    // one consistent set of holes instead of reacting to each other.
    const removal = new Int32Queue(4);
    for (let i = 0; i < changedVoxels.length; i += 3) {
      const [x, y, z] = [changedVoxels[i], changedVoxels[i + 1], changedVoxels[i + 2]];
      const level = this.levelAt(x, y, z);
      if (!level) continue;
      this.write(x, y, z, 0, true);
      removal.push(x, y, z, level);
    }
    // Phase 2: unwind the removed field; cells fed from elsewhere become seeds.
    const seeds = new Int32Queue(3);
    const record = [0, 0, 0, 0];
    while (removal.size) {
      removal.pop(record);
      const [x, y, z, oldLevel] = record;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx,
          ny = y + dy,
          nz = z + dz;
        const level = this.levelAt(nx, ny, nz);
        if (!level) continue;
        if (level < oldLevel) {
          this.write(nx, ny, nz, 0, true);
          removal.push(nx, ny, nz, level);
        } else seeds.push(nx, ny, nz);
      }
    }
    // Phase 3: re-seed edited cells from their own emission and their neighbors.
    for (let i = 0; i < changedVoxels.length; i += 3) {
      const x = changedVoxels[i],
        y = changedVoxels[i + 1],
        z = changedVoxels[i + 2];
      const id = this.world.getId(x, y, z);
      const emit = this.emitCache[id];
      if (emit > this.levelAt(x, y, z)) {
        this.write(x, y, z, emit, true);
        seeds.push(x, y, z);
      }
      const cost = this.costAt(x, y, z);
      if (cost >= OPAQUE) continue;
      let best = 0;
      for (const [dx, dy, dz] of NEIGHBORS)
        best = Math.max(best, this.levelAt(x + dx, y + dy, z + dz) - Math.max(AIR_COST, cost));
      if (best > this.levelAt(x, y, z)) {
        this.write(x, y, z, best, true);
        seeds.push(x, y, z);
      }
    }
    // Phase 4: flood the re-added light through the new costs.
    this.flood(seeds);
    // Sky light depends on opacity and on the model's chunk extent. Rebuilding
    // the Structure object alone does not change either one.
    if (opacityChanged || chunkTopologyChanged) this.recomputeSky(chunkTopologyChanged ? undefined : changedKeys);
    return new Set(this.dirty);
  }

  /** Block light 0..15 at a voxel; cells outside every grid read as dark air. */
  at(x: number, y: number, z: number): number {
    return this.levelAt(x, y, z);
  }

  /** Sky light 0..15 at a voxel. Fractional coordinates (box faces sample at
   *  half-block planes) floor into the containing cell. */
  skyAt(x: number, y: number, z: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const cx = Math.floor(x / CHUNK),
      cy = Math.floor(y / CHUNK),
      cz = Math.floor(z / CHUNK);
    const key = chunkKey(cx, cy, cz);
    if (key !== this.memoKey) this.memoize(key);
    return this.memoSky?.[localIndex(x, y, z, cx, cy, cz)] ?? 0;
  }

  private refreshPalette() {
    const palette = this.world.palette;
    this.emitCache = new Uint8Array(palette.length);
    this.costCache = new Uint8Array(palette.length);
    this.costCache[0] = AIR_COST;
    for (let id = 1; id < palette.length; id++) {
      const state = palette[id]!;
      this.emitCache[id] = lightEmission(state);
      const filter = lightOpacity(state);
      this.costCache[id] = filter >= 15 ? OPAQUE : Math.max(AIR_COST, filter);
    }
  }

  /** Per-palette signature so palette renumbering never fabricates light edits. */
  private signatures(): Uint8Array {
    const sig = new Uint8Array(this.emitCache.length);
    for (let id = 0; id < sig.length; id++)
      sig[id] = this.emitCache[id] * 16 + Math.min(15, this.costCache[id] || AIR_COST);
    return sig;
  }

  private installCost(key: string, cells: Uint16Array) {
    const grid = new Uint8Array(CHUNK ** 3);
    for (let i = 0; i < grid.length; i++) grid[i] = this.costCache[cells[i]];
    this.cost.set(key, grid);
    this.memoKey = '';
  }

  private memoize(key: string) {
    this.memoKey = key;
    this.memoBlock = this.block.get(key);
    this.memoSky = this.sky.get(key);
    this.memoCost = this.cost.get(key);
  }

  private levelAt(x: number, y: number, z: number): number {
    // Box geometry samples at fractional planes (half slabs, stairs); floor
    // into the containing voxel or the typed-array read silently reads 0.
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const cx = Math.floor(x / CHUNK),
      cy = Math.floor(y / CHUNK),
      cz = Math.floor(z / CHUNK);
    const key = chunkKey(cx, cy, cz);
    if (key !== this.memoKey) this.memoize(key);
    return this.memoBlock?.[localIndex(x, y, z, cx, cy, cz)] ?? 0;
  }

  private costAt(x: number, y: number, z: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const cx = Math.floor(x / CHUNK),
      cy = Math.floor(y / CHUNK),
      cz = Math.floor(z / CHUNK);
    const key = chunkKey(cx, cy, cz);
    if (key !== this.memoKey) this.memoize(key);
    return this.memoCost?.[localIndex(x, y, z, cx, cy, cz)] ?? AIR_COST;
  }

  private write(x: number, y: number, z: number, level: number, track: boolean) {
    const cx = Math.floor(x / CHUNK),
      cy = Math.floor(y / CHUNK),
      cz = Math.floor(z / CHUNK);
    const key = chunkKey(cx, cy, cz);
    let grid = key === this.memoKey ? this.memoBlock : this.block.get(key);
    if (!grid) {
      grid = new Uint8Array(CHUNK ** 3);
      this.block.set(key, grid);
      this.memoKey = '';
    }
    grid[localIndex(x, y, z, cx, cy, cz)] = level;
    if (track) this.mark(x, y, z);
  }

  /** A changed voxel also changes the faces of blocks sampling it, which live
   *  in this chunk or, on a boundary, the axis-adjacent chunk. */
  private mark(x: number, y: number, z: number) {
    const cx = Math.floor(x / CHUNK),
      cy = Math.floor(y / CHUNK),
      cz = Math.floor(z / CHUNK);
    this.dirty.add(chunkKey(cx, cy, cz));
    const lx = x - cx * CHUNK,
      ly = y - cy * CHUNK,
      lz = z - cz * CHUNK;
    if (lx === 0) this.dirty.add(chunkKey(cx - 1, cy, cz));
    if (lx === CHUNK - 1) this.dirty.add(chunkKey(cx + 1, cy, cz));
    if (ly === 0) this.dirty.add(chunkKey(cx, cy - 1, cz));
    if (ly === CHUNK - 1) this.dirty.add(chunkKey(cx, cy + 1, cz));
    if (lz === 0) this.dirty.add(chunkKey(cx, cy, cz - 1));
    if (lz === CHUNK - 1) this.dirty.add(chunkKey(cx, cy, cz + 1));
  }

  /** Standard monotonic flood: spread while the target cell gains level. */
  private flood(queue: Int32Queue) {
    const record = [0, 0, 0];
    while (queue.size) {
      queue.pop(record);
      const [x, y, z] = record;
      const level = this.levelAt(x, y, z);
      if (level <= AIR_COST) continue;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx,
          ny = y + dy,
          nz = z + dz;
        const cost = this.costAt(nx, ny, nz);
        if (cost >= OPAQUE) continue;
        const target = level - Math.max(AIR_COST, cost);
        if (target > this.levelAt(nx, ny, nz)) {
          this.write(nx, ny, nz, target, true);
          queue.push(nx, ny, nz);
        }
      }
    }
  }

  /**
   * Recompute the sky channel over the bounding volume plus one shell chunk,
   * or a changed-chunk window with two halo columns on each side.
   * Direct columns run from the top with level 15, staying free while the cell
   * above is 15 and the cost is plain air, attenuating through anything else;
   * the flood then spreads sideways under overhangs. The whole channel is
   * replaced and diffed against the previous one in the affected region, so
   * callers keep exact dirty chunks without incremental sky bookkeeping.
   */
  private recomputeSky(changed?: readonly string[]) {
    let minCx = Infinity,
      maxCx = -Infinity,
      minCy = Infinity,
      maxCy = -Infinity,
      minCz = Infinity,
      maxCz = -Infinity;
    for (const chunk of this.world.chunks.values()) {
      const [ox, oy, oz] = chunk.origin;
      minCx = Math.min(minCx, ox / CHUNK);
      maxCx = Math.max(maxCx, ox / CHUNK);
      minCy = Math.min(minCy, oy / CHUNK);
      maxCy = Math.max(maxCy, oy / CHUNK);
      minCz = Math.min(minCz, oz / CHUNK);
      maxCz = Math.max(maxCz, oz / CHUNK);
    }
    if (minCx === Infinity) {
      this.sky = new Map();
      this.memoKey = '';
      return;
    }
    // A changed opacity can affect its direct sky column and at most 15
    // horizontal steps of flood. Two halo chunks keep the old field at the
    // boundary unchanged; those values seed light entering the local region.
    const local = changed?.length && changed.length <= 256
      ? changed.map((key) => key.split(',').map(Number))
      : undefined;
    const minX = Math.max((minCx - 1) * CHUNK, local ? (Math.min(...local.map((c) => c[0])) - 2) * CHUNK : -Infinity),
      maxX = Math.min((maxCx + 2) * CHUNK - 1, local ? (Math.max(...local.map((c) => c[0])) + 3) * CHUNK - 1 : Infinity);
    const minZ = Math.max((minCz - 1) * CHUNK, local ? (Math.min(...local.map((c) => c[2])) - 2) * CHUNK : -Infinity),
      maxZ = Math.min((maxCz + 2) * CHUNK - 1, local ? (Math.max(...local.map((c) => c[2])) + 3) * CHUNK - 1 : Infinity);
    const topY = (maxCy + 2) * CHUNK - 1,
      bottomY = (minCy - 1) * CHUNK;
    const spanX = maxX - minX + 1,
      spanZ = maxZ - minZ + 1;
    // Lowest y of each column's top 15-run; below it every cell is darker.
    const runs = new Int32Array(spanX * spanZ);
    const next = new Map<string, Uint8Array>();
    let cacheKey = '',
      cacheArr: Uint8Array | undefined;
    const cell = (x: number, y: number, z: number) => {
      const key = chunkKey(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK));
      if (key !== cacheKey) {
        cacheKey = key;
        cacheArr = next.get(key);
        if (!cacheArr) {
          cacheArr = new Uint8Array(CHUNK ** 3);
          next.set(key, cacheArr);
        }
      }
      return cacheArr;
    };
    // Pass 1: direct columns, attenuating through water and foliage.
    for (let z = minZ; z <= maxZ; z++)
      for (let x = minX; x <= maxX; x++) {
        let level = 15,
          runEnd = bottomY - 1;
        const cx = Math.floor(x / CHUNK),
          cz = Math.floor(z / CHUNK),
          lx = x - cx * CHUNK,
          lz = z - cz * CHUNK;
        let previousCy = Infinity,
          columnCost: Uint8Array | undefined,
          columnSky: Uint8Array | undefined;
        for (let y = topY; y >= bottomY; y--) {
          const cy = Math.floor(y / CHUNK);
          if (cy !== previousCy) {
            const key = chunkKey(cx, cy, cz);
            columnCost = this.cost.get(key);
            columnSky = next.get(key);
            previousCy = cy;
          }
          const index = (lx * CHUNK + y - cy * CHUNK) * CHUNK + lz;
          const cost = columnCost?.[index] ?? AIR_COST;
          if (cost >= OPAQUE) break;
          if (level < 15 || cost > AIR_COST) level = Math.max(0, level - Math.max(AIR_COST, cost));
          if (level === 0) break;
          if (!columnSky) {
            columnSky = new Uint8Array(CHUNK ** 3);
            next.set(chunkKey(cx, cy, cz), columnSky);
          }
          columnSky[index] = level;
          if (level === 15) runEnd = y;
        }
        runs[(x - minX) + (z - minZ) * spanX] = runEnd;
      }
    // Pass 2: seed the top runs of columns that stand next to darker columns.
    const queue = new Int32Queue(3);
    for (let z = minZ; z <= maxZ; z++)
      for (let x = minX; x <= maxX; x++) {
        const run = runs[x - minX + (z - minZ) * spanX];
        let darkest = bottomY - 1;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx,
            nz = z + dz;
          if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
          darkest = Math.max(darkest, runs[nx - minX + (nz - minZ) * spanX]);
        }
        for (let y = run; y <= Math.min(topY, darkest - 1); y++) queue.push(x, y, z);
      }
    // Light from outside the local window remains valid. Seed its boundary
    // contribution so caves and overhangs crossing the window still match a
    // full recompute.
    if (local) {
      const oldAt = (x: number, y: number, z: number) => {
        const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK);
        return this.sky.get(chunkKey(cx, cy, cz))?.[localIndex(x, y, z, cx, cy, cz)] ?? 0;
      };
      const seed = (x: number, y: number, z: number, outside: number) => {
        const target = outside - Math.max(AIR_COST, this.costAt(x, y, z));
        if (target <= 0) return;
        const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK);
        const grid = cell(x, y, z)!;
        const index = localIndex(x, y, z, cx, cy, cz);
        if (target > grid[index]) {
          grid[index] = target;
          queue.push(x, y, z);
        }
      };
      for (let y = bottomY; y <= topY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          seed(minX, y, z, oldAt(minX - 1, y, z));
          seed(maxX, y, z, oldAt(maxX + 1, y, z));
        }
        for (let x = minX; x <= maxX; x++) {
          seed(x, y, minZ, oldAt(x, y, minZ - 1));
          seed(x, y, maxZ, oldAt(x, y, maxZ + 1));
        }
      }
    }
    // Pass 3: sideways flood under overhangs, into windows and doorways.
    const record = [0, 0, 0];
    while (queue.size) {
      queue.pop(record);
      const [x, y, z] = record;
      const level = cell(x, y, z)?.[localIndex(x, y, z, Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK))] ?? 0;
      if (level <= AIR_COST) continue;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx,
          ny = y + dy,
          nz = z + dz;
        if (ny < bottomY || (local && (nx < minX || nx > maxX || nz < minZ || nz > maxZ))) continue;
        const cost = this.costAt(nx, ny, nz);
        if (cost >= OPAQUE) continue;
        const target = level - Math.max(AIR_COST, cost);
        const grid = cell(nx, ny, nz);
        const index = localIndex(nx, ny, nz, Math.floor(nx / CHUNK), Math.floor(ny / CHUNK), Math.floor(nz / CHUNK));
        if (target > (grid?.[index] ?? 0)) {
          grid![index] = target;
          queue.push(nx, ny, nz);
        }
      }
    }
    // Replace the channel and mark exactly the chunks whose values moved.
    const previous = this.sky;
    if (local) {
      const merged = new Map(previous);
      for (const key of previous.keys()) {
        const [cx, , cz] = key.split(',').map(Number);
        if (cx * CHUNK >= minX && cx * CHUNK <= maxX && cz * CHUNK >= minZ && cz * CHUNK <= maxZ)
          merged.delete(key);
      }
      for (const [key, grid] of next) merged.set(key, grid);
      this.sky = merged;
    } else this.sky = next;
    this.memoKey = '';
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      if (local) {
        const [cx, , cz] = key.split(',').map(Number);
        if (cx * CHUNK < minX || cx * CHUNK > maxX || cz * CHUNK < minZ || cz * CHUNK > maxZ) continue;
      }
      const old = previous.get(key);
      const grid = next.get(key);
      if (old && grid) {
        const [cx, cy, cz] = key.split(',').map(Number);
        for (let i = 0; i < grid.length; i++) {
          if (old[i] === grid[i]) continue;
          this.mark(
            cx * CHUNK + Math.floor(i / 256),
            cy * CHUNK + (Math.floor(i / 16) % 16),
            cz * CHUNK + (i % 16),
          );
        }
      } else {
        // A chunk of sky appeared or vanished wholesale (model grew or shrank).
        this.dirty.add(key);
        const [cx, cy, cz] = key.split(',').map(Number);
        this.dirty.add(chunkKey(cx - 1, cy, cz));
        this.dirty.add(chunkKey(cx + 1, cy, cz));
        this.dirty.add(chunkKey(cx, cy - 1, cz));
        this.dirty.add(chunkKey(cx, cy + 1, cz));
        this.dirty.add(chunkKey(cx, cy, cz - 1));
        this.dirty.add(chunkKey(cx, cy, cz + 1));
      }
    }
  }
}
