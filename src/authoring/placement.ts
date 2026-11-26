import { PLACEMENT_RULES } from './placement/policy.js';
import { planOperation } from './placement/operations.js';
import { toVec3, emptyBox, growBox } from './placement/cells.js';
import { assertPoint } from './layout.js';
import { structureIdentity } from './model-target.js';
import { AIR, assertBox, contains, type Structure, type Box, type State, type Vec3 } from '../core/structure.js';
import {
  coordinateDiagnostic,
  DiagnosticSink,
  isDiagnosticError,
  mergeDiagnostics,
  DiagnosticError,
  type Diagnostic,
  type DiagnosticObject,
} from './diagnostics.js';
import { protectionDiagnostics, type ProtectionRegistry, type ProtectionViolation } from './protection.js';
import type { ProtectionRuleSet } from './rules.js';
import type { SurfaceQuery, SurfaceClass } from './surface.js';
import {
  IDENTITY_TRANSFORM,
  describeTransform,
  transformBox,
  untransformableDiagnostics,
  type BlockTransform,
  type UntransformableState,
} from './transform.js';

export { PLACEMENT_RULES, auditOperationCells } from './placement/policy.js';
export { planOperation, type OperationRequest, type OperationPlan } from './placement/operations.js';

/**
 * 地形感知放置：**生成候选 → 校验写入与挖除计划 → 整体提交**。
 *
 * 三条硬约束：
 * 1. 候选被拒时目标模型**零修改**——所有判断都在计划阶段完成，提交只做写入；
 * 2. 失败必须可定位——每条拒绝都带规则编号、对象、坐标与原因；
 * 3. 替换与挖除不只看材料——结合方块属性、对象归属、保护区契约与操作权限，
 *    所以"天然石头"和"人工石径"能被区分开。
 */

export type PlacementProjection = Readonly<{
  /** Surface kind that produced the anchor height. */
  surface: SurfaceClass;
  /** Terrain height found at the anchor column. */
  groundY: number;
  /** Anchor Y as requested by the caller. */
  requestedY: number;
  /** Anchor Y actually used. */
  anchorY: number;
  /** Deepest gap filled under the candidate. */
  foundationDepth: number;
  /** Cells removed because the terrain occupied the candidate's volume. */
  cutBlocks: number;
  /** Terrain slope (in blocks) around the anchor column. */
  slope: number;
}>;

export type PlacementPlan = Readonly<{
  /** Local prefab cells, already transformed, as world coordinates. */
  writes: readonly { position: Vec3; state: State }[];
  /** Cells cleared before writing. */
  carves: readonly Vec3[];
  /** World-space region the operations touch (half-open); empty when rejected early. */
  region: Box;
  /** Transform applied to the prefab. */
  transform: BlockTransform;
  /** World position of prefab local `(0,0,0)`. */
  origin: Vec3;
  /** Additive world-space offset applied after the transform. */
  offset: Vec3;
  /** The object this plan was built for, for messages that can be located. */
  object: DiagnosticObject;
  /**
   * `Structure.revision` the plan was computed against.
   *
   * A plan is a one-shot delta: every rule was decided against the model as it
   * was. If anything wrote to the model afterwards the decisions may no longer
   * hold, so `commitPlacement` refuses to apply it and the caller replans
   * instead of stamping a stale plan over someone else's blocks.
   */
  baseRevision: number;
  targetIdentity: number;
  /** Statistics from the terrain projection, when one ran. */
  projection: PlacementProjection | null;
  diagnostics: readonly Diagnostic[];
  violations: readonly ProtectionViolation[];
  untransformable: readonly UntransformableState[];
  /** Non-blocking notes (e.g. cells excluded from checks, missing foundation material). */
  notes: readonly string[];
}>;

