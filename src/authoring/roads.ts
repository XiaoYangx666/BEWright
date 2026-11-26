import type { Box, State, Vec3 } from '../core/structure.js';
import { coordinateDiagnostic, type Diagnostic, type DiagnosticObject } from './diagnostics.js';
import { SurfaceQuery } from './surface.js';
import { collisionBoxes } from './traversal.js';
import { coordinateRandom } from './layout.js';
import {
  commitConstruction,
  planConstruction,
  type ConstructionMergeStats,
  type ConstructionRole,
} from './construction.js';
import type { ProtectionRegistry } from './protection.js';
import type { ProtectionRuleSet } from './rules.js';

/**
 * 道路：**路线规划**与**铺装生成**是两件事。
 *
 * 规划只决定"从哪里到哪里、经过哪些格、每格什么标高"，并按坡度、宽度、转弯、
 * 保护区与削填成本判断可行性；无解时报错而不是生成一条看着连着却走不过去的路。
 * 铺装拿到已经可行的路线后才落方块，并用**实际碰撞几何**复核最终通行。
 *
 * 第一版不模拟流体、不做寻路 AI；规划是显式的折线 + 逐格标高推导。
 */

export const ROAD_RULES = {
  noRoute: 'road.no-route',
  tooSteep: 'road.too-steep',
  turnTooTight: 'road.turn-too-tight',
  protection: 'road.protection',
  excavation: 'road.excavation-budget',
  unpaved: 'road.unpaved',
  impassable: 'road.impassable',
  stepTooHigh: 'road.step-too-high',
  widthBlocked: 'road.width-blocked',
  centrelineGap: 'road.centreline-gap',
  unresolvedHeight: 'road.unresolved-height',
  unsupported: 'road.unsupported',
} as const;

/** How a route deals with a height change between neighbouring steps. */
export type RoadStrategy = 'stairs' | 'slab' | 'bridge' | 'cut';

export type RoadProfile = Readonly<{
  /** Walkable width in blocks (>= 1). */
  width: number;
  /** Maximum rise per step the route may plan for. */
  maxStepUp: number;
  /** Maximum drop per step the route may plan for. */
  maxStepDown: number;
  /** Preferred strategy for height changes. */
  strategy: RoadStrategy;
  /** Total blocks the route may excavate (cut/fill) before planning fails. */
  excavationBudget?: number;
  /**
   * Gap height (in blocks, between the ground top and the deck bottom) at which
   * a cell becomes a **bridge span** instead of an embankment.
   *
   * `RoadCell.fill` is that same gap height, so with the default of 1 any gap
   * is a span; raise it (e.g. 3) when low embankments should be filled instead.
   */
  bridgeFromHeight?: number;
  /** Protection zones consulted while planning. */
  object: DiagnosticObject | string;
}>;

export const DEFAULT_ROAD_PROFILE: Omit<RoadProfile, 'object'> = {
  width: 3,
  maxStepUp: 1,
  maxStepDown: 1,
  strategy: 'stairs',
  bridgeFromHeight: 1,
};

export type RoadPlanOptions = Readonly<{
  /** Polyline the route follows; each point is a waypoint, inclusive. */
  waypoints: readonly Vec3[];
  profile: RoadProfile;
  surface?: SurfaceQuery;
  bounds?: Box;
  /** Height source for each cell; defaults to the polyline's own interpolation. */
  heightAt?: (x: number, z: number, fraction: number) => number | null;
  /** Reject a cell before it is even planned (protection, ownership, where). */
  where?: (x: number, z: number) => boolean;
}>;

export type RoadCell = Readonly<{
  x: number;
  z: number;
  /**
   * **Block** Y of the pavement block itself — the block the player stands on.
   *
   * This is deliberately not a player-foot level: the finished foot height is
   * the collision top of whatever material ends up in this cell (`y + 1` for a
   * full block, `y + 0.5` for a slab). Planning, paving and the passability
   * check all speak this one convention; mixing it with "the cell under the
   * feet" is what used to make a freshly paved road fail its own check.
   */
  y: number;
  /** Distance along the route, in centreline cells. */
  step: number;
  /** Local widening offset across the route; 0 is the centreline. */
  lateral: number;
  /** Planned strategy at this cell. */
  strategy: RoadStrategy;
  /**
   * Height change from the previous centreline step (0 on the first step and on
   * flat ground). Sign says whether this tread climbs or descends, which is what
   * stair facing and "only put stairs where the road actually steps" need.
   */
  rise: number;
  /** Engineered profiles place a stair on the high cell of each drop. null means a full landing. */
  stairDirection?: number | null;
  /** Blocks this cell expects to excavate. */
  cut: number;
  /** Blocks this cell expects to add as fill/foundation. */
  fill: number;
  /** True when the cell crosses a gap and needs a bridge deck. */
  bridge: boolean;
}>;

