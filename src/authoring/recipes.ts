import type { Box, State, Structure, Vec3 } from '../core/structure.js';
import { coordinateDiagnostic, type Diagnostic, type DiagnosticObject } from './diagnostics.js';
import { SurfaceQuery } from './surface.js';
import {
  commitConstruction,
  planConstruction,
  type ConstructionMergeStats,
  type ConstructionSink,
} from './construction.js';
import { coordinateRandom, voxelPath } from './layout.js';
import type { ProtectionRegistry } from './protection.js';
import type { ProtectionRuleSet } from './rules.js';
import { emptyTerrainReport, recordTerrain, type TerrainBuildReport, type TerrainSite } from './terrain/build.js';
import {
  gradeTerrain,
  distanceToLine,
  lineBetween,
  terrainRecipe,
  type PlateauSpec,
  type TerrainRecipe,
} from './terrain/recipe.js';
import { checkWaterSystem } from './water/check.js';
import { planWaterSystem } from './water/plan.js';
import { recordWaterSystem, type WaterBuildReport } from './water/build.js';
import type { WaterPlan, WaterSegmentSpec, WaterSystemSpec } from './water/contracts.js';

/**
 * 组合配方：**山脊—溪流—跌水—潭岸**。
 *
 * 配方只组合公共机制（`terrainRecipe` / `buildTerrain` / `planWaterSystem` /
 * `buildWaterSystem`），不自己写逐格循环，也不把任何主题硬编码进去：
 * 尺寸、标高、种子与材料全部由调用方给出，未给的部分有可用默认值。
 *
 * 场景骨架（坐标按场地比例推导，不写死绝对格）：
 *
 * ```text
 *   -Z  山脊（crest line）
 *       └ 泉眼台地（平顶 = springY，+Z 侧是断崖）
 *           └ 溪流（平水段，水位 springY）
 *               └ 跌水（沿断崖自由下落，不铺床体）
 *                   └ 潭（圆形轮廓，水位 poolY，带深度）
 *                       └ 出口河段（水位 poolY，流出场地）
 *   +Z
 * ```
 *
 * 反例同样由参数取得：床体材料返回 `null` 的潭会被 `water.basin-floor` 抓住，
 * 而不是"看起来有水"。
 */

export type ValleyStreamMaterials = Readonly<{
  rock: (site: TerrainSite) => State;
  soil?: (site: TerrainSite) => State;
  surface?: (site: TerrainSite) => State | null;
  water: (cell: Vec3, depth: number) => State;
  /** Pool and channel bed. Returning `null` leaves the body open — and reported. */
  bed: (cell: Vec3) => State | null;
  /**
   * Shoreline material. `band` is the Chebyshev distance from the water body
   * (1 = the first dry cell), so a shore can thin out with distance instead of
   * being one ring of one colour.
   */
  bank?: (cell: Vec3, band: number) => State | null;
}>;

export type ValleyStreamSpec = Readonly<{
  id: string;
  seed: number;
  /** Half-open footprint of the whole scene; the recipe builds exactly this. */
  region: Box;
  /** Rock floor: every column is filled down to here. */
  floorY: number;
  /** Water level on the spring shelf. */
  springY: number;
  /** Water level of the plunge pool, and the ground level of the whole valley. */
  poolY: number;
  /** Summit height of the ridge behind the spring. */
  ridgeTop: number;
  /** Stream channel half-width (0 = one block wide). */
  streamHalfWidth?: number;
  /** Pool radius in blocks; defaults to a tenth of the shorter side. */
  poolRadius?: number;
  /** Pool water thickness (default 3). */
  poolDepth?: number;
  materials: ValleyStreamMaterials;
  /** Columns where terrain may be built; true includes the column (buildings, roads, protection). */
  where?: (x: number, z: number) => boolean;
  /** Declared protection zones the whole group may not enter. */
  protection?: ProtectionRegistry;
  /** Framework protection rules consulted for this scene. */
  rules?: ProtectionRuleSet;
  object?: DiagnosticObject | string;
}>;

