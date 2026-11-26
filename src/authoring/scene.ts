import { Structure, assertBox, type Box, type State, type Vec3 } from '../core/structure.js';
import { BlockKit, resolveMaterial, type AuthoringMaterial, type KitDefaults } from './kit.js';
import {
  planConstruction,
  commitConstruction,
  type ConstructionPlan,
  type ConstructionRequest,
  type ConstructionSink,
} from './construction.js';
import { DiagnosticError, coordinateDiagnostic, type Diagnostic } from './diagnostic-core.js';
import {
  attachAuthoringChecks,
  authoredCellRole,
  checkAuthoredModel,
  recordAuthoringPlan,
  registerAuthoringCheck,
  type AuthoringCheck,
} from './model-checks.js';
import { ProtectionRegistry, type ProtectionZoneInput } from './protection.js';
import { auditProtection } from './operators.js';
import { SurfaceQuery, isTerrainSurface } from './surface.js';
import {
  roofSurface,
  gableRoof,
  profileHipRoof,
  alternatingGable,
  type RoofSurfaceSpec,
  type RoofSurfaceMaterials,
  type ProfileRoofSpec,
  type AlternatingGableSpec,
  type RoofPlan,
} from './roof-surface.js';
import { floatingRoofTiles } from './checks.js';
import { matchesRecordedState } from './recorded-geometry.js';
import { tree, treePreset, type TreeSpec, type TreePresetSpec } from './tree.js';
import { railing, type RailingSpec, type RailingStyle } from './railing.js';
import { scatterPlants, type PlantScatterSpec } from './plants.js';
import { terrainRecipe, type TerrainRecipe, type TerrainRecipeSpec } from './terrain/recipe.js';
import { recordTerrain, type TerrainBuildOptions } from './terrain/build.js';
import { planWaterSystem } from './water/plan.js';
import { recordWaterSystem, type WaterMaterials } from './water/build.js';
import { checkWaterSystem } from './water/check.js';
import type { WaterSystemSpec, WaterPlan, WaterSegmentSpec } from './water/contracts.js';
import { planWalkway, checkWalkway, type WalkwaySpec } from './walkway.js';
import { planFinishedCanal, checkFinishedCanal, type CanalSpec } from './canal.js';
import { routeCentreline, waypointHeightAt, type RoadMaterials } from './roads.js';
import {
  planRoadProfile,
  recordRoadProfile,
  checkRoadProfile,
  type RoadProfileSpec,
  type RoadProfileMaterials,
} from './road-profile.js';
import { voxelPath } from './layout.js';
import {
  planGrounding,
  recordGrounding,
  checkGrounding,
  type GroundingSpec,
  type GroundingMaterials,
} from './grounding.js';
import { planVegetation, checkVegetation, type VegetationSpec } from './vegetation.js';
import { woodlandSpec, type WoodlandSpec } from './woodland.js';
import { planPlacement, type PlacementRequest } from './placement.js';
import type { ProtectionRuleSet } from './rules.js';