export type RoadPlan = Readonly<{
  cells: readonly RoadCell[];
  fraction: readonly number[];
  bounds: Box;
  profile: RoadProfile;
  /** Per-step height differences along the route centreline. */
  stepRises: readonly number[];
  diagnostics: readonly Diagnostic[];
  feasible: boolean;
  /** Worst rise found on the planned centreline. */
  maxRise: number;
  /** Blocks that the plan expects to remove. */
  cutBlocks: number;
  /** Blocks that the plan expects to add. */
  fillBlocks: number;
  /** Cells the plan needed but `where()` refused. */
  maskedCells: number;
  /** Cells that could not be given a height at all. */
  unresolvedCells: number;
}>;

/** One rasterized centreline cell: which polyline segment produced it and how far along. */
export type RoutePoint = Readonly<{
  x: number;
  z: number;
  /** Index of the polyline segment: `waypoints[segment] -> waypoints[segment + 1]`. */
  segment: number;
  /** Progress within that segment, 0..1 and non-decreasing along the raster. */
  fraction: number;
}>;

/**
 * Integer Bresenham, one axis per iteration: consecutive cells always share a
 * face.
 *
 * Stepping both axes at once (`round(from + delta * t)`) produces diagonal
 * jumps, and a centreline that is only diagonally connected is not walkable
 * even though it looks continuous on a map. The fraction is the closest-point
 * progress along the segment, clamped to be monotone so height interpolation
 * can never walk backwards on a raster cell.
 */
function rasterLine(from: Vec3, to: Vec3, segment: number): RoutePoint[] {
  const x0 = from[0];
  const z0 = from[2];
  const x1 = to[0];
  const z1 = to[2];
  const dx = x1 - x0;
  const dz = z1 - z0;
  const stepsX = Math.abs(dx);
  const stepsZ = Math.abs(dz);
  const stepX = dx > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const lengthSquared = dx * dx + dz * dz;
  const cells: RoutePoint[] = [];
  let x = x0;
  let z = z0;
  let error = stepsX - stepsZ;
  let previous = 0;
  for (;;) {
    const projected = lengthSquared === 0 ? 0 : ((x - x0) * dx + (z - z0) * dz) / lengthSquared;
    const fraction = Math.max(previous, Math.min(1, projected));
    previous = fraction;
    cells.push({ x, z, segment, fraction });
    if (x === x1 && z === z1) break;
    const doubled = 2 * error;
    if (doubled > -stepsZ && x !== x1) {
      // One axis per iteration — never both, which is what keeps the raster
      // face-connected instead of letting it cut corners diagonally.
      error -= stepsZ;
      x += stepX;
    } else if (z !== z1) {
      error += stepsX;
      z += stepZ;
    } else {
      error -= stepsZ;
      x += stepX;
    }
  }
  return cells;
}

/** Centreline cells of a polyline, face-connected and order-preserving. */
export function routeCentreline(waypoints: readonly Vec3[]): RoutePoint[] {
  if (waypoints.length < 2) throw new Error('A road route needs at least two waypoints');
  const out: RoutePoint[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const segment = rasterLine(waypoints[i - 1]!, waypoints[i]!, i - 1);
    for (const [index, cell] of segment.entries()) {
      // The shared waypoint was already emitted by the previous segment.
      if (i > 1 && index === 0) continue;
      out.push(cell);
    }
  }
  return out;
}

/**
 * Default height source: the waypoints' own Y, linearly interpolated along the
 * segment and rounded to a block.
 *
 * Omitting `heightAt` must mean "follow the heights I declared", not "every
 * cell is unresolved" — a default that cannot produce a route makes the common
 * call useless.
 */