export type ValleyStreamLandmarks = Readonly<{
  /** Where the stream leaves the shelf. */
  spring: Vec3;
  /** Lip of the fall. */
  fallTop: Vec3;
  /** Where the fall meets the pool surface. */
  fallFoot: Vec3;
  /** Centre of the pool surface. */
  pool: Vec3;
  /** Last wet cell before the water leaves the scene. */
  outlet: Vec3;
  /** Highest point of the ridge. */
  crest: Vec3;
  /** Difference between the source and receiving water levels. */
  fallHeight: number;
}>;

export type ValleyStreamPlan = Readonly<{
  id: string;
  object: DiagnosticObject;
  /**
   * The resolved inputs this plan was built from — materials, region, levels
   * and seed.
   *
   * The plan is the **single** input to `buildValleyStream`: handing it a
   * second, separately-passed spec would let the two drift apart, and the
   * materials that were validated would not be the materials that get built.
   */
  spec: ValleyStreamSpec;
  recipe: TerrainRecipe;
  water: WaterPlan;
  plateaus: readonly PlateauSpec[];
  landmarks: ValleyStreamLandmarks;
  region: Box;
  diagnostics: readonly Diagnostic[];
  feasible: boolean;
}>;

function objectOf(spec: ValleyStreamSpec): DiagnosticObject {
  if (spec.object) return typeof spec.object === 'string' ? { kind: 'valley-stream', id: spec.object } : spec.object;
  return { kind: 'valley-stream', id: spec.id };
}

/** Seeded crest polyline: a ridge that wanders, not an extruded straight wall. */
function crestLine(spec: ValleyStreamSpec, width: number, ridgeZ: number): [number, number][] {
  const points: [number, number][] = [];
  const segments = 5;
  const x0 = spec.region.min[0];
  const depth = spec.region.max[2] - spec.region.min[2];
  for (let index = 0; index <= segments; index++) {
    const t = index / segments;
    const wander = (coordinateRandom(index, spec.seed, 0, spec.seed, 11) - 0.5) * depth * 0.16;
    const fade = Math.sin(t * Math.PI);
    points.push([Math.round(x0 + 2 + (width - 5) * t), Math.round(ridgeZ + wander * fade)]);
  }
  return points;
}

