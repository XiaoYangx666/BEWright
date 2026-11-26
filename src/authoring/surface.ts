import { contains, type Box, type Structure, type Vec3 } from '../core/structure.js';
import { collisionBoxes } from './traversal.js';
import { isConstructedName } from './rules.js';

/**
 * 实际地形表面查询。
 *
 * 生成期的高度公式只是**生成输入**；挖潭、削坡、架桥之后，唯一可信的是模型本身。
 * 本模块只读当前 `Structure`，区分三类表面：
 *
 * - `terrain`：地形表面。默认跳过水面与树冠／枝叶，所以不会把树冠或桥面当成山地；
 * - `water`：水面（顶层水体）；
 * - `standable`：玩家可站立的顶面（碰撞几何，含桥面、台阶、半砖）。
 *
 * 缓存按 `Structure.revision` 失效：任何一次写入都会让旧结果作废，
 * 过期数据不做"静默继续使用"的降级——直接重建。若调用方显式打开
 * `allowStale`（只用于只读统计），越期缓存会同时产出 unknown 诊断。
 */

export const DEFAULT_SCAN_LIMIT = 48;

export type SurfaceClass = 'terrain' | 'water' | 'standable' | 'ground';

export type SurfaceSample = Readonly<{
  found: boolean;
  /** Highest matching block Y, or null when nothing matched in range. */
  y: number | null;
  blockName: string | null;
  /** True when the search hit the scan limit before exhausting the range. */
  truncated: boolean;
}>;

export type SurfaceQueryOptions = Readonly<{
  /** Lowest Y that may be scanned; defaults to 0. */
  minY?: number;
  /** Highest Y that may be scanned; defaults to the model top plus `pad`. */
  maxY?: number;
  pad?: number;
  /** Cells above this many blocks are never scanned. */
  scanLimit?: number;
  /** Vegetation is not ground: leaves/logs/plants are skipped by terrain queries. */
  skipVegetation?: boolean;
  /** Explicit air (`minecraft:air`) counts as "mined out" and stops the terrain scan. */
  airStopsTerrain?: boolean;
  /** Only used by `sample()` when the caller wants to opt into stale reads. */
  allowStale?: boolean;
}>;

export type SurfaceQueryStats = Readonly<{
  /** Total column lookups served. */
  queries: number;
  /** How often the whole derived index had to be rebuilt (revision change). */
  rebuilds: number;
  cachedColumns: number;
  /** True when the last answer came from a cache built at an older revision. */
  stale: boolean;
}>;

type Column = Readonly<{
  terrain: number | null;
  water: number | null;
  standable: number | null;
  truncated: boolean;
}>;

const VEGETATION =
  /(_leaves|_log|_wood|_sapling|_roots|_stem|bamboo|fern|short_grass|tall_grass|vine|_flower|dandelion|poppy|cornflower|oxeye_daisy|azure_bluet|allium|sweet_berry_bush|azalea|moss_carpet|snow_layer|_carpet|cactus|_bush|flower_pot|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|_hanging|_propagule|glow_lichen|_lily|seagrass|kelp)/;

const PLANT_BLOCK = new Set([
  'fern',
  'short_grass',
  'tall_grass',
  'vine',
  'dandelion',
  'poppy',
  'cornflower',
  'oxeye_daisy',
  'azure_bluet',
  'allium',
  'sweet_berry_bush',
  'moss_carpet',
  'snow_layer',
  'azalea',
  'flowering_azalea',
  'seagrass',
]);

function shortName(name: string | null): string | null {
  return name === null ? null : name.replace(/^minecraft:/, '');
}

/** Block names that collide as a full cube in their default state (cached). */
const FULL_CUBE_BY_NAME = new Map<string, boolean>();
/** Block names whose default-state collision top is at least half a block (cached). */
const STANDABLE_BY_NAME = new Map<string, boolean>();