export type PlacementRequest = Readonly<{
  /** Independent prefab; must not be the target world itself. */
  prefab: Structure;
  /** World position for prefab local `(0,0,0)`. */
  origin: Vec3;
  transform?: BlockTransform;
  /** Additive world-space offset, applied after the transform. */
  offset?: Vec3;
  object: DiagnosticObject | string;
  /** World region the placement must stay inside (half-open). */
  bounds?: Box;
  /** Project the anchor onto the surface found at `origin`'s column. */
  surface?: SurfaceQuery;
  surfaceKind?: SurfaceClass;
  /** Reject when the anchor sits higher than `groundY + maxRise`. */
  maxRise?: number;
  /** Fill gaps under the candidate down to the ground, up to this many blocks. */
  maxFoundation?: number;
  /** Material for the top-up; defaults to the candidate's own first block. */
  foundation?: (position: Vec3, depthBelowSurface: number) => State;
  /** Allow removing terrain that occupies the candidate's volume, up to this many blocks. */
  maxCut?: number;
  /** Reject when the terrain slope around the footprint exceeds this. */
  maxSlope?: number;
  /** Framework protection rules consulted for this object. */
  rules?: ProtectionRuleSet;
  /** Declared protection zones and clearance contracts. */
  protection?: ProtectionRegistry;
  /** Accept an occupied cell instead of reporting `placement.occupied`. */
  overlapAllowed?: (existing: State | null, position: Vec3) => boolean;
  carveAllowed?: (existing: State | null, position: Vec3) => boolean;
  /** Clear cells the prefab leaves as explicit air (`carve`). */
  carveAir?: boolean;
}>;

function rejected(
  request: PlacementRequest,
  spec: BlockTransform,
  origin: Vec3,
  offset: Vec3,
  diagnostics: Diagnostic[],
  baseRevision: number,
  targetIdentity: number,
): PlacementPlan {
  const object: DiagnosticObject =
    typeof request.object === 'string' ? { kind: request.object, id: request.object } : request.object;
  return {
    writes: [],
    carves: [],
    region: emptyBox(),
    transform: spec,
    origin: [...origin] as Vec3,
    offset: [...offset] as Vec3,
    object,
    baseRevision,
    targetIdentity,
    projection: null,
    diagnostics: mergeDiagnostics(diagnostics),
    violations: [],
    untransformable: [],
    notes: [],
  };
}

/**
 * Plan a placement without touching the world. The returned plan is complete:
 * everything it lists has already passed the rules, so `commitPlacement` only
 * writes and never has to decide anything that could fail halfway.
 */