/** Plan the whole scene: terrain field, water system and landmarks. Pure. */
export function planValleyStream(spec: ValleyStreamSpec): ValleyStreamPlan {
  spec = {
    ...spec,
    region: { min: [...spec.region.min], max: [...spec.region.max] },
    materials: { ...spec.materials },
  };
  const region = spec.region;
  const width = region.max[0] - region.min[0];
  const depth = region.max[2] - region.min[2];
  if (width < 32 || depth < 32) throw new Error(`Valley scene ${spec.id} needs a footprint of at least 32x32 blocks`);
  if (spec.springY <= spec.poolY) throw new Error(`Valley scene ${spec.id} needs springY above poolY`);
  if (spec.ridgeTop <= spec.springY) throw new Error(`Valley scene ${spec.id} needs ridgeTop above springY`);
  if (spec.floorY >= spec.poolY) throw new Error(`Valley scene ${spec.id} needs floorY below poolY`);

  const halfWidth = spec.streamHalfWidth ?? 1;
  const radius = spec.poolRadius ?? Math.max(4, Math.round(Math.min(width, depth) * 0.1));
  const poolDepth = spec.poolDepth ?? 3;
  const x0 = region.min[0];
  const z0 = region.min[2];
  const cx = x0 + Math.round(width * 0.5);
  const ridgeZ = z0 + Math.round(depth * 0.12);
  const shelfZ0 = z0 + Math.round(depth * 0.22);
  const shelfZ1 = z0 + Math.round(depth * 0.44);
  // The pool starts exactly at the cliff face, so the fall is a straight
  // vertical sheet: a fall that steps sideways in Z reads as a staircase.
  const fallZ = shelfZ1 + 1;
  const poolZ = fallZ + radius;
  const outletZ = region.max[2];
  const fallHeight = spec.springY - spec.poolY;
  /** Seeded phase for the outlet meander, so the outflow is not a canal. */
  const phase = coordinateRandom(spec.seed, 0, 0, spec.seed, 29) * Math.PI * 2;

  const plateaus: PlateauSpec[] = []; // Retained metadata; the natural recipe uses shaped grading.
  const ungraded = terrainRecipe({
    base: spec.poolY,
    seed: spec.seed,
    mountains: [
      {
        id: 'ridge',
        // A crest that wanders instead of a ruler-straight berm: the outline is
        // a seeded polyline, and the profile roughness is what keeps the foot
        // from reading as an extruded wall.
        line: crestLine(spec, width, ridgeZ),
        crestHalfWidth: 2,
        top: spec.ridgeTop,
        shoulder: spec.ridgeTop - Math.max(4, Math.round((spec.ridgeTop - spec.springY) * 0.4)),
        foot: spec.springY,
        shoulderRun: Math.max(3, Math.round(depth * 0.05)),
        faceRun: Math.max(6, Math.round(depth * 0.1)),
        skirtRun: Math.max(8, Math.round(depth * 0.12)),
        roughness: 3,
      },
      // A second, lower knoll on the same ridge: two masses with a saddle
      // between them read as terrain, one long ridge reads as a wall.
      {
        id: 'knoll',
        line: lineBetween(
          [x0 + Math.round(width * 0.66), ridgeZ + Math.round(depth * 0.05)],
          [x0 + Math.round(width * 0.82), ridgeZ + Math.round(depth * 0.07)],
        ),
        crestHalfWidth: 1,
        top: spec.ridgeTop - 3,
        shoulder: spec.ridgeTop - 7,
        foot: spec.springY,
        shoulderRun: 3,
        faceRun: Math.max(5, Math.round(depth * 0.08)),
        skirtRun: Math.max(7, Math.round(depth * 0.1)),
        roughness: 2,
      },
    ],
    plateaus,
    detail: { amplitude: 2, scale: Math.max(24, Math.round(Math.min(width, depth) * 0.35)) },
  });

  /** Round pool body; `basin` stays the bounding box. */
  const outline = (x: number, z: number) => Math.hypot(x - cx, z - poolZ) <= radius;
  const poolOutline: Box = {
    min: [cx - radius - 1, spec.poolY - poolDepth, poolZ - radius - 1],
    max: [cx + radius + 2, spec.poolY + 1, poolZ + radius + 2],
  };

  const streamX = cx;
  const streamSegments: WaterSegmentSpec[] = [
    {
      id: 'brook',
      kind: 'reach',
      path: voxelPath(
        Array.from({ length: shelfZ1 - shelfZ0 + 1 }, (_, index) => {
          const t = index / (shelfZ1 - shelfZ0);
          const bend = Math.round(Math.sin(t * Math.PI * 2) * Math.min(3, width * 0.04));
          return [streamX + bend, spec.springY, shelfZ0 + index] as Vec3;
        }),
      ),
      halfWidth,
      connectsTo: ['fall'],
    },
    {
      id: 'fall',
      kind: 'drop',
      // One vertical column: the sheet hangs straight down the cliff face and
      // lands on the pool's first row. A sideways step per half would render as
      // a flight of stairs, which is exactly what a fall must not look like.
      path: Array.from({ length: fallHeight + 1 }, (_, index) => [streamX, spec.springY - index, fallZ] as Vec3),
      halfWidth: Math.max(1, halfWidth),
      // A vertical sheet has no direction of its own: the outlet port says the
      // water travels downstream (+Z), which stands the cross-section across X.
      outlet: { at: [streamX, spec.poolY, fallZ], facing: 2, width: Math.max(3, halfWidth * 2 + 1) },
      connectsTo: ['pool'],
    },
    {
      id: 'pool',
      kind: 'pool',
      path: [[cx, spec.poolY, poolZ]],
      halfWidth: radius,
      depth: poolDepth,
      basin: poolOutline,
      outline,
    },
    {
      id: 'outlet',
      kind: 'reach',
      // Starts just outside the pool body: a reach that overlaps the pool would
      // lay its own bed inside the pool's water column. It meanders a little so
      // the outflow reads as a stream leaving the valley, not as a canal.
      path: Array.from({ length: Math.max(1, outletZ - (poolZ + radius + 1)) }, (_, index) => {
        const z = poolZ + radius + 1 + index;
        // A smooth meander (at most one block of lateral change per step) keeps
        // consecutive cross-sections touching; a random walk would leave dry
        // cells inside the reach and the plan would refuse it.
        const meander = Math.round(
          (Math.sin(Math.min(index, Math.max(0, outletZ - (poolZ + radius + 1) - 4)) / 7 + phase) - Math.sin(phase)) *
            2,
        );
        return [streamX + meander, spec.poolY, z] as Vec3;
      }),
      halfWidth: halfWidth + 1,
      externalOutlet: { bounds: region, facing: 2 },
    },
  ];

  const brookLine = streamSegments[0]!.path.map((p) => [p[0], p[2]] as [number, number]);
  const outletLine = streamSegments[3]!.path.map((p) => [p[0], p[2]] as [number, number]);
  const shoulderWidth = Math.max(7, width * 0.14);
  /*
   * The fall needs a *face*, and a face needs relief: the lip steps back in
   * discrete ledges as it moves away from the notch, so the cliff shows rock
   * ribs and both ends wrap back into the flank instead of ending in a straight
   * vertical edge. This is shaped plan-form, not added noise — the height is
   * still the declared grading target.
   */
  const stepDepth = Math.max(1, Math.round(fallHeight * 0.25));
  const stepRun = Math.max(2, Math.round(halfWidth + 2.5));
  const maxSteps = Math.max(2, Math.round(fallHeight / stepDepth));
  /*
   * The full-height core has to cover the channel *and its meander*, otherwise
   * the first ledge cuts into the brook's own banks and the water leaks out of
   * the reach. Steps start beyond that core.
   */
  const bendAllowance = Math.max(2, Math.round(Math.min(3, width * 0.04)) + 1);
  const notch = halfWidth + 2 + bendAllowance;
  /** The fall's own vertical band: the sheet plus one block either side. */
  const cliffNotch = halfWidth + 2;
  const lipOffset = (lateral: number) => {
    if (lateral <= notch) return 0;
    return Math.min(maxSteps, Math.ceil((lateral - notch) / stepRun)) * stepDepth;
  };
  const recipe = gradeTerrain(ungraded, [
    {
      id: 'spring-glen',
      height: spec.springY + 1,
      transition: shoulderWidth,
      distance: (x, z) => {
        /*
         * Only the fall's own notch ends in a vertical face. Everywhere else
         * downstream of the lip the grading influence decays with distance, so
         * the drop becomes a steep continuous slope that feathers into both
         * flanks — a full-width vertical wall reads as an extruded box, which
         * is exactly what a natural glen must not look like. This is shaped
         * plan-form, not added noise: the height is still the declared target.
         */
        const lateral = Math.abs(x - cx);
        const lip = shelfZ1 + 0.5 - lipOffset(lateral);
        const core = distanceToLine(x, z, brookLine) - (halfWidth + 2);
        if (z <= lip) return core;
        // The vertical face is the sheet plus one block either side; outside it
        // the rock steps back at half rate and then opens into the slope, so the
        // gorge has shoulders instead of one full-width wall.
        if (lateral <= cliffNotch) return Infinity;
        return core + (z - lip) * (lateral <= notch ? 0.5 : 1);
      },
    },
    {
      id: 'receiving-basin',
      height: spec.poolY + 1,
      transition: Math.max(5, width * 0.09),
      distance: (x, z) => {
        if (z < fallZ) return Infinity;
        return Math.min(Math.hypot(x - cx, z - poolZ) - radius - 2, distanceToLine(x, z, outletLine) - (halfWidth + 3));
      },
    },
  ]);

  streamSegments[3] = {
    ...streamSegments[3]!,
    outlet: { at: [...streamSegments[3]!.path.at(-1)!] as Vec3, facing: 2, width: (halfWidth + 1) * 2 + 1 },
  };
  const waterSystem: WaterSystemSpec = {
    id: `${spec.id}-water`,
    // The source is a real wet cell of the system: the top of the brook.
    source: [streamX, spec.springY, shelfZ0],
    segments: streamSegments,
    outlet: [...streamSegments[3]!.path.at(-1)!] as Vec3,
    object: objectOf(spec),
  };
  const water = planWaterSystem(waterSystem);

  const diagnostics: Diagnostic[] = [...water.diagnostics];
  const landmarks: ValleyStreamLandmarks = {
    spring: [streamX, spec.springY, shelfZ0],
    fallTop: [streamX, spec.springY, shelfZ1 + 1],
    fallFoot: [streamX, spec.poolY, shelfZ1 + 2],
    pool: [cx, spec.poolY, poolZ],
    outlet: [...streamSegments[3]!.path.at(-1)!] as Vec3,
    crest: [cx, spec.ridgeTop, ridgeZ],
    fallHeight,
  };
  if (water.outlet && water.outlet[2] > region.max[2] - 1)
    diagnostics.push(
      coordinateDiagnostic({
        rule: 'valley.outlet-outside',
        object: objectOf(spec),
        position: [...water.outlet] as Vec3,
        message: `出口 ${water.outlet.join(',')} 落在场地之外，水会从模型边界消失而不是流出场景`,
        source: 'valley-recipe',
      }),
    );
  return {
    id: spec.id,
    object: objectOf(spec),
    spec,
    recipe,
    water,
    plateaus,
    landmarks,
    region,
    diagnostics,
    feasible: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  };
}