function isFullCube(name: string | null): boolean {
  const short = shortName(name);
  if (short === null || short === 'air' || short === 'water') return false;
  const cached = FULL_CUBE_BY_NAME.get(short);
  if (cached !== undefined) return cached;
  const collision = collisionBoxes({ name: `minecraft:${short}`, states: {} });
  const full =
    collision.kind === 'supported' &&
    collision.boxes.some(
      (box) => box[0] === 0 && box[1] === 0 && box[2] === 0 && box[3] === 1 && box[4] === 1 && box[5] === 1,
    );
  FULL_CUBE_BY_NAME.set(short, full);
  return full;
}

/**
 * Terrain-surface predicate: **the ground itself**, not what is built on it.
 *
 * Terrain is a full cube that is neither water, foliage, plant nor a crafted
 * building material. A bridge deck, a plank floor or a stone-brick plaza is
 * standable but is **not** terrain — that distinction is what stops
 * "how high is the mountain here" from answering with the bridge over it.
 */
export function isTerrainSurface(name: string | null, skipVegetation = true): boolean {
  const short = shortName(name);
  if (short === null || short === 'air' || short === 'water') return false;
  if (isConstructedName(short)) return false;
  if (skipVegetation) {
    if (PLANT_BLOCK.has(short)) return false;
    if (VEGETATION.test(short)) return false;
  }
  return isFullCube(short);
}

/** A surface a player can actually stand on: collision top at least half a block. */
export function isStandableSurface(name: string | null): boolean {
  const short = shortName(name);
  if (short === null || short === 'air' || short === 'water') return false;
  const cached = STANDABLE_BY_NAME.get(short);
  if (cached !== undefined) return cached;
  const collision = collisionBoxes({ name: `minecraft:${short}`, states: {} });
  const standable = collision.kind === 'supported' && collision.boxes.some((box) => box[4] >= 0.5);
  STANDABLE_BY_NAME.set(short, standable);
  return standable;
}

/** Water surface predicate. */
export function isWaterSurface(name: string | null): boolean {
  return shortName(name) === 'water';
}

export class SurfaceQuery {
  private readonly world: Structure;
  private readonly options: Required<
    Pick<SurfaceQueryOptions, 'pad' | 'scanLimit' | 'skipVegetation' | 'airStopsTerrain'>
  > &
    SurfaceQueryOptions;
  private readonly columns = new Map<string, Column>();
  private revision = -1;
  private boundsCache: Box | null = null;
  private boundsRevision = -1;
  private queryCount = 0;
  private rebuildCount = 0;

  constructor(world: Structure, options: SurfaceQueryOptions = {}) {
    this.world = world;
    this.options = {
      pad: 1,
      scanLimit: DEFAULT_SCAN_LIMIT,
      skipVegetation: true,
      airStopsTerrain: true,
      ...options,
    };
  }

  get structure(): Structure {
    return this.world;
  }

  /**
   * Inclusive Y window for column scans: from the model floor (`minY`, default 0)
   * up to the top of the model plus `pad`.
   *
   * The ceiling takes `Structure.ceiling` into account — the highest explicitly
   * written cell, including explicit air. Without it, a column mined above the
   * highest remaining block would fall outside the window and the scan would
   * report the rock far below as "the ground".
   */
  range(): { min: number; max: number } {
    const low = this.options.minY ?? 0;
    // A bounded survey already supplies its ceiling. Computing whole-model
    // bounds for every pier's Y window needlessly scans millions of cells.
    if (this.options.maxY !== undefined) return { min: low, max: this.options.maxY };
    const padding = this.options.pad;
    const extent = this.bounds();
    const occupiedTop = extent ? extent.max[1] - 1 : -Infinity;
    const writtenTop = Number.isFinite(this.world.ceiling) ? this.world.ceiling : -Infinity;
    const high = this.options.maxY ?? Math.max(occupiedTop, writtenTop, low) + padding;
    return { min: low, max: high };
  }