export function planPlacement(world: Structure, request: PlacementRequest): PlacementPlan {
  assertPoint(request.origin);
  if (request.offset) assertPoint(request.offset);
  if (request.bounds) assertBox(request.bounds);
  const baseRevision = world.revision;
  const targetIdentity = structureIdentity(world);
  const spec = request.transform ?? IDENTITY_TRANSFORM;
  const offset: Vec3 = request.offset ? ([...request.offset] as Vec3) : [0, 0, 0];
  const origin = toVec3(request.origin);
  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const object: DiagnosticObject =
    typeof request.object === 'string' ? { kind: request.object, id: request.object } : request.object;

  // 1) Transform every prefab cell by simulating on a throwaway world: the
  //    transform, protection and overlap rules then have exactly one
  //    implementation, and this function stays a planner instead of a second
  //    copy of the commit path.
  const inspected = request.prefab.inspect();
  if (!inspected.bounds && (!inspected.explicitAir || request.carveAir === false)) {
    diagnostics.push(
      coordinateDiagnostic({
        rule: PLACEMENT_RULES.nothingToPlace,
        object,
        region: emptyBox(),
        message: '候选模型没有任何方块，未放置任何东西',
        source: 'placement',
      }),
    );
    return rejected(request, spec, origin, offset, diagnostics, baseRevision, targetIdentity);
  }
  const operation = planOperation(world, {
    prefab: request.prefab,
    origin,
    transform: spec,
    offset,
    object,
    ...(request.carveAir === undefined ? {} : { carveAir: request.carveAir }),
    ...(request.foundation ? { foundation: request.foundation } : {}),
    ...(request.rules ? { rules: request.rules } : {}),
    ...(request.protection ? { protection: request.protection } : {}),
    ...(request.carveAllowed ? { carveAllowed: request.carveAllowed } : {}),
    ...(request.maxCut === undefined
      ? {
          overlapAllowed:
            request.overlapAllowed ?? ((existing: State | null) => !!existing && existing.name === 'minecraft:air'),
        }
      : { excavationAuthorized: true }),
  });
  const untransformable = operation.untransformable;
  const cells: { position: Vec3; state: State | null }[] = operation.writes.map((write) => ({
    position: write.position,
    state: write.state,
  }));
  if (untransformable.length) {
    diagnostics.push(
      ...untransformableDiagnostics(untransformable, { object, rule: PLACEMENT_RULES.untransformableState }),
    );
    return { ...rejected(request, spec, origin, offset, diagnostics, baseRevision, targetIdentity), untransformable };
  }

  // 2) Terrain projection: derive the anchor height from the actual surface.
  let projection: PlacementProjection | null = null;
  let foundationMaterial = request.foundation;
  if (request.surface) {
    const kind = request.surfaceKind ?? 'terrain';
    const sample = request.surface.sample(kind, origin[0], origin[2]);
    if (!sample.found || sample.y === null) {
      diagnostics.push(
        coordinateDiagnostic({
          rule: PLACEMENT_RULES.noSurface,
          object,
          position: [...origin] as Vec3,
          message: `${origin[0]},${origin[2]} 列在扫描范围内找不到${kind === 'terrain' ? '地形表面' : kind === 'water' ? '水面' : '可站立面'}，无法做地表投影`,
          source: 'placement',
        }),
      );
      return rejected(request, spec, origin, offset, diagnostics, baseRevision, targetIdentity);
    }
    const groundY = sample.y;
    const requestedY = origin[1];
    if (request.maxRise !== undefined && requestedY - groundY > request.maxRise) {
      diagnostics.push(
        coordinateDiagnostic({
          rule: PLACEMENT_RULES.noSurface,
          object,
          position: [...origin] as Vec3,
          message: `候选锚点比地表高 ${requestedY - groundY} 格，超过 maxRise=${request.maxRise}`,
          data: { rise: requestedY - groundY },
          source: 'placement',
        }),
      );
      return rejected(request, spec, origin, offset, diagnostics, baseRevision, targetIdentity);
    }
    const slope = request.surface.slope(origin[0], origin[2]) ?? 0;
    if (request.maxSlope !== undefined && slope > request.maxSlope) {
      diagnostics.push(
        coordinateDiagnostic({
          rule: PLACEMENT_RULES.steep,
          object,
          position: [...origin] as Vec3,
          message: `地表坡度 ${slope} 超过 maxSlope=${request.maxSlope}`,
          data: { slope },
          source: 'placement',
        }),
      );
    }
    projection = {
      surface: kind,
      groundY,
      requestedY,
      anchorY: requestedY,
      foundationDepth: 0,
      cutBlocks: 0,
      slope,
    };
  }

  const writes: { position: Vec3; state: State }[] = [];
  let region = emptyBox();
  let firstState: State | null = null;
  for (const cell of cells) {
    if (!cell.state) continue;
    firstState ??= cell.state;
    writes.push({ position: [...cell.position] as Vec3, state: cell.state });
    region = growBox(region, cell.position);
  }

  // 3) Bounds.
  if (request.bounds)
    for (const write of writes)
      if (!contains(request.bounds, write.position[0], write.position[1], write.position[2]))
        diagnostics.push(
          coordinateDiagnostic({
            rule: PLACEMENT_RULES.outOfBounds,
            object,
            position: write.position,
            message: `${write.position.join(',')} 落在声明的边界之外`,
            source: 'placement',
          }),
        );

  // 4) Terrain-aware top-up and bounded cut, both measured on the actual model.
  const cutCells: Vec3[] = [];
  if (projection && request.surface) {
    const lowest = new Map<string, number>();
    for (const write of writes) {
      const key = `${write.position[0]},${write.position[2]}`;
      const bottom = lowest.get(key);
      if (bottom === undefined || write.position[1] < bottom) lowest.set(key, write.position[1]);
    }
    let maxDepth = 0;
    const fill: { position: Vec3; state: State }[] = [];
    for (const [key, bottom] of [...lowest].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [x, z] = key.split(',').map(Number) as [number, number];
      const ground = request.surface.terrain(x, z);
      if (ground === null) continue;
      const gap = bottom - ground - 1;
      if (gap <= 0) continue;
      maxDepth = Math.max(maxDepth, gap);
      if (gap > (request.maxFoundation ?? 0)) continue;
      for (let y = ground + 1; y < bottom; y++)
        fill.push({
          position: [x, y, z],
          state: foundationMaterial ? foundationMaterial([x, y, z], y - ground) : firstState!,
        });
    }
    if (request.maxFoundation !== undefined && maxDepth > request.maxFoundation)
      diagnostics.push(
        coordinateDiagnostic({
          rule: PLACEMENT_RULES.foundation,
          object,
          position: [...origin] as Vec3,
          message: `地基缺口 ${maxDepth} 格超过 maxFoundation=${request.maxFoundation}`,
          data: { depth: maxDepth },
          source: 'placement',
        }),
      );
    let deepestCut = 0;
    for (const write of writes) {
      const [x, y, z] = write.position;
      const existing = world.get(x, y, z);
      if (!existing || existing.name === 'minecraft:air') continue;
      cutCells.push([x, y, z]);
      deepestCut = Math.max(deepestCut, y);
    }
    if (request.maxCut !== undefined && cutCells.length > request.maxCut) {
      diagnostics.push(
        coordinateDiagnostic({
          rule: PLACEMENT_RULES.excavation,
          object,
          position: [...origin] as Vec3,
          message: `需要削除 ${cutCells.length} 格超过 maxCut=${request.maxCut}`,
          data: { cut: cutCells.length },
          source: 'placement',
        }),
      );
      return rejected(request, spec, origin, offset, diagnostics, baseRevision, targetIdentity);
    }
    if (cutCells.length && request.maxCut === undefined) {
      // Terrain overlapping the candidate without excavation authority is a
      // hard error: the object would otherwise half-bury itself in the hill.
      for (const cell of cutCells)
        diagnostics.push(
          coordinateDiagnostic({
            rule: PLACEMENT_RULES.overlap,
            object,
            position: cell,
            message: `${cell.join(',')} 被地形占用，且未授予削填权限（maxCut）`,
            data: { existing: world.get(cell[0], cell[1], cell[2])?.name ?? null },
            source: 'placement',
          }),
        );
      return rejected(request, spec, origin, offset, diagnostics, baseRevision, targetIdentity);
    }
    for (const cell of fill) {
      writes.push(cell);
      region = growBox(region, cell.position);
    }
    projection = { ...projection, foundationDepth: maxDepth, cutBlocks: cutCells.length };
    void deepestCut;
  }

  // 5) Carve plan: the prefab's explicit air (already decided by
  //    `planOperation`) plus the bounded excavation.
  const carves: Vec3[] = [...operation.carves];
  const carveKeys = new Set(carves.map((carve) => carve.join(',')));
  for (const cut of cutCells)
    if (!carveKeys.has(cut.join(','))) {
      carveKeys.add(cut.join(','));
      carves.push(cut);
    }
  const writeKeys = new Set(writes.map((write) => write.position.join(',')));
  for (const carve of carves) if (!writeKeys.has(carve.join(','))) region = growBox(region, carve);
  if (request.bounds)
    for (const position of [...writes.map((write) => write.position), ...carves])
      if (!contains(request.bounds, ...position))
        diagnostics.push(
          coordinateDiagnostic({
            rule: PLACEMENT_RULES.outOfBounds,
            object,
            position,
            message: `${position.join(',')} 落在声明的边界之外`,
            source: 'placement',
          }),
        );

  // 6) Overlap / ownership: what the candidate would overwrite. `planOperation`
  //    already resolved this with the same predicate.
  for (const position of operation.overlaps) {
    const existing = world.get(position[0], position[1], position[2]);
    diagnostics.push(
      coordinateDiagnostic({
        rule: PLACEMENT_RULES.overlap,
        object,
        position,
        message: `${position.join(',')} 已被 ${existing?.name ?? '方块'} 占用，且该对象无权覆盖`,
        data: { existing: existing?.name ?? null },
        source: 'placement',
      }),
    );
  }

  // 7) Protection: framework rules plus declared zones, all decided once in
  //    `planOperation` so a preview and a commit cannot disagree.
  const violations = [...operation.violations];
  if (violations.length)
    diagnostics.push(...protectionDiagnostics(violations, { object, rule: PLACEMENT_RULES.protection }));

  return {
    writes,
    carves,
    region,
    transform: spec,
    origin,
    offset,
    object,
    baseRevision,
    targetIdentity,
    projection,
    diagnostics: mergeDiagnostics(diagnostics),
    violations,
    untransformable: [],
    notes,
  };
}