export type ValleyStreamReport = Readonly<{
  terrain: TerrainBuildReport;
  water: WaterBuildReport;
  /** Shoreline cells that were given the bank material. */
  bankCells: number;
  diagnostics: readonly Diagnostic[];
  landmarks: ValleyStreamLandmarks;
  /** True when the whole group passed validation and was applied. */
  committed: boolean;
  merges?: ConstructionMergeStats;
}>;

/**
 * Shoreline transition, recorded through the **read-through view**.
 *
 * The band just outside the pool gets the bank material where the ground meets
 * the water — and "the ground" here is the model as it will be after the
 * pending terrain and water operations, not the design height field. Reading
 * the input field instead is how a shore ends up one block off after a carve.
 *
 * The band is several cells deep and its outer edge is broken by a seeded
 * choice, because a single-cell ring of one colour reads as a painted outline
 * rather than a shore.
 */
function recordShore(sink: ConstructionSink, plan: ValleyStreamPlan, spec: ValleyStreamSpec): number {
  const bank = spec.materials.bank;
  if (!bank) return 0;
  const pool = plan.water.segments.find((segment) => segment.spec.kind === 'pool');
  if (!pool) return 0;
  const body = new Set(pool.columns.map((column) => `${column.x},${column.z}`));
  const distances = new Map<string, { x: number; z: number; band: number }>();
  let bankCells = 0;
  const bandDepth = 4;
  for (const column of pool.columns) {
    for (let dx = -bandDepth; dx <= bandDepth; dx++)
      for (let dz = -bandDepth; dz <= bandDepth; dz++) {
        if (dx === 0 && dz === 0) continue;
        const x = column.x + dx;
        const z = column.z + dz;
        if (body.has(`${x},${z}`)) continue;
        const key = `${x},${z}`;
        const band = Math.max(Math.abs(dx), Math.abs(dz));
        if (band < (distances.get(key)?.band ?? Infinity)) distances.set(key, { x, z, band });
      }
  }
  for (const { x, z, band } of [...distances.values()].sort((a, b) => a.x - b.x || a.z - b.z)) {
    const surface = sink.groundY(x, z);
    if (surface === null || surface < spec.poolY || surface > spec.poolY + 2) continue;
    // A cell that already holds planned water (the fall's foot, the outlet's
    // first row) keeps its water: the merge rule says so and records it.
    if (sink.get(x, surface, z)?.name === 'minecraft:water') continue;
    const block = bank([x, surface, z], band);
    if (!block) continue;
    sink.put(x, surface, z, block, {}, 'bank');
    bankCells++;
  }
  return bankCells;
}