  private bounds(): Box | null {
    // Cached per revision: the model extent changes whenever blocks are added
    // or removed, so a stale box would silently scan the wrong Y window.
    if (this.boundsCache && this.boundsRevision === this.world.revision) return this.boundsCache;
    this.boundsCache = this.world.inspect().bounds;
    this.boundsRevision = this.world.revision;
    return this.boundsCache;
  }

  private sync(): void {
    if (this.revision === this.world.revision) return;
    this.columns.clear();
    this.boundsCache = null;
    this.revision = this.world.revision;
    this.rebuildCount++;
  }

  private column(x: number, z: number): Column {
    this.sync();
    const key = `${x},${z}`;
    const cached = this.columns.get(key);
    if (cached) return cached;
    // Outside the model there is no ground to report. This is different from a
    // column that exists but was mined out: that one stops the scan instead.
    if (!this.world.touched(x, z)) {
      const empty: Column = { terrain: null, water: null, standable: null, truncated: false };
      this.columns.set(key, empty);
      return empty;
    }
    const { min, max } = this.range();
    const limit = Math.max(0, max - min + 1);
    const scan = Math.min(limit, this.options.scanLimit);
    let terrain: number | null = null;
    let water: number | null = null;
    let standable: number | null = null;
    let scanned = 0;
    for (; scanned < scan; scanned++) {
      const y = max - scanned;
      const state = this.world.get(x, y, z) ?? null;
      const name = state?.name ?? null;
      if (water === null && isWaterSurface(name)) water = y;
      if (standable === null && state && isStandableSurface(name)) standable = y;
      if (terrain === null) {
        if (isTerrainSurface(name, this.options.skipVegetation)) terrain = y;
        // Explicit air means this column was mined out (a pond interior, a cut
        // slope): there is no natural surface above the void, so stop looking
        // instead of reporting the rock far below as "the ground".
        else if (state && shortName(name) === 'air' && this.options.airStopsTerrain) break;
      }
      if (terrain !== null && water !== null && standable !== null) break;
    }
    const column: Column = {
      terrain,
      water,
      standable,
      // `truncated` means the answer may be incomplete because the scan window
      // ran out — not that the column was mined out on purpose.
      truncated: scanned >= scan && scanned < limit,
    };
    this.columns.set(key, column);
    return column;
  }

  /**
   * Highest terrain surface in the column. `null` when the range holds no ground
   * (mined-out pond interior, above the build, outside the model).
   */
  terrain(x: number, z: number): number | null {
    this.queryCount++;
    return this.column(x, z).terrain;
  }

  /** Highest water surface in the column. */
  water(x: number, z: number): number | null {
    this.queryCount++;
    return this.column(x, z).water;
  }

  /** Highest standable collision top (bridge decks, stair treads, slabs). */
  standable(x: number, z: number): number | null {
    this.queryCount++;
    return this.column(x, z).standable;
  }

  /**
   * Highest surface that counts as "the ground here" for support and cliff
   * questions: the terrain surface, or the water surface where a column was
   * mined into a basin — whichever sits higher.
   *
   * This is the distinction a building needs when it asks "how far does the
   * water fall from here". Inside a pond the rock floor is metres below the
   * water, so taking the terrain alone would report a cliff where there is a
   * lake surface; taking the water alone would report a lake on dry land.
   */
  groundY(x: number, z: number): number | null {
    this.queryCount++;
    const column = this.column(x, z);
    if (column.terrain === null) return column.water;
    if (column.water === null) return column.terrain;
    return Math.max(column.terrain, column.water);
  }

  /** Ground height for generation passes, or `fallback` when there is none. */
  groundYOr(x: number, z: number, fallback: number): number {
    return this.groundY(x, z) ?? fallback;
  }

  /** Block name of the ground surface, for reports and checks. */
  groundBlock(x: number, z: number): string | null {
    const y = this.groundY(x, z);
    return y === null ? null : (this.world.get(x, y, z)?.name ?? null);
  }