export type PlacementReport = Readonly<{
  accepted: boolean;
  object: DiagnosticObject;
  label: string;
  plan: PlacementPlan;
  diagnostics: readonly Diagnostic[];
  /** Cells whose block actually changed. */
  written: number;
  /** Cells that held a block and were cleared. */
  removed: number;
  /** Cells written but already holding the same state (no world change). */
  unchanged: number;
  /** World region touched (half-open); empty when nothing was committed. */
  region: Box;
  transform: BlockTransform;
  projection: PlacementProjection | null;
  ms: number;
}>;

/**
 * Commit an accepted plan. Performs no checks beyond the staleness guard: a
 * plan only describes a delta against one model revision, so applying it after
 * anything else wrote to the model could stamp decisions that no longer hold.
 */
export function commitPlacement(
  world: Structure,
  plan: PlacementPlan,
): { written: number; removed: number; unchanged: number } {
  if (plan.targetIdentity !== structureIdentity(world)) throw new Error('拒绝向另一个模型实例提交放置计划');
  if (plan.diagnostics.some((d) => d.severity === 'error' || d.severity === 'unknown'))
    throw new Error('拒绝提交不可行的放置计划');
  if (plan.baseRevision !== world.revision)
    throw new Error(
      `拒绝提交过期的放置计划 ${plan.object.kind}:${plan.object.id}：计划基于 revision ${plan.baseRevision}，模型现为 ${world.revision}；请对当前模型重新规划`,
    );
  const touched = new Set<string>();
  let removed = 0;
  for (const carve of plan.carves) {
    const [x, y, z] = carve;
    touched.add(carve.join(','));
    if (world.get(x, y, z)?.name === AIR.name) continue;
    world.set(x, y, z, AIR);
    removed++;
  }
  let written = 0;
  let unchanged = 0;
  for (const write of plan.writes) {
    const [x, y, z] = write.position;
    const key = write.position.join(',');
    const alreadyCleared = touched.has(key);
    touched.add(key);
    const existing = world.get(x, y, z) ?? null;
    /*
     * `removed` and `written` count *changes*: a cell that was carved and then
     * filled is one change, not two, and re-stamping a block that is already
     * there is not a change at all. Without this the counters would report
     * "work done" for a placement that left the world identical.
     */
    const incomingIsAir = write.state.name === 'minecraft:air';
    if (incomingIsAir) {
      if (existing?.name === AIR.name) continue;
      removed++;
    } else if (existing) {
      if (existing.name === write.state.name) unchanged++;
      else if (!alreadyCleared) written++;
    } else if (alreadyCleared) {
      written++;
    } else {
      written++;
    }
    world.set(x, y, z, write.state);
  }
  return { written, removed, unchanged };
}