/**
 * Build a planned scene as **one joint operation group**.
 *
 * Terrain, water and the shore ring are recorded into a single construction
 * plan and committed together: if the water system, the shoreline or any
 * material callback fails, no terrain is left built. The plan carries its own
 * resolved inputs, so there is no second spec to disagree with.
 */
export function buildValleyStream(world: Structure, plan: ValleyStreamPlan): ValleyStreamReport {
  let terrain = emptyTerrainReport();
  let water: WaterBuildReport = { waterCells: 0, bedCells: 0, bounds: null, diagnostics: [], committed: false };
  let bankCells = 0;
  const spec = plan.spec;
  const construction = planConstruction(world, {
    id: plan.id,
    object: plan.object,
    bounds: { min: [spec.region.min[0], spec.floorY, spec.region.min[2]], max: spec.region.max },
    ...(spec.protection ? { protection: spec.protection } : {}),
    ...(spec.rules ? { rules: spec.rules } : {}),
    // The scene owns its footprint end to end: terrain, body and shore are one
    // designed group, and anything it may not touch is a declared protection.
    excavationAuthorized: true,
    build: (sink) => {
      for (const diagnostic of plan.diagnostics) sink.report(diagnostic);
      if (!plan.feasible || plan.diagnostics.some((d) => d.severity === 'error' || d.severity === 'unknown')) {
        sink.report(
          coordinateDiagnostic({
            rule: 'valley.invalid-plan',
            object: plan.object,
            message: '设计计划不可行，拒绝施工',
            source: 'valley-recipe',
          }),
        );
        return;
      }
      terrain = recordTerrain(sink, plan.recipe, {
        region: plan.region,
        floorY: spec.floorY,
        soilDepth: 3,
        materials: {
          rock: spec.materials.rock,
          ...(spec.materials.soil ? { soil: spec.materials.soil } : {}),
          ...(spec.materials.surface ? { surface: spec.materials.surface } : {}),
        },
        // The terrain merge reads the original model; it is the first phase, so
        // there is nothing pending underneath it yet.
        existing: new SurfaceQuery(world),
        ...(spec.where ? { where: spec.where } : {}),
        object: plan.id,
      });
      water = recordWaterSystem(sink, plan.water, {
        water: spec.materials.water,
        bed: spec.materials.bed,
      });
      bankCells = recordShore(sink, plan, spec);
      // Validate the composed result before any cell reaches the real model.
      for (const diagnostic of checkWaterSystem(sink, plan.water)) sink.report(diagnostic);
    },
  });
  const diagnostics = [...plan.diagnostics, ...construction.diagnostics];
  if (!construction.feasible)
    return {
      terrain: { ...terrain, filled: 0, committed: false, diagnostics },
      water: { ...water, waterCells: 0, bedCells: 0, committed: false, diagnostics },
      bankCells: 0,
      diagnostics,
      landmarks: plan.landmarks,
      committed: false,
    };
  commitConstruction(world, construction);
  return {
    terrain: { ...terrain, filled: terrain.filled, committed: true, diagnostics },
    water: { ...water, waterCells: water.waterCells, committed: true, diagnostics },
    bankCells,
    diagnostics,
    landmarks: plan.landmarks,
    committed: true,
    merges: construction.merges,
  };
}

/** Build the matching water check for a built scene (final-model audit). */
export function checkValleyStream(world: Structure, plan: ValleyStreamPlan): Diagnostic[] {
  return checkWaterSystem(world, plan.water);
}
