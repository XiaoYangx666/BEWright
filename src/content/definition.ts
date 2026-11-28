import { assertBox, Structure, type Box, type Vec3 } from '../core/structure.js';
import type { Components } from '../core/components.js';
import type { BuildingCheckResult, ModelCheckContext } from '../authoring/diagnostics.js';

/** A building module returns a raw Structure or a layered Components model. */
export type BuildingModel = Structure | Components;
export type BuildingEdition = 'bedrock' | 'java';

export type BuildingParamType = 'int' | 'number' | 'string' | 'boolean';
export type BuildingParam = Readonly<{
  type: BuildingParamType;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  /** Allowed values for a string parameter. */
  values?: readonly string[];
  description?: string;
}>;
export type BuildingParams = Readonly<Record<string, BuildingParam>>;
export type BuildingArgs = Readonly<Record<string, number | string | boolean>>;

export type BuildingView = Readonly<{
  name: string;
  /** Replaces the top-level build for this view only. */
  build?: (args: BuildingArgs) => BuildingModel;
  /** Region handed to the mesher and the exporter; defaults to the full bounds. */
  region?: Box;
  view?: 'iso' | 'top' | 'front' | 'side';
  direction?: Vec3;
  eye?: Vec3;
  target?: Vec3;
  title?: string;
  /** 'geometry' fits the camera to visible vertices instead of the bounding box. */
  fit?: 'geometry' | 'bounds';
  /** Preview-only colour overrides; never changes exported block data. */
  style?: Readonly<Record<string, string>>;
}>;

/**
 * Bedrock delivery plan.
 *
 * Three different questions used to be answered by the same `size` field, which
 * meant a `.mcstructure` shard size silently decided world placement behaviour:
 *
 * 1. **export** — how the structure files are cut up (a hard 2,000,000-block
 *    limit per file, unrelated to the world);
 * 2. **placement** — the region and coordinate mapping used when writing into a
 *    world (`bewright import`), measured in world coordinates;
 * 3. **batch** — the execution granularity of a single write call.
 *
 * They are separate fields now. `size` remains the legacy spelling of
 * `export.shard` and is still honoured (see `resolveTilePlan`), because the old
 * behaviour — one shard size driving all three — was a deliberate, working
 * default that existing buildings rely on.
 */
export type BuildingTileExportPlan = Readonly<{
  /** Shard edge length for `.mcstructure` files. */
  shard: number;
  /** Region the export covers; defaults to `bounds`. */
  region?: Box;
}>;

export type BuildingTilePlacementPlan = Readonly<{
  /** Region placed into the world; defaults to the export region. */
  region?: Box;
  /**
   * Where the region's `region.min` corner lands in world coordinates.
   * Defaults to the caller's origin, so a placement region can be re-anchored
   * without changing the export shards.
   */
  origin?: Vec3;
  /** Execute the placement in batches of at most this many cells. */
  batchSize?: number;
}>;

export type BuildingTilePlan = Readonly<{
  /** Legacy: shard edge length, applied to every stage. */
  size?: number;
  /** Legacy: shard/placement region. */
  region?: Box;
  /** Legacy: export origin. */
  origin?: Vec3;
  /** Export shards (structure files). */
  export?: BuildingTileExportPlan;
  /** World placement region, coordinate mapping and batch size. */
  placement?: BuildingTilePlacementPlan;
}>;

/** Fully resolved delivery plan: each stage has its own size and mapping. */
export type ResolvedTilePlan = Readonly<{
  export: Readonly<{ shard: number; region: Box }>;
  placement: Readonly<{ region: Box; origin: Vec3; batchSize: number | null }>;
}>;

/**
 * Resolve a tile plan, keeping the legacy single-`size` configuration working.
 *
 * The legacy path maps one size onto all three stages, which is exactly what
 * the old code did implicitly; the explicit path lets a building decouple them
 * (for example: 32-block export shards, one placement region, 4096-cell writes).
 */
export function resolveTilePlan(plan: BuildingTilePlan | false | undefined, bounds: Box): ResolvedTilePlan | null {
  if (!plan) return null;
  const legacySize = plan.size;
  const exportShard = plan.export?.shard ?? legacySize;
  const region = plan.export?.region ?? plan.region ?? bounds;
  if (!Number.isSafeInteger(exportShard) || (exportShard as number) < 1)
    throw new Error('Tile plan needs a positive integer shard size');
  return {
    export: { shard: exportShard as number, region },
    placement: {
      region: plan.placement?.region ?? region,
      origin: plan.placement?.origin ?? plan.origin ?? region.min,
      batchSize: plan.placement?.batchSize ?? (legacySize && Number.isSafeInteger(legacySize) ? legacySize : null),
    },
  };
}

/**
 * Context handed to a building's own `check()`.
 *
 * The legacy fields (`world`, `model`, `args`, `inspect`, `diagnostics`) keep
 * every existing building working. New fields are additive: `bounds`,
 * `surfaces` (terrain/water/standable queries over the final model),
 * `protection` (declared zones and clearances), and `collect`/`report`
 * (`report` is an alias) for emitting structured diagnostics without throwing.
 */
export type BuildingCheckContext = ModelCheckContext;

/**
 * The external-content contract. A building lives outside `src/`, declares its
 * metadata in `blockwright.building.json`, and exports one of these from its entry.
 */