export function waypointHeightAt(waypoints: readonly Vec3[], segment: number, fraction: number): number {
  const from = waypoints[segment] ?? waypoints[0]!;
  const to = waypoints[segment + 1] ?? from;
  return Math.round(from[1] + (to[1] - from[1]) * fraction);
}

/**
 * Plan a route. Nothing is written: the result is a cell list plus diagnostics.
 * When the plan is not feasible the caller must not pave it.
 */
export function planRoad(options: RoadPlanOptions): RoadPlan {
  const profile = options.profile;
  const object: DiagnosticObject =
    typeof profile.object === 'string' ? { kind: 'route', id: profile.object } : profile.object;
  const diagnostics: Diagnostic[] = [];
  if (!Number.isSafeInteger(profile.width) || profile.width < 1)
    throw new Error('Road width must be a positive integer');
  const centre = routeCentreline(options.waypoints);
  const cells: RoadCell[] = [];
  const stepRises: number[] = [];
  /*
   * Lateral offsets for a road of `width`:
   *
   *   width 1 -> [0]        width 2 -> [-1, 0]      width 3 -> [-1, 0, 1]
   *   width 4 -> [-2, -1, 0, 1]
   *
   * `floor((width - 1) / 2)` on both sides silently drops a column on every
   * even width, so a "4 wide" road came out 3 wide. The centreline stays a real
   * cell of the road, and the extra column of an even width goes on the
   * negative lateral side.
   */
  const laterals: number[] = [];
  for (let index = 0; index < profile.width; index++) laterals.push(index - Math.floor(profile.width / 2));
  let previous: number | null = null;
  let cutBlocks = 0;
  let fillBlocks = 0;
  let maskedCells = 0;
  let unresolvedCells = 0;
  let maxRise = 0;
  const seen = new Set<string>();

  // The centreline must be face-connected; a diagonal jump is a broken route,
  // not a stylistic shortcut. Rasterization guarantees it, so this is a guard
  // that keeps a future sampling change from silently reintroducing the bug.
  for (let index = 1; index < centre.length; index++) {
    const a = centre[index - 1]!;
    const b = centre[index]!;
    if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== 1)
      diagnostics.push(
        coordinateDiagnostic({
          rule: ROAD_RULES.centrelineGap,
          object,
          position: [b.x, options.waypoints[b.segment]?.[1] ?? 0, b.z],
          message: `路线中心线在 ${a.x},${a.z} 与 ${b.x},${b.z} 之间不是面连通，玩家无法连续行走`,
          data: { from: [a.x, a.z], to: [b.x, b.z] },
          source: 'road-plan',
        }),
      );
  }

  let unresolvedPosition: Vec3 | null = null;
  centre.forEach((point, step) => {
    const { x, z, fraction, segment } = point;
    const height = options.heightAt
      ? options.heightAt(x, z, fraction)
      : waypointHeightAt(options.waypoints, segment, fraction);
    if (height === null || height === undefined || !Number.isFinite(height)) {
      unresolvedCells++;
      unresolvedPosition ??= [x, options.waypoints[segment]?.[1] ?? 0, z];
      return;
    }
    const y = height;
    const rise = previous === null ? 0 : y - previous;
    if (previous !== null) {
      stepRises.push(rise);
      maxRise = Math.max(maxRise, Math.abs(rise));
      const limit = rise >= 0 ? profile.maxStepUp : profile.maxStepDown;
      if (Math.abs(rise) > limit) {
        diagnostics.push(
          coordinateDiagnostic({
            rule: ROAD_RULES.tooSteep,
            object,
            position: [x, y, z],
            message: `第 ${step} 步高差 ${rise} 超过路线允许的 ${limit}`,
            data: { rise, limit, strategy: profile.strategy },
            source: 'road-plan',
          }),
        );
      }
    }
    previous = y;
    // Lateral widening runs perpendicular to the local direction, so the road
    // is `width` blocks wide along its whole length, including at diagonals.
    const next = centre[step + 1] ?? point;
    const prev = centre[step - 1] ?? point;
    const dx = Math.sign(next.x - prev.x);
    const dz = Math.sign(next.z - prev.z);
    const perpendicular: [number, number] = dz === 0 ? [0, 1] : dx === 0 ? [1, 0] : [dz, -dx];
    for (const lateral of laterals) {
      const cx = x + perpendicular[0] * lateral;
      const cz = z + perpendicular[1] * lateral;
      const key = `${cx},${cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        options.bounds &&
        !(
          cx >= options.bounds.min[0] &&
          cx < options.bounds.max[0] &&
          cz >= options.bounds.min[2] &&
          cz < options.bounds.max[2]
        )
      ) {
        diagnostics.push(
          coordinateDiagnostic({
            rule: ROAD_RULES.noRoute,
            object,
            position: [cx, y, cz],
            message: `${cx},${cz} 落在地块边界之外`,
            source: 'road-plan',
          }),
        );
        continue;
      }
      if (options.where && !options.where(cx, cz)) {
        maskedCells++;
        continue;
      }
      const ground = options.surface?.terrain(cx, cz) ?? null;
      const cut = ground !== null && ground > y ? ground - y : 0;
      const fill = ground !== null && ground < y - 1 ? y - 1 - ground : 0;
      const bridge = profile.strategy === 'bridge' && ground !== null && y - ground > (profile.bridgeFromHeight ?? 1);
      cutBlocks += cut;
      fillBlocks += fill;
      cells.push({ x: cx, z: cz, y, step, lateral, strategy: profile.strategy, rise, cut, fill, bridge });
    }
  });

  if (unresolvedCells)
    diagnostics.push(
      coordinateDiagnostic({
        rule: ROAD_RULES.unresolvedHeight,
        object,
        position: [...(unresolvedPosition ?? options.waypoints[0]!)] as Vec3,
        message: `有 ${unresolvedCells} 个中心线格没有标高，路线会出现断口；heightAt 返回 null 时不能铺装`,
        data: { cells: unresolvedCells },
        source: 'road-plan',
      }),
    );

  // Turn check: a route that doubles back on itself in one cell cannot be walked.
  for (let i = 2; i < centre.length; i++) {
    const a = centre[i - 2]!,
      b = centre[i - 1]!,
      c = centre[i]!;
    if (a.x === c.x && a.z === c.z && !(a.x === b.x && a.z === b.z)) {
      diagnostics.push(
        coordinateDiagnostic({
          rule: ROAD_RULES.turnTooTight,
          object,
          position: [b.x, cells.find((cell) => cell.step === i - 1)?.y ?? 0, b.z],
          message: `第 ${i} 步原地折返，路线在 ${b.x},${b.z} 处不可通行`,
          source: 'road-plan',
        }),
      );
      break;
    }
  }

  if (profile.excavationBudget !== undefined && cutBlocks + fillBlocks > profile.excavationBudget)
    diagnostics.push(
      coordinateDiagnostic({
        rule: ROAD_RULES.excavation,
        object,
        region: boundsOf(cells),
        message: `路线需要削填 ${cutBlocks + fillBlocks} 格，超过预算 ${profile.excavationBudget}`,
        data: { cut: cutBlocks, fill: fillBlocks, budget: profile.excavationBudget },
        source: 'road-plan',
      }),
    );

  if (!cells.length && !diagnostics.length)
    diagnostics.push(
      coordinateDiagnostic({
        rule: ROAD_RULES.noRoute,
        object,
        region: options.bounds ?? { min: [0, 0, 0], max: [0, 0, 0] },
        message: '路线没有产生任何可铺装的格子',
        source: 'road-plan',
      }),
    );

  const bounds = boundsOf(cells);
  const feasible = !diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return {
    cells,
    fraction: centre.map((point) => point.fraction),
    bounds,
    profile,
    stepRises,
    diagnostics,
    feasible,
    maxRise,
    cutBlocks,
    fillBlocks,
    maskedCells,
    unresolvedCells,
  };
}

function boundsOf(cells: readonly { x: number; y: number; z: number }[]): Box {
  if (!cells.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const cell of cells) {
    min[0] = Math.min(min[0], cell.x);
    min[1] = Math.min(min[1], cell.y);
    min[2] = Math.min(min[2], cell.z);
    max[0] = Math.max(max[0], cell.x + 1);
    max[1] = Math.max(max[1], cell.y + 1);
    max[2] = Math.max(max[2], cell.z + 1);
  }
  return { min, max };
}

export type RoadBuildTarget = Readonly<{
  put(
    x: number,
    y: number,
    z: number,
    material: import('./kit.js').AuthoringMaterial,
    states?: Record<string, string | number | boolean>,
    role?: ConstructionRole,
  ): void;
  air(x: number, y: number, z: number, role?: ConstructionRole): void;
  s: import('../core/structure.js').Structure;
  report?(diagnostic: Diagnostic): void;
}>;

export type RoadBuildOptions = Readonly<{
  protection?: ProtectionRegistry;
  rules?: ProtectionRuleSet;
  /** The route holds excavation authority, so cut cells are its own work. */
  excavationAuthorized?: boolean;
}>;

export type RoadMaterials = Readonly<{
  /** Block laid at each walking cell; when omitted the plan is not paved. */
  surface?: (cell: RoadCell) => State | null;
  /** Block used under a bridge span or as foundation. */
  support?: (cell: RoadCell, depth: number) => State | null;
  /** Stair block for `stairs` strategy; only asked for where the road really steps. */
  stairs?: (cell: RoadCell, direction: number) => State | null;
  /** Slab block for `slab` strategy. */
  slab?: (cell: RoadCell) => State | null;
}>;

export type RoadPaving = Readonly<{
  placed: number;
  /** Cells the material callbacks declined to pave — a hole in the deck. */
  skipped: number;
  removed: number;
  cells: readonly RoadCell[];
  diagnostics: readonly Diagnostic[];
  /** True when the plan passed validation and was applied to the model. */
  committed: boolean;
  merges?: ConstructionMergeStats;
}>;

/**
 * Record a pavement into a target (a real kit, or a construction recorder).
 *
 * The surface block is written **at `cell.y`**, exactly the block the
 * passability check will read. Stairs are laid only where the tread actually
 * changes height: a flat stretch of a "stairs" road is plain pavement, and a
 * callback that declines a stair falls back to the surface material instead of
 * leaving a hole.
 *
 * This is the geometry/material pass. Whether the model may be touched, and
 * whether anything at all is applied when a later phase fails, is decided by
 * the construction plan around it.
 */
export function recordRoadPaving(
  kit: Omit<RoadBuildTarget, 's'>,
  plan: RoadPlan,
  materials: RoadMaterials,
): RoadPaving {
  if (!plan.feasible)
    throw new Error(`Refusing to pave an infeasible road: ${plan.diagnostics.map((item) => item.message).join('; ')}`);
  let placed = 0;
  let skipped = 0;
  for (const cell of plan.cells) {
    const surface = materials.surface?.(cell) ?? null;
    if (cell.cut > 0) for (let y = cell.y + 1; y <= cell.y + cell.cut; y++) kit.air(cell.x, y, cell.z, 'road');
    if (cell.fill > 0 && !cell.bridge && materials.support)
      for (let depth = 1; depth <= cell.fill; depth++) {
        const block = materials.support(cell, depth);
        if (block) kit.put(cell.x, cell.y - depth, cell.z, block, {}, 'road');
      }
    if (!surface) {
      skipped++;
      continue;
    }
    let deck: State | null = null;
    const needsStair = cell.stairDirection !== undefined ? cell.stairDirection !== null : cell.rise !== 0;
    if (cell.strategy === 'stairs' && materials.stairs && needsStair)
      deck = materials.stairs(cell, cell.stairDirection ?? stairDirectionFor(plan, cell));
    else if (cell.strategy === 'slab' && materials.slab) deck = materials.slab(cell);
    kit.put(cell.x, cell.y, cell.z, deck ?? surface, {}, 'road');
    placed++;
  }
  return {
    placed,
    skipped,
    removed: plan.cutBlocks,
    cells: plan.cells,
    diagnostics: plan.diagnostics,
    committed: false,
  };
}

/**
 * Plan, validate and commit a pavement as one operation group.
 *
 * A refused plan (a callback that throws, an impossible block state, a
 * protection conflict) leaves the model exactly as it was.
 */
export function paveRoad(
  kit: RoadBuildTarget,
  plan: RoadPlan,
  materials: RoadMaterials,
  options: RoadBuildOptions = {},
): RoadPaving {
  if (!plan.feasible)
    throw new Error(`Refusing to pave an infeasible road: ${plan.diagnostics.map((item) => item.message).join('; ')}`);
  let recorded: RoadPaving = {
    placed: 0,
    skipped: 0,
    removed: 0,
    cells: plan.cells,
    diagnostics: plan.diagnostics,
    committed: false,
  };
  const object: DiagnosticObject =
    typeof plan.profile.object === 'string' ? { kind: 'route', id: plan.profile.object } : plan.profile.object;
  const construction = planConstruction(kit.s, {
    id: object.id,
    object,
    ...(options.protection ? { protection: options.protection } : {}),
    ...(options.rules ? { rules: options.rules } : {}),
    // A route owns the ground it crosses: its cut/fill is planned, and what it
    // may *not* touch is declared through protection zones and rules.
    excavationAuthorized: true,
    build: (sink) => {
      recorded = recordRoadPaving(sink, plan, materials);
    },
  });
  if (!construction.feasible)
    return {
      ...recorded,
      placed: 0,
      skipped: recorded.skipped,
      committed: false,
      diagnostics: construction.diagnostics,
    };
  const applied = commitConstruction(kit.s, construction);
  return {
    ...recorded,
    placed: applied.written,
    removed: applied.removed,
    committed: true,
    diagnostics: construction.diagnostics,
    merges: construction.merges,
  };
}

/**
 * Direction index (0=+X 1=-X 2=+Z 3=-Z) naming the **tall side** of a stair.
 *
 * A stair's high half has to sit on the uphill side: climbing, that is the way
 * the player is heading; stepping down, the high side is behind. The old rule —
 * "face whatever cell comes next" — turned the facing around at the end of a
 * descent and laid stairs across flat ground.
 */
export function stairDirectionFor(plan: RoadPlan, cell: RoadCell): number {
  const at = (step: number) => plan.cells.find((candidate) => candidate.step === step && candidate.lateral === 0);
  const next = at(cell.step + 1);
  const previous = at(cell.step - 1);
  // Direction of travel into this tread: the way the player walks onto it.
  const travel = previous ? directionFrom(previous, cell) : directionFrom(cell, next ?? cell);
  // Climbing, the high half is ahead; stepping down, it is behind.
  return cell.rise < 0 ? oppositeDirection(travel) : travel;
}

function directionFrom(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx !== 0) return dx > 0 ? 0 : 1;
  if (dz !== 0) return dz > 0 ? 2 : 3;
  return 0;
}

function oppositeDirection(direction: number): number {
  return direction === 0 ? 1 : direction === 1 ? 0 : direction === 2 ? 3 : 2;
}

/**
 * Does the finished model actually let a player walk this route?
 *
 * This is the check that keeps "looks connected" from passing as "walkable":
 * it reads the real collision boxes of the final model, so a missing slab, a
 * fence across the path or a leaf blocking the corridor is caught here.
 */
export function roadPassability(
  world: Pick<import('../core/structure.js').Structure, 'get'>,
  plan: RoadPlan,
  options: Readonly<{ headroom?: number }> = {},
): Diagnostic[] {
  const object: DiagnosticObject =
    typeof plan.profile.object === 'string' ? { kind: 'route', id: plan.profile.object } : plan.profile.object;
  const diagnostics: Diagnostic[] = [];
  const headroom = options.headroom ?? 2;
  const order = [...plan.cells].sort((a, b) => a.step - b.step || a.lateral - b.lateral);
  let previous: RoadCell | null = null;
  for (const cell of order) {
    /*
     * The pavement block is at `cell.y`; its collision top is the walking
     * height. `blockY` and `walkY` are separate concepts, so the check reads the
     * deck block itself (not the cell under it) and looks for headroom *above*
     * it — otherwise a correctly paved road would report its own deck as a
     * blockage.
     */
    const deck = world.get(cell.x, cell.y, cell.z) ?? null;
    const collision = collisionBoxes(deck);
    const supportTop =
      collision.kind === 'supported' ? collision.boxes.reduce((top, box) => Math.max(top, box[4]), 0) : 0;
    if (deck === null) {
      diagnostics.push(
        coordinateDiagnostic({
          rule: ROAD_RULES.unpaved,
          object,
          position: [cell.x, cell.y, cell.z],
          message: `计划的路面格 ${cell.x},${cell.y},${cell.z} 没有方块，路线在这里断开`,
          source: 'road-check',
        }),
      );
      continue;
    }
    if (supportTop < 0.5) {
      diagnostics.push(
        coordinateDiagnostic({
          rule: ROAD_RULES.impassable,
          object,
          position: [cell.x, cell.y, cell.z],
          message: `${cell.x},${cell.y},${cell.z} 的路面（${deck.name}）顶面只有 ${supportTop}，玩家无法站立`,
          conclusive: collision.kind === 'supported',
          severity: collision.kind === 'supported' ? 'error' : 'unknown',
          source: 'road-check',
        }),
      );
      continue;
    }
    // A fill section has to actually rest on something. A deck left floating
    // over the gap it was planned to fill is not a road, and nothing below the
    // deck used to be checked at all.
    if (cell.fill > 0 && !cell.bridge) {
      for (let depth = 1; depth <= cell.fill; depth++) {
        const below = world.get(cell.x, cell.y - depth, cell.z);
        if (below && below.name !== 'minecraft:air') continue;
        diagnostics.push(
          coordinateDiagnostic({
            rule: ROAD_RULES.unsupported,
            object,
            position: [cell.x, cell.y - depth, cell.z],
            message: `${cell.x},${cell.y - depth},${cell.z} 在路面下方第 ${depth} 格是空的，填方路段悬空`,
            data: { depth, fill: cell.fill, bridge: cell.bridge },
            source: 'road-check',
          }),
        );
        break;
      }
    }
    for (let offset = 1; offset <= headroom; offset++) {
      const state = world.get(cell.x, cell.y + offset, cell.z);
      const collision = collisionBoxes(state);
      if (collision.kind === 'unknown') {
        diagnostics.push(
          coordinateDiagnostic({
            rule: ROAD_RULES.impassable,
            object,
            position: [cell.x, cell.y + offset, cell.z],
            message: `${state?.name ?? '空'} 的碰撞形状未确认，无法判定 ${cell.x},${cell.y + offset},${cell.z} 是否可通行`,
            severity: 'unknown',
            conclusive: false,
            source: 'road-check',
          }),
        );
        continue;
      }
      if (collision.boxes.length) {
        diagnostics.push(
          coordinateDiagnostic({
            rule: ROAD_RULES.impassable,
            object,
            position: [cell.x, cell.y + offset, cell.z],
            message: `${cell.x},${cell.y + offset},${cell.z} 被 ${state?.name} 阻塞，路线不可通行`,
            source: 'road-check',
          }),
        );
      }
    }
    // Step check against the previous centreline cell.
    if (previous && cell.lateral === 0 && previous.lateral === 0) {
      const rise = cell.y - previous.y;
      const limit = rise >= 0 ? plan.profile.maxStepUp : plan.profile.maxStepDown;
      if (Math.abs(rise) > limit)
        diagnostics.push(
          coordinateDiagnostic({
            rule: ROAD_RULES.stepTooHigh,
            object,
            position: [cell.x, cell.y, cell.z],
            message: `第 ${cell.step} 步实际高差 ${rise}，超过玩家可行的 ${limit}`,
            data: { rise, limit },
            source: 'road-check',
          }),
        );
    }
    if (cell.lateral === 0) previous = cell;
  }
  return diagnostics;
}

/** Deterministic decorative variation along a route (never affects passability). */
export function roadVariation(_plan: RoadPlan, cell: RoadCell, seed: number, channel = 0): number {
  return coordinateRandom(cell.x, cell.y, cell.z, seed + Math.floor(cell.step / 8), channel);
}

/** Route distance helper reused by buildings that need "how far from the path am I". */
export function distanceToPolyline(x: number, z: number, waypoints: readonly [number, number][]): number {
  // A one-point "polyline" is a point, not an empty route: without this the
  // helper answered `Infinity`, which reads as "infinitely far from the path"
  // and silently disables every distance-based rule built on it.
  if (waypoints.length === 1) return Math.hypot(x - waypoints[0]![0], z - waypoints[0]![1]);
  let best = Infinity;
  for (let i = 1; i < waypoints.length; i++) {
    const [ax, az] = waypoints[i - 1]!;
    const [bx, bz] = waypoints[i]!;
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}