/** Fixed strings/states are as valid as callbacks. Geometry builders keep their own signatures. */
export type MaterialInputs<T> = {
  readonly [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? R extends State | null
      ? | AuthoringMaterial
        | (null extends R ? null : never)
        | ((...args: A) => AuthoringMaterial | (null extends R ? null : never))
      : T[K]
    : T[K];
};

function materials<T>(input: MaterialInputs<T>, keys: readonly string[]): T {
  const output = { ...input } as Record<string, unknown>;
  for (const key of keys) {
    const value = output[key];
    if (value === undefined) continue;
    output[key] = (...args: unknown[]) => {
      const selected = typeof value === 'function' ? value(...args) : value;
      return selected === null ? null : resolveMaterial(selected as AuthoringMaterial);
    };
  }
  return output as T;
}

function roadMaterials<T extends RoadMaterials>(input: MaterialInputs<T>, keys: readonly string[]): T {
  const resolved = materials<T>(input, keys);
  const stair = input.stairs;
  if (stair !== undefined && typeof stair !== 'function')
    (resolved as { stairs: RoadMaterials['stairs'] }).stairs = (_, direction) =>
      stair === null ? null : resolveMaterial(stair, { weirdo_direction: direction });
  return resolved;
}

export type SceneOptions = Readonly<{
  bounds: Box;
  seed?: number;
  defaults?: KitDefaults;
  rules?: ProtectionRuleSet;
  /** An existing structure remains the sole voxel authority. */
  world?: Structure;
}>;
export type ComponentOptions = Readonly<{
  bounds?: Box;
  /** Ordinary objects may replace terrain. Replacing other construction is explicit. */
  overlap?: 'empty' | 'terrain' | 'replace' | ((existing: State | null, position: Vec3) => boolean);
}>;
type Reader = Pick<Structure, 'get'>;
type GeometryCheck<R> = (world: Reader, result: R) => readonly Diagnostic[];
type SceneWaterMaterials = Omit<MaterialInputs<WaterMaterials>, 'water'> & {
  water?: MaterialInputs<WaterMaterials>['water'];
};
/** A route is a few control points; path is an explicitly sampled water profile. */
export type SceneWaterSegment = Omit<WaterSegmentSpec, 'path'> &
  ({ route: readonly Vec3[]; path?: never } | { path: readonly Vec3[]; route?: never });
export type SceneWaterSpec = Omit<WaterSystemSpec, 'id' | 'segments'> & { segments: readonly SceneWaterSegment[] };
export type SceneRoadSpec = Partial<Omit<RoadProfileSpec, 'id' | 'waypoints'>> & { route: readonly Vec3[] };

function waterPlan(id: string, spec: SceneWaterSpec | WaterPlan): WaterPlan {
  if ('feasible' in spec) return spec;
  return planWaterSystem({
    ...spec,
    id,
    segments: spec.segments.map((segment) => {
      const { route, ...rest } = segment;
      const path =
        segment.path ??
        (route!.length < 2 || segment.kind === 'drop' || segment.kind === 'wall-sheet'
          ? voxelPath(route!)
          : routeCentreline(route!).map(
              ({ x, z, segment: part, fraction }) => [x, waypointHeightAt(route!, part, fraction), z] as Vec3,
            ));
      return { ...rest, path };
    }),
  });
}

/**
 * A shared authoring entry: one Structure, one surface query, one protection
 * registry, atomic components, and final checks consumed by build/check.
 * No second voxel world or independent transaction implementation.
 */
export class AuthoringScene {
  readonly world: Structure;
  readonly bounds: Box;
  readonly seed: number;
  readonly surfaces: SurfaceQuery;
  readonly protection: ProtectionRegistry;
  readonly #defaults: KitDefaults;
  readonly #rules: ProtectionRuleSet;
  readonly #ids = new Set<string>();
  #busy = false;

  constructor(options: SceneOptions) {
    assertBox(options.bounds);
    this.bounds = structuredClone(options.bounds);
    this.seed = options.seed ?? 0;
    if (!Number.isSafeInteger(this.seed)) throw new Error('Scene seed must be an integer');
    this.world = options.world ?? new Structure();
    this.#defaults = options.defaults ?? {};
    this.#rules = options.rules ?? [];
    this.surfaces = new SurfaceQuery(this.world, {
      minY: this.bounds.min[1],
      maxY: this.bounds.max[1],
      scanLimit: this.bounds.max[1] - this.bounds.min[1] + 1,
      airStopsTerrain: false,
    });
    this.protection = new ProtectionRegistry(this.bounds, { rules: this.#rules });
    attachAuthoringChecks(this.world, this.protection);
    registerAuthoringCheck(this.world, 'scene.protection', (world) => auditProtection(world, this.protection));
  }

  #available(id: string): void {
    if (this.#busy) throw new Error('Build inside the supplied kit; scene components cannot be nested during planning');
    if (!id.trim()) throw new Error('A component needs a nonempty id');
    if (this.#ids.has(id)) throw new Error(`Duplicate scene component: ${id}`);
  }

  #options(id: string, options: ComponentOptions): Omit<ConstructionRequest, 'build'> {
    const overlap = options.overlap ?? 'terrain';
    const allowed =
      typeof overlap === 'function'
        ? overlap
        : overlap === 'terrain'
          ? (state: State | null, position: Vec3) => {
              const role = authoredCellRole(this.world, position);
              return role === 'terrain' || (role === undefined && isTerrainSurface(state?.name ?? null));
            }
          : () => overlap === 'replace';
    return {
      id,
      object: { kind: 'component', id },
      bounds: this.#region(options.bounds),
      protection: this.protection,
      rules: this.#rules,
      excavationAuthorized: overlap === 'replace',
      overlapAllowed: allowed,
      carveAllowed: allowed,
    };
  }

  #region(region = this.bounds): Box {
    assertBox(region);
    if (region.min.some((v, i) => v < this.bounds.min[i]) || region.max.some((v, i) => v > this.bounds.max[i]))
      throw new Error('Component bounds must stay inside the scene bounds');
    return region;
  }

  #commit(id: string, plan: ConstructionPlan, check?: AuthoringCheck): void {
    if (!plan.feasible) throw new DiagnosticError(plan.diagnostics);
    commitConstruction(this.world, plan);
    recordAuthoringPlan(this.world, plan);
    this.#ids.add(id);
    if (check) registerAuthoringCheck(this.world, `component:${id}`, check);
  }

  #planning<R>(id: string, action: () => R): R {
    this.#available(id);
    this.#busy = true;
    try {
      return action();
    } finally {
      this.#busy = false;
    }
  }

  #build<R>(
    id: string,
    build: (kit: BlockKit, sink: ConstructionSink) => R,
    options: ComponentOptions,
    check?: GeometryCheck<R>,
  ): R {
    let result!: R;
    const plan = this.#planning(id, () =>
      planConstruction(this.world, {
        ...this.#options(id, options),
        build: (sink) => {
          result = build(new BlockKit(sink, this.#defaults), sink);
          if (result && typeof (result as { then?: unknown }).then === 'function')
            throw new Error('Component builders are synchronous; an async callback cannot be committed');
          if (check) for (const diagnostic of check(sink, result)) sink.report(diagnostic);
        },
      }),
    );
    this.#commit(id, plan, check ? (world) => check(world, result) : undefined);
    return result;
  }

  /** Arbitrary geometry uses the same actions and atomic path as built-in components. */
  draw<R>(id: string, build: (kit: BlockKit) => R, options: ComponentOptions = {}): R {
    return this.#build(id, build, options);
  }

  /** Keep a scene-specific final assertion without writing a separate building check. */
  verify(id: string, check: AuthoringCheck): void {
    if (this.#busy) throw new Error('Register final checks outside component builders');
    registerAuthoringCheck(this.world, `custom:${id}`, check);
  }

  protect(zone: ProtectionZoneInput): void {
    if (this.#busy) throw new Error('Declare protection outside component builders');
    this.protection.add(zone);
  }

  check(): Diagnostic[] {
    return checkAuthoredModel(this.world);
  }

  #roofCheck(id: string): GeometryCheck<RoofPlan> {
    return (world, plan) =>
      floatingRoofTiles(new BlockKit({ put: () => {}, air: () => {}, get: (...p) => world.get(...p) }), plan).map(
        (position) =>
          coordinateDiagnostic({ rule: 'roof.floating', object: id, position, message: '屋面格没有邻接支撑' }),
      );
  }

  roof(id: string, spec: RoofSurfaceSpec, palette: RoofSurfaceMaterials, options: ComponentOptions = {}): RoofPlan {
    return this.#build(id, (kit) => roofSurface(kit, spec, palette), options, this.#roofCheck(id));
  }

  gableRoof(
    id: string,
    spec: Parameters<typeof gableRoof>[1],
    palette: RoofSurfaceMaterials,
    options: ComponentOptions = {},
  ): RoofPlan {
    return this.#build(id, (kit) => gableRoof(kit, spec, palette), options, this.#roofCheck(id));
  }

  hipRoof(id: string, spec: ProfileRoofSpec, palette: RoofSurfaceMaterials, options: ComponentOptions = {}): RoofPlan {
    return this.#build(id, (kit) => profileHipRoof(kit, spec, palette), options, this.#roofCheck(id));
  }

  alternatingGable(id: string, spec: AlternatingGableSpec, options: ComponentOptions = {}): RoofPlan {
    return this.#build(id, (kit) => alternatingGable(kit, spec), options, this.#roofCheck(id));
  }

  tree(id: string, spec: Omit<TreeSpec, 'collision'>, options: ComponentOptions = {}) {
    return this.#build(
      id,
      (kit) => tree(kit, { ...spec, collision: 'replace' }),
      options,
      this.#treeCheck(id, spec.origin ?? [0, 0, 0]),
    );
  }

  treePreset(id: string, spec: Omit<TreePresetSpec, 'collision'>, options: ComponentOptions = {}) {
    return this.#build(
      id,
      (kit) => treePreset(kit, { seed: this.seed, ...spec, collision: 'replace' }),
      options,
      this.#treeCheck(id, spec.origin),
    );
  }

  #treeCheck(id: string, offset: Vec3): GeometryCheck<ReturnType<typeof tree>> {
    const origin: Vec3 = [...offset];
    let cells: { position: Vec3; state: State }[] | undefined;
    let floating: Diagnostic[] = [];
    return (world, result) => {
      // Freeze the generated contract once. The returned local template and
      // author input may subsequently be reused or changed without moving it.
      if (!cells) {
        cells = [];
        result.structure.forEach((x, y, z, state) =>
          cells!.push({
            position: [x + origin[0], y + origin[1], z + origin[2]],
            state: result.structure.palette[state]!,
          }),
        );
        floating = result.floating.map(([x, y, z]) =>
          coordinateDiagnostic({
            rule: 'tree.floating',
            object: id,
            position: [x + origin[0], y + origin[1], z + origin[2]],
            message: '树冠未与枝干连接',
          }),
        );
      }
      return [
        ...floating,
        ...cells
          .filter((cell) => !matchesRecordedState(world, cell.position, cell.state))
          .map((cell) =>
            coordinateDiagnostic({
              rule: 'tree.changed-cell',
              object: id,
              position: cell.position,
              message: '最终树形缺少已生成的枝干或树冠，或其状态被改变',
            }),
          ),
      ];
    };
  }

  railing(id: string, spec: RailingSpec, style: RailingStyle, options: ComponentOptions = {}) {
    return this.#build(id, (kit) => railing(kit, spec, style), options);
  }

  plants(
    id: string,
    spec: Omit<PlantScatterSpec, 'surfaceY'> & { surfaceY?: PlantScatterSpec['surfaceY'] },
    options: ComponentOptions = {},
  ) {
    return this.#build(
      id,
      (kit) =>
        scatterPlants(kit, {
          seed: this.seed,
          ...spec,
          surfaceY: spec.surfaceY ?? ((x, z) => this.surfaces.terrain(x, z)),
        }),
      options,
    );
  }

  terrain(
    id: string,
    recipe: TerrainRecipe | (Omit<TerrainRecipeSpec, 'seed'> & { seed?: number }),
    spec: Omit<TerrainBuildOptions, 'region' | 'floorY' | 'materials'> & {
      region?: Box;
      floorY?: number;
      materials: MaterialInputs<TerrainBuildOptions['materials']>;
    },
    options: ComponentOptions = {},
  ) {
    const resolved = 'at' in recipe ? recipe : terrainRecipe({ seed: this.seed, ...recipe });
    return this.#build(
      id,
      (_, sink) =>
        recordTerrain(sink, resolved, {
          ...spec,
          region: spec.region ?? this.bounds,
          floorY: spec.floorY ?? this.bounds.min[1],
          existing: spec.existing ?? this.surfaces,
          object: id,
          materials: materials(spec.materials, ['rock', 'soil', 'surface']),
        }),
      options,
    );
  }

  water(
    id: string,
    spec: SceneWaterSpec | WaterPlan,
    palette: SceneWaterMaterials,
    options: ComponentOptions = {},
  ): WaterPlan {
    const plan = this.#planning(id, () => waterPlan(id, spec));
    this.#build(
      id,
      (_, sink) =>
        recordWaterSystem(
          sink,
          plan,
          materials<WaterMaterials>({ water: 'water', ...palette }, ['water', 'bed', 'wall']),
        ),
      options,
      (world) => checkWaterSystem(world, plan),
    );
    return plan;
  }

  walkway(
    id: string,
    spec: Omit<WalkwaySpec, 'id' | 'materials'> & { materials: MaterialInputs<WalkwaySpec['materials']> },
    options: ComponentOptions = {},
  ) {
    const plan = this.#planning(id, () =>
      planWalkway(
        this.world,
        {
          ...spec,
          id,
          materials: roadMaterials(spec.materials, ['surface', 'support', 'stairs', 'slab', 'beam', 'pier', 'rail']),
        },
        this.#options(id, options),
      ),
    );
    this.#commit(id, plan.construction, (world) => checkWalkway(world, plan));
    return plan;
  }

  canal(
    id: string,
    spec: Omit<CanalSpec, 'water' | 'materials'> & {
      water: SceneWaterSpec | WaterPlan;
      materials: Omit<MaterialInputs<CanalSpec['materials']>, 'water'> & {
        water?: MaterialInputs<CanalSpec['materials']>['water'];
      };
    },
    options: ComponentOptions = {},
  ) {
    const plan = this.#planning(id, () => {
      const water = waterPlan(id, spec.water);
      return planFinishedCanal(
        this.world,
        {
          ...spec,
          water,
          materials: materials<CanalSpec['materials']>({ water: 'water', ...spec.materials }, [
            'water',
            'bed',
            'wall',
            'bank',
          ]),
        },
        this.#options(id, options),
      );
    });
    this.#commit(id, plan.construction, (world) => checkFinishedCanal(world, plan));
    return plan;
  }

  road(id: string, spec: SceneRoadSpec, palette: MaterialInputs<RoadProfileMaterials>, options: ComponentOptions = {}) {
    const width = spec.width ?? 3,
      maxCut = spec.maxCut ?? 8,
      maxFill = spec.maxFill ?? 16;
    const levels = spec.route.map((point) => point[1]);
    const plan = this.#planning(id, () =>
      planRoadProfile(this.world, {
        ...spec,
        id,
        waypoints: spec.route,
        width,
        maxCut,
        maxFill,
        minY: spec.minY ?? Math.max(this.bounds.min[1], Math.min(...levels) - maxCut),
        maxY: spec.maxY ?? Math.min(this.bounds.max[1] - 1, Math.max(...levels) + maxFill),
        earthworkBudget: spec.earthworkBudget ?? routeCentreline(spec.route).length * width * (maxCut + maxFill),
        landingLength: spec.landingLength ?? Math.max(2, width),
        bounds: spec.bounds ?? this.bounds,
      }),
    );
    this.#build(
      id,
      (_, sink) =>
        recordRoadProfile(
          sink,
          this.world,
          plan,
          roadMaterials(palette, ['surface', 'support', 'stairs', 'slab', 'bridgeEdge', 'bridgeRailing']),
        ),
      options,
      (world) => checkRoadProfile(world, plan),
    );
    return plan;
  }

  grounding(
    id: string,
    spec: Omit<GroundingSpec, 'id'>,
    palette: MaterialInputs<GroundingMaterials>,
    options: ComponentOptions = {},
  ) {
    const plan = this.#planning(id, () => planGrounding(this.world, { ...spec, id }));
    this.#build(
      id,
      (_, sink) => recordGrounding(sink, this.world, plan, materials(palette, ['floor', 'foundation', 'transition'])),
      options,
      // Interior clearance is validated before superstructure is added. Final
      // checks keep the floor/foundation contract, allowing authored columns.
      (world) => checkGrounding(world, plan, { interior: false }),
    );
    return plan;
  }

  vegetation(
    id: string,
    spec: Omit<VegetationSpec, 'id' | 'height' | 'bounds' | 'protection' | 'rules'> & {
      height?: VegetationSpec['height'];
      bounds?: Box;
    },
  ) {
    const plan = this.#planning(id, () =>
      planVegetation(this.world, {
        ...spec,
        id,
        height: spec.height ?? ((x, z) => this.surfaces.terrain(x, z) ?? this.bounds.min[1] - 1),
        bounds: this.#region(spec.bounds),
        protection: this.protection,
        rules: this.#rules,
      }),
    );
    this.#commit(id, plan.construction, (world) => checkVegetation(world, plan.report));
    return { ...plan.report, committed: true };
  }

  woodland(
    id: string,
    spec: Omit<WoodlandSpec, 'id' | 'bounds' | 'seed' | 'protection'> & { bounds?: Box; seed?: number },
  ) {
    return this.vegetation(
      id,
      woodlandSpec(this.world, {
        bounds: this.bounds,
        seed: this.seed,
        ...spec,
        id,
        protection: this.protection,
      }),
    );
  }

  place(
    id: string,
    spec: Omit<
      PlacementRequest,
      'object' | 'bounds' | 'protection' | 'rules' | 'overlapAllowed' | 'carveAllowed' | 'foundation'
    > & {
      foundation?: MaterialInputs<Pick<PlacementRequest, 'foundation'>>['foundation'];
    },
    options: ComponentOptions = {},
  ) {
    const common = this.#options(id, options);
    const { foundation, ...placement } = spec;
    const plan = this.#planning(id, () =>
      planPlacement(this.world, {
        ...placement,
        ...materials<Pick<PlacementRequest, 'foundation'>>({ foundation }, ['foundation']),
        object: common.object,
        bounds: common.bounds,
        protection: this.protection,
        rules: this.#rules,
        overlapAllowed: options.overlap === 'replace' ? () => true : common.overlapAllowed,
        carveAllowed: common.carveAllowed,
      }),
    );
    if (plan.diagnostics.some((d) => d.severity === 'error' || d.severity === 'unknown'))
      throw new DiagnosticError(plan.diagnostics);
    // Resolve transformed prefab and foundation states through the same
    // registry-validated transaction as every other scene component.
    this.#build(
      id,
      (_, sink) => {
        for (const diagnostic of plan.diagnostics) sink.report(diagnostic);
        for (const position of plan.carves) sink.air(...position);
        for (const write of plan.writes) sink.put(...write.position, write.state);
      },
      options,
    );
    return plan;
  }
}

export function createScene(options: SceneOptions): AuthoringScene {
  return new AuthoringScene(options);
}