  sample(kind: SurfaceClass, x: number, z: number): SurfaceSample {
    const column = this.column(x, z);
    const y =
      kind === 'terrain'
        ? column.terrain
        : kind === 'water'
          ? column.water
          : kind === 'standable'
            ? column.standable
            : (column.terrain ?? column.water);
    return {
      found: y !== null,
      y,
      blockName: y === null ? null : (this.world.get(x, y, z)?.name ?? null),
      truncated: column.truncated,
    };
  }

  /**
   * Ground height for generation passes: the terrain surface, or `fallback` when
   * the column was mined away or lies outside the scanned range.
   */
  terrainOr(x: number, z: number, fallback: number): number {
    return this.terrain(x, z) ?? fallback;
  }

  /**
   * Standable surface for "under the bridge" queries: the highest collision top
   * strictly below `ceiling` (exclusive), so a bridge deck over a pond does not
   * masquerade as the valley floor.
   */
  standableBelow(x: number, z: number, ceiling: number): number | null {
    this.queryCount++;
    const range = this.range();
    for (let y = Math.min(ceiling - 1, range.max); y >= range.min; y--) {
      const state = this.world.get(x, y, z);
      if (state && isStandableSurface(state.name)) return y;
    }
    return null;
  }

  /** True when nothing but air sits above `fromY` up to the model ceiling. */
  openSky(x: number, z: number, fromY: number, ceiling?: number): boolean {
    this.queryCount++;
    const top = Math.min(ceiling ?? this.range().max, this.bounds()?.max[1] ?? this.range().max);
    for (let y = fromY; y <= top; y++) {
      const state = this.world.get(x, y, z);
      if (state && state.name !== 'minecraft:air') return false;
    }
    return true;
  }

  /**
   * Largest one-step slope on the terrain surface around a column.
   *
   * Neighbours without ground (edge of the model, mined-out column) are skipped
   * rather than making the whole answer unknown; the result is `null` only when
   * the column itself has no ground.
   */
  slope(x: number, z: number): number | null {
    const here = this.terrain(x, z);
    if (here === null) return null;
    let max = 0;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const neighbour = this.terrain(x + dx, z + dz);
      if (neighbour === null) continue;
      max = Math.max(max, Math.abs(neighbour - here));
    }
    return max;
  }

  /** Force the next read to rebuild, even when the revision happens to be unchanged. */
  invalidate(): void {
    this.revision = -1;
    this.columns.clear();
    this.boundsCache = null;
  }

  stats(): SurfaceQueryStats {
    return {
      queries: this.queryCount,
      rebuilds: this.rebuildCount,
      cachedColumns: this.columns.size,
      stale: false,
    };
  }

  /** Inclusive rectangular sample used by terrain-aware placement. */
  rect(x0: number, z0: number, x1: number, z1: number): { min: number; max: number; count: number } | null {
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const y = this.terrain(x, z);
        if (y === null) continue;
        min = Math.min(min, y);
        max = Math.max(max, y);
        count++;
      }
    return count ? { min, max, count } : null;
  }
}

/** Convenience factory; buildings normally get one from the check context. */
export function surfaceQuery(world: Structure, options?: SurfaceQueryOptions): SurfaceQuery {
  return new SurfaceQuery(world, options);
}

/** Guard used by diagnostics: a region is inside the model when both corners are. */
export function regionInBounds(bounds: Box, region: Box): boolean {
  return contains(bounds, ...region.min) && contains(bounds, region.max[0] - 1, region.max[1] - 1, region.max[2] - 1);
}

export function regionVolume(region: Box): number {
  return (region.max[0] - region.min[0]) * (region.max[1] - region.min[1]) * (region.max[2] - region.min[2]);
}

export function cellKey(position: Vec3): string {
  return position.join(',');
}