/**
 * Plan, then commit only when the plan is clean. A rejected candidate leaves the
 * world byte-identical, because every decision happened before the first write.
 */
export function placeObject(world: Structure, request: PlacementRequest): PlacementReport {
  const started = Date.now();
  const object: DiagnosticObject =
    typeof request.object === 'string' ? { kind: request.object, id: request.object } : request.object;
  const plan = planPlacement(world, request);
  const blocking = plan.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'unknown',
  );
  if (blocking.length)
    return {
      accepted: false,
      object,
      label: object.id,
      plan,
      diagnostics: plan.diagnostics,
      written: 0,
      removed: 0,
      unchanged: 0,
      region: emptyBox(),
      transform: plan.transform,
      projection: plan.projection,
      ms: Date.now() - started,
    };
  const applied = commitPlacement(world, plan);
  return {
    accepted: true,
    object,
    label: object.id,
    plan,
    diagnostics: plan.diagnostics,
    written: applied.written,
    removed: applied.removed,
    unchanged: applied.unchanged,
    region: plan.region,
    transform: plan.transform,
    projection: plan.projection,
    ms: Date.now() - started,
  };
}

/** Placement that raises on rejection, for callers that treat failure as fatal. */
export function placeObjectOrThrow(world: Structure, request: PlacementRequest): PlacementReport {
  const report = placeObject(world, request);
  if (!report.accepted) throw new DiagnosticError(report.diagnostics);
  return report;
}

/** One info line per batch, so reports show candidate/success counts. */
export function placementSummary(
  reports: readonly PlacementReport[],
  options: Readonly<{ object?: DiagnosticObject | string; source?: string }> = {},
): Diagnostic[] {
  if (!reports.length) return [];
  const sink = new DiagnosticSink();
  const accepted = reports.filter((report) => report.accepted).length;
  const rejected = reports.length - accepted;
  sink.info(
    'placement.summary',
    `${accepted}/${reports.length} 个候选放置成功（写入 ${reports.reduce((n, r) => n + r.written, 0)} 格，移除 ${reports.reduce((n, r) => n + r.removed, 0)} 格${rejected ? `，拒绝 ${rejected}` : ''}）`,
    { object: options.object ?? 'placement', source: options.source ?? 'placement' },
  );
  return sink.list();
}

export { DiagnosticError, isDiagnosticError, transformBox, describeTransform };