export type BuildingDefinition = Readonly<{
  id: string;
  name: string;
  description?: string;
  params?: BuildingParams;
  build: (args: BuildingArgs) => BuildingModel;
  bounds: Box;
  spawn?: Vec3;
  views?: readonly BuildingView[];
  /** Set `false` to force a single whole-structure export. */
  tiles?: BuildingTilePlan | false;
  editions?: readonly BuildingEdition[];
  /** Artifact directory override, relative to the project root. */
  artifacts?: string;
  /** Mesh cache directory override, relative to the project root. */
  cache?: string;
  /** Registered blocks allowed to use placeholder preview geometry, with a diagnostic warning. */
  previewPlaceholderBlocks?: readonly string[];
  /** Optional scene-specific invariants, run by `bewright build` / `bewright check` and the content tests. */
  check?: (context: BuildingCheckContext) => BuildingCheckResult | Promise<BuildingCheckResult>;
}>;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Parameter names are CLI keys, so camelCase is allowed. */
const PARAM_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

export function defineBuilding(definition: BuildingDefinition): BuildingDefinition {
  if (!ID_PATTERN.test(definition.id)) throw new Error(`Building id must be a lowercase slug: ${definition.id}`);
  if (!definition.name.trim()) throw new Error(`Building ${definition.id} needs a name`);
  if (typeof definition.build !== 'function') throw new Error(`Building ${definition.id} needs a build function`);
  assertBox(definition.bounds);
  const editions = definition.editions ?? ['bedrock'];
  for (const edition of editions)
    if (edition !== 'bedrock' && edition !== 'java') throw new Error(`Unknown edition: ${edition}`);
  const views = definition.views ?? [];
  const names = new Set<string>();
  for (const view of views) {
    if (!ID_PATTERN.test(view.name)) throw new Error(`View name must be a lowercase slug: ${view.name}`);
    if (names.has(view.name)) throw new Error(`Duplicate view name in ${definition.id}: ${view.name}`);
    names.add(view.name);
  }
  if (definition.tiles) {
    const size = definition.tiles.size ?? definition.tiles.export?.shard;
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 1))
      throw new Error(`Tile size must be a positive integer in ${definition.id}`);
    if (definition.tiles.export && definition.tiles.size && definition.tiles.export.shard !== definition.tiles.size)
      throw new Error(
        `Building ${definition.id} declares both tiles.size (${definition.tiles.size}) and tiles.export.shard (${definition.tiles.export.shard}); keep only one`,
      );
  }
  for (const [name, param] of Object.entries(definition.params ?? {})) {
    if (!PARAM_PATTERN.test(name)) throw new Error(`Parameter name must be an identifier: ${name}`);
    if (param.type === 'string' && param.values && !param.values.length)
      throw new Error(`Parameter ${name} declares an empty values list`);
    if (param.min !== undefined && param.max !== undefined && param.min > param.max)
      throw new Error(`Parameter ${name} has min > max`);
  }
  return definition;
}

function coerceParam(name: string, param: BuildingParam, raw: number | string | boolean): number | string | boolean {
  if (param.type === 'string') {
    if (typeof raw !== 'string') throw new Error(`Parameter ${name} must be a string`);
    if (param.values && !param.values.includes(raw))
      throw new Error(`Parameter ${name} must be one of ${param.values.join(', ')}`);
    return raw;
  }
  if (param.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`Parameter ${name} must be true or false`);
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Parameter ${name} must be a number`);
  if (param.type === 'int' && !Number.isSafeInteger(value)) throw new Error(`Parameter ${name} must be an integer`);
  if (param.min !== undefined && value < param.min) throw new Error(`Parameter ${name} must be >= ${param.min}`);
  if (param.max !== undefined && value > param.max) throw new Error(`Parameter ${name} must be <= ${param.max}`);
  return value;
}

/** Fill defaults, coerce CLI strings, and reject unknown or invalid parameters. */
export function resolveBuildingArgs(
  params: BuildingParams | undefined,
  overrides: Readonly<Record<string, number | string | boolean>> = {},
): BuildingArgs {
  const declared = params ?? {};
  for (const name of Object.keys(overrides))
    if (!Object.hasOwn(declared, name)) throw new Error(`Unknown building parameter: ${name}`);
  const args: Record<string, number | string | boolean> = {};
  for (const [name, param] of Object.entries(declared)) {
    const raw = overrides[name];
    if (raw === undefined) {
      if (param.default !== undefined) args[name] = param.default;
      continue;
    }
    args[name] = coerceParam(name, param, raw);
  }
  return Object.freeze(args);
}

/** Parse repeated `--param key=value` flags into raw overrides. */
export function parseParamFlags(flags: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (const flag of flags) {
    const index = flag.indexOf('=');
    if (index < 1) throw new Error(`Expected --param name=value, got: ${flag}`);
    const name = flag.slice(0, index).trim();
    if (!PARAM_PATTERN.test(name)) throw new Error(`Parameter name must be an identifier: ${name}`);
    result[name] = flag.slice(index + 1);
  }
  return result;
}

/** Unwrap a definition's build output into the authoritative Structure plus optional layers. */
export function buildingModelWorld(model: BuildingModel): { world: Structure; components: Components | null } {
  return model instanceof Structure ? { world: model, components: null } : { world: model.world, components: model };
}
