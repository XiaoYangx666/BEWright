import { structureIdentity } from './model-target.js';
export { structureIdentity } from './model-target.js';
import { AIR, Structure, assertBox, type Box, type State, type Vec3 } from '../core/structure.js';
import { coordinateDiagnostic, mergeDiagnostics, type Diagnostic, type DiagnosticObject } from './diagnostics.js';
import { resolveMaterial, type AuthoringMaterial } from './kit.js';
import { auditOperationCells, PLACEMENT_RULES } from './placement/policy.js';
import { protectionDiagnostics, type ProtectionRegistry, type ProtectionViolation } from './protection.js';
import type { ProtectionRuleSet } from './rules.js';

/**
 * 统一施工计划：**几何设计计划**与**已解析材料的施工计划**分开，提交只应用已验证的操作。
 *
 * ```text
 * 设计声明（标高场、水段、道路线位、掩码）
 *     ↓  recordTerrain / recordWaterSystem / recordRoadPaving / recordShore
 * 施工计划：解析后的方块状态 + 挖除 + 影响范围 + 归属 + 保护区结论 + 诊断
 *     ↓  commitConstruction（只写，不再执行任何用户回调）
 * Structure
 * ```
 *
 * 三条硬约束：
 * 1. **回调只在计划阶段执行**：材料、掩码、表皮回调全部在 `planConstruction`
 *    期间跑完并完成注册表校验；提交阶段不再有"可能失败的用户代码"。
 * 2. **计划绑定目标模型**：记录目标实例身份与 `Structure.revision`；提交到别的
 *    模型或模型已变动都会被拒绝，而不是把过期决策盖上去。
 * 3. **合并规则显式**：重复写入、挖除后填充、河床与水体交叠各有明确规则，
 *    非预期冲突产出诊断，绝不依赖循环顺序静默覆盖。
 *
 * 不承诺进程崩溃级事务，也不为整个场景建立巨型事务：事务边界就是调用方声明的
 * 那个接合组（`buildValleyStream` 是其中一个）。
 */

/** What a construction operation is for; merge rules are role-aware. */
export type ConstructionRole = 'terrain' | 'bed' | 'bank' | 'water' | 'road' | 'object';

export const CONSTRUCTION_RULES = {
  coordinate: 'construction.coordinate',
  /** A material callback threw, or produced a state the registry rejects. */
  material: 'construction.material',
  /** A callback threw outside a material resolution. */
  callback: 'construction.callback',
  /** An operation landed outside the declared region. */
  outOfBounds: 'construction.out-of-bounds',
  /** A cell would overwrite something the object may not touch. */
  occupied: 'construction.occupied',
  /** Two different blocks were written to the same cell by the same plan. */
  overwrite: 'construction.overwrite',
  /** A carve was requested for a cell the plan also writes (the write wins). */
  carveOverWrite: 'construction.carve-over-write',
  /** Water written into a cell another segment declared as its bed. */
  bedFlooded: 'construction.bed-flooded',
  /** Shore material written into a cell that already holds planned water. */
  shoreOverWater: 'construction.shore-over-water',
  /** The plan targets a different model, or one that has moved on. */
  staleTarget: 'construction.stale-target',
} as const;

export type ConstructionWrite = Readonly<{ position: Vec3; state: State; role: ConstructionRole }>;
export type ConstructionCarve = Readonly<{ position: Vec3; role: ConstructionRole }>;

/**
 * The write surface shared by the kit and by a construction recorder.
 *
 * The low-level builders (`recordTerrain`, `recordWaterSystem`,
 * `recordRoadPaving`) take this and nothing else, so pointing them at a real
 * `StructureKit` writes immediately while pointing them at a recorder produces
 * a reviewable plan — one implementation, two uses.
 */
export type ConstructionTarget = Readonly<{
  put(
    x: number,
    y: number,
    z: number,
    material: AuthoringMaterial,
    states?: Record<string, string | number | boolean>,
    role?: ConstructionRole,
  ): void;
  air(x: number, y: number, z: number, role?: ConstructionRole): void;
  /** Optional sink for diagnostics the builder finds on the way. */
  report?(diagnostic: Diagnostic): void;
}>;

export type ConstructionMergeStats = Readonly<{
  /** Writes of the same block to the same cell (idempotent restamps). */
  duplicates: number;
  /** Different blocks written to one cell; the last one wins and it is reported. */
  overwritten: number;
  /** Cells carved and then filled again by the same plan. */
  refilled: number;
  /** Cells filled and then excavated again by the same plan (the carve wins). */
  excavated: number;
  /** Expected layer replacements (terrain -> bed/bank/road), counted, not warned. */
  replaced: number;
}>;

/**
 * Layer replacements the framework composes on purpose.
 *
 * Terrain is laid first and the later phases legitimately replace its surface
 * block (a bed, a shore ring, a road deck). Those are counted, not warned: a
 * warning per cell would drown the findings that matter. Every other pairing is
 * reported, so nothing is resolved by "whoever wrote last".
 */
const EXPECTED_REPLACEMENTS = new Set([
  'terrain>bed',
  'terrain>bank',
  'terrain>water',
  'terrain>road',
  'terrain>object',
  'bed>bank',
  'bed>road',
  'bank>bank',
  'road>road',
]);

/** Excavations the framework composes on purpose: digging a body into the fill. */
const EXPECTED_EXCAVATIONS = new Set(['terrain>water', 'terrain>road', 'terrain>bank']);

export type ConstructionPlan = Readonly<{
  id: string;
  /** Owner of every operation in this plan. */
  object: DiagnosticObject;
  /** Identity token of the target model instance. */
  targetIdentity: number;
  /** `Structure.revision` the plan was computed against. */
  baseRevision: number;
  /** Resolved writes, in the order they were recorded. */
  writes: readonly ConstructionWrite[];
  /** Cells cleared before writing. */
  carves: readonly ConstructionCarve[];
  /** World-space region the operations touch (half-open). */
  region: Box;
  bounds: Box | null;
  diagnostics: readonly Diagnostic[];
  violations: readonly ProtectionViolation[];
  merges: ConstructionMergeStats;
  feasible: boolean;
}>;

export type ConstructionSink = Readonly<{
  put(
    x: number,
    y: number,
    z: number,
    material: AuthoringMaterial,
    states?: Record<string, string | number | boolean>,
    role?: ConstructionRole,
  ): void;
  air(x: number, y: number, z: number, role?: ConstructionRole): void;
  /** Read-through view: the original model **plus** everything this plan has recorded. */
  get(x: number, y: number, z: number): State | null;
  /**
   * Highest solid (non-air, non-water) cell in the read-through view.
   *
   * Shoreline passes use this instead of the design height field: after digging
   * and filling, the design field is no longer the surface the water will meet.
   */
  groundY(x: number, z: number): number | null;
  /** Report a finding the builder made while recording. */
  report(diagnostic: Diagnostic): void;
}>;

/* ------------------------------- identity --------------------------------- */

function emptyBox(): Box {
  return { min: [0, 0, 0], max: [0, 0, 0] };
}

function growBox(box: Box, position: Vec3): Box {
  return {
    min: [Math.min(box.min[0], position[0]), Math.min(box.min[1], position[1]), Math.min(box.min[2], position[2])],
    max: [
      Math.max(box.max[0], position[0] + 1),
      Math.max(box.max[1], position[1] + 1),
      Math.max(box.max[2], position[2] + 1),
    ],
  };
}

function sameState(a: State, b: State): boolean {
  if (a.name !== b.name) return false;
  const keysA = Object.keys(a.states);
  const keysB = Object.keys(b.states);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a.states[key] === b.states[key]);
}

/* -------------------------------- recorder -------------------------------- */

class Recorder {
  readonly sink: ConstructionSink;
  private readonly writes = new Map<string, ConstructionWrite>();

  private readonly carves = new Map<string, ConstructionCarve>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly merges = { duplicates: 0, overwritten: 0, refilled: 0, excavated: 0, replaced: 0 };
  private maxY = -Infinity;
  private minY = Infinity;
  private sourceBounds: Box | null | undefined;

  constructor(
    private readonly world: Structure,
    private readonly object: DiagnosticObject,
  ) {
    this.sink = {
      put: (x, y, z, material, states, role) => this.put(x, y, z, material, states, role),
      air: (x, y, z, role) => this.carve([x, y, z], role ?? 'object'),
      get: (x, y, z) => this.read(x, y, z),
      groundY: (x, z) => this.groundY(x, z),
      report: (diagnostic) => this.diagnostics.push(diagnostic),
    };
  }

  /** Read-through: pending write, then pending carve, then the original model. */
  private read(x: number, y: number, z: number): State | null {
    const key = `${x},${y},${z}`;
    const pending = this.writes.get(key);
    if (pending) return pending.state;
    // A pending carve reads as explicit air: the shoreline pass must see the
    // excavation, not the block that is about to be removed.
    if (this.carves.has(key)) return AIR;
    return this.world.get(x, y, z) ?? null;
  }

  private groundY(x: number, z: number): number | null {
    // The target is immutable during planning (enforced by the revision guard).
    // Do not rescan the entire voxel model for every shoreline column.
    const extent =
      this.sourceBounds === undefined ? (this.sourceBounds = this.world.inspect().bounds) : this.sourceBounds;
    const top = Math.max(
      Number.isFinite(this.maxY) ? this.maxY : -Infinity,
      this.world.ceiling,
      extent ? extent.max[1] - 1 : -Infinity,
    );
    const bottom = Math.min(Number.isFinite(this.minY) ? this.minY : Infinity, extent ? extent.min[1] : 0, 0);
    for (let y = top; y >= bottom; y--) {
      const state = this.read(x, y, z);
      if (!state) continue;
      if (state.name === 'minecraft:air' || state.name === 'minecraft:water') continue;
      return y;
    }
    return null;
  }

  private put(
    x: number,
    y: number,
    z: number,
    material: AuthoringMaterial,
    states?: Record<string, string | number | boolean>,
    role: ConstructionRole = 'object',
  ): void {
    if (![x, y, z].every(Number.isSafeInteger)) {
      this.fail(CONSTRUCTION_RULES.coordinate, '方块坐标必须是安全整数', null, { x, y, z });
      return;
    }
    let state: State;
    try {
      // The registry check happens **here**, at plan time: a callback that
      // produces an impossible block never reaches the commit.
      state = resolveMaterial(material, states);
    } catch (error) {
      this.diagnostics.push(
        coordinateDiagnostic({
          rule: CONSTRUCTION_RULES.material,
          object: this.object,
          position: [x, y, z],
          message: `${x},${y},${z} 的材料无法解析为合法方块状态：${error instanceof Error ? error.message : String(error)}`,
          source: 'construction',
        }),
      );
      return;
    }
    this.record({ position: [x, y, z], state, role });
  }

  private record(write: ConstructionWrite): void {
    const key = write.position.join(',');
    const pendingCarve = this.carves.get(key);
    if (pendingCarve) {
      // Rule: a cell that ends up holding a block is not cleared afterwards.
      this.carves.delete(key);
      this.merges.refilled++;
    }
    const existing = this.writes.get(key);
    if (existing) {
      if (sameState(existing.state, write.state)) {
        this.merges.duplicates++;
        this.writes.set(key, write); // Same material can acquire a new semantic role.
        return;
      }
      if (existing.role === 'bed' && write.role === 'water') {
        // Rule: a water body may not flood another segment's declared bed. This
        // is a design conflict, not an ordering preference.
        this.diagnostics.push(
          coordinateDiagnostic({
            rule: CONSTRUCTION_RULES.bedFlooded,
            object: this.object,
            position: write.position,
            message: `${key} 同时被声明为河床（${existing.state.name}）与水体（${write.state.name}）；水段与河床交叠，请调整轮廓或路径`,
            data: { bed: existing.state.name, water: write.state.name },
            source: 'construction',
          }),
        );
        return;
      }
      if (existing.role === 'water' && write.role === 'bank') {
        // Rule: the water body wins over shore decoration. The shore ring runs
        // past the fall's foot by construction, so this is expected — it is
        // recorded, not silent.
        this.merges.overwritten++;
        this.diagnostics.push(
          coordinateDiagnostic({
            rule: CONSTRUCTION_RULES.shoreOverWater,
            severity: 'info',
            object: this.object,
            position: write.position,
            message: `${key} 已是计划水体，岸线材料 ${write.state.name} 不再覆盖它`,
            source: 'construction',
          }),
        );
        return;
      }
      if (EXPECTED_REPLACEMENTS.has(`${existing.role}>${write.role}`)) {
        this.merges.replaced++;
      } else {
        this.merges.overwritten++;
        this.diagnostics.push(
          coordinateDiagnostic({
            rule: CONSTRUCTION_RULES.overwrite,
            severity: 'warning',
            object: this.object,
            position: write.position,
            message: `${key} 在同一个施工计划里被写了两次：${existing.state.name}（${existing.role}）被 ${write.state.name}（${write.role}）覆盖`,
            data: { from: existing.state.name, to: write.state.name, fromRole: existing.role, toRole: write.role },
            source: 'construction',
          }),
        );
      }
    }
    this.writes.set(key, write);

    this.maxY = Math.max(this.maxY, write.position[1]);
    this.minY = Math.min(this.minY, write.position[1]);
  }

  private carve(position: Vec3, role: ConstructionRole): void {
    if (!position.every(Number.isSafeInteger)) {
      this.fail(CONSTRUCTION_RULES.coordinate, '挖除坐标必须是安全整数', null, { position });
      return;
    }
    const key = position.join(',');
    const pending = this.writes.get(key);
    if (pending) {
      /*
       * Rule: excavation after fill is legitimate and the **carve wins** — the
       * write is removed from the plan. Digging a pool into terrain the same
       * plan just laid down is the framework's own composition, so it is
       * counted; any other pairing is reported cell by cell.
       */
      this.writes.delete(key);
      this.merges.excavated++;
      if (!EXPECTED_EXCAVATIONS.has(`${pending.role}>${role}`))
        this.diagnostics.push(
          coordinateDiagnostic({
            rule: CONSTRUCTION_RULES.carveOverWrite,
            severity: 'warning',
            object: this.object,
            position,
            message: `${key} 先被写入 ${pending.state.name}（${pending.role}）又被挖除（${role}），以挖除为准`,
            source: 'construction',
          }),
        );
      this.maxY = Math.max(this.maxY, position[1]);
      this.minY = Math.min(this.minY, position[1]);
      // Fall through: the cell is now cleared, so record the carve too.
    }
    if (this.carves.has(key)) {
      this.merges.duplicates++;
      return;
    }
    this.carves.set(key, { position: [...position] as Vec3, role });
    this.maxY = Math.max(this.maxY, position[1]);
    this.minY = Math.min(this.minY, position[1]);
  }

  fail(rule: string, message: string, position: Vec3 | null = null, data: Record<string, unknown> = {}): void {
    this.diagnostics.push(
      coordinateDiagnostic({
        rule,
        object: this.object,
        ...(position ? { position } : {}),
        message,
        data,
        source: 'construction',
      }),
    );
  }

  writeList(): ConstructionWrite[] {
    return [...this.writes.values()];
  }

  carveList(): ConstructionCarve[] {
    return [...this.carves.values()].sort(
      (a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1] || a.position[2] - b.position[2],
    );
  }

  /** Writes and carves merged for the ownership audit, in the plan's own order. */
  auditWrites(): { position: Vec3; state: State }[] {
    return this.writeList().map((write) => ({ position: write.position, state: write.state }));
  }

  auditCarves(): Vec3[] {
    return this.carveList().map((carve) => carve.position);
  }

  stats(): ConstructionMergeStats {
    return { ...this.merges };
  }

  list(): Diagnostic[] {
    return [...this.diagnostics];
  }
}

/* --------------------------------- planning -------------------------------- */

export type ConstructionRequest = Readonly<{
  id: string;
  object: DiagnosticObject | string;
  /** Region the plan may touch (half-open); anything outside is an error. */
  bounds?: Box;
  rules?: ProtectionRuleSet;
  protection?: ProtectionRegistry;
  /** Accept an occupied cell instead of reporting it. */
  overlapAllowed?: (existing: State | null, position: Vec3) => boolean;
  /** Optional ownership constraint for excavation, independent of protection. */
  carveAllowed?: (existing: State | null, position: Vec3) => boolean;
  /** The operation holds excavation authority: occupied cells are its own cut. */
  excavationAuthorized?: boolean;
  /**
   * Resolve geometry and materials. Every user callback runs inside this
   * function and nowhere else; a throw makes the plan infeasible instead of
   * leaving a half-built model behind.
   */
  build: (sink: ConstructionSink) => void;
}>;

export function planConstruction(world: Structure, request: ConstructionRequest): ConstructionPlan {
  if (request.bounds) assertBox(request.bounds);
  const object: DiagnosticObject =
    typeof request.object === 'string' ? { kind: 'construction', id: request.object } : request.object;
  const targetIdentity = structureIdentity(world);
  const baseRevision = world.revision;
  const recorder = new Recorder(world, object);
  try {
    request.build(recorder.sink);
  } catch (error) {
    recorder.fail(
      CONSTRUCTION_RULES.callback,
      `施工计划 ${request.id} 在解析阶段抛错，未产生任何写入：${error instanceof Error ? error.message : String(error)}`,
      null,
      { error: error instanceof Error ? error.name : typeof error },
    );
  }

  const writes = recorder.writeList();
  const carves = recorder.carveList();
  const diagnostics: Diagnostic[] = recorder.list();
  let region = emptyBox();
  for (const write of writes) region = growBox(region, write.position);
  for (const carve of carves) region = growBox(region, carve.position);

  if (request.bounds)
    for (const entry of [...writes.map((write) => write.position), ...carves.map((carve) => carve.position)])
      if (
        entry[0] < request.bounds.min[0] ||
        entry[0] >= request.bounds.max[0] ||
        entry[1] < request.bounds.min[1] ||
        entry[1] >= request.bounds.max[1] ||
        entry[2] < request.bounds.min[2] ||
        entry[2] >= request.bounds.max[2]
      )
        diagnostics.push(
          coordinateDiagnostic({
            rule: CONSTRUCTION_RULES.outOfBounds,
            object,
            position: entry,
            message: `${entry.join(',')} 落在施工计划声明的范围之外`,
            source: 'construction',
          }),
        );

  const audit = auditOperationCells(world, {
    object,
    writes: recorder.auditWrites(),
    carves: recorder.auditCarves(),
    ...(request.rules ? { rules: request.rules } : {}),
    ...(request.protection ? { protection: request.protection } : {}),
    ...(request.overlapAllowed ? { overlapAllowed: request.overlapAllowed } : {}),
    ...(request.carveAllowed ? { carveAllowed: request.carveAllowed } : {}),
    ...(request.excavationAuthorized ? { excavationAuthorized: true } : {}),
  });
  for (const position of audit.overlaps)
    diagnostics.push(
      coordinateDiagnostic({
        rule: CONSTRUCTION_RULES.occupied,
        object,
        position,
        message: `${position.join(',')} 已被 ${world.get(position[0], position[1], position[2])?.name ?? '方块'} 占用，且该对象无权覆盖`,
        data: { existing: world.get(position[0], position[1], position[2])?.name ?? null },
        source: 'construction',
      }),
    );
  if (audit.violations.length)
    diagnostics.push(...protectionDiagnostics(audit.violations, { object, rule: PLACEMENT_RULES.protection }));

  // One line per plan, so merge decisions are visible even when they are the
  // expected ones: nothing is resolved silently by loop order.
  const merges = recorder.stats();
  if (merges.duplicates + merges.overwritten + merges.refilled + merges.excavated + merges.replaced > 0)
    diagnostics.push(
      coordinateDiagnostic({
        rule: 'construction.merge',
        severity: 'info',
        object,
        region: writes.length || carves.length ? region : emptyBox(),
        message: `合并：重复写入 ${merges.duplicates}、层替换 ${merges.replaced}、开挖覆盖填充 ${merges.excavated}、回填 ${merges.refilled}、非预期覆盖 ${merges.overwritten}`,
        data: { ...merges },
        source: 'construction',
      }),
    );

  if (world.revision !== baseRevision)
    diagnostics.push(
      coordinateDiagnostic({
        rule: CONSTRUCTION_RULES.staleTarget,
        object,
        message: '规划回调修改了目标模型；回调必须只通过施工记录器输出操作',
        source: 'construction',
      }),
    );
  const merged = mergeDiagnostics(diagnostics);
  return {
    id: request.id,
    object,
    targetIdentity,
    baseRevision,
    writes,
    carves,
    region,
    bounds: writes.length || carves.length ? region : null,
    diagnostics: merged,
    violations: audit.violations,
    merges,
    feasible: !merged.some((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'unknown'),
  };
}

/* --------------------------------- commit ---------------------------------- */

/**
 * Why a plan may not be committed to this model, or `null` when it may.
 *
 * Exposed so a caller can turn the refusal into its own report instead of
 * catching a throw; `commitConstruction` uses the same check.
 */
export function staleTargetReason(
  world: Structure,
  plan: Pick<ConstructionPlan, 'targetIdentity' | 'baseRevision' | 'id'>,
): string | null {
  if (plan.targetIdentity !== structureIdentity(world))
    return `施工计划 ${plan.id} 是为另一个模型实例准备的，拒绝提交到当前模型`;
  if (plan.baseRevision !== world.revision)
    return `施工计划 ${plan.id} 基于 revision ${plan.baseRevision}，模型现为 ${world.revision}；请对当前模型重新规划`;
  return null;
}

/** Apply a verified plan. Writes only: no user callback runs here. */
export function commitConstruction(
  world: Structure,
  plan: ConstructionPlan,
): { written: number; removed: number; unchanged: number } {
  const reason = staleTargetReason(world, plan);
  if (reason) throw new Error(reason);
  if (!plan.feasible)
    throw new Error(`拒绝提交不可行的施工计划 ${plan.id}：${plan.diagnostics.map((item) => item.message).join('; ')}`);
  let removed = 0;
  const cleared = new Set<string>();
  for (const carve of plan.carves) {
    const [x, y, z] = carve.position;
    cleared.add(carve.position.join(','));
    if (world.get(x, y, z)?.name === AIR.name) continue;
    world.set(x, y, z, AIR);
    removed++;
  }
  let written = 0;
  let unchanged = 0;
  for (const write of plan.writes) {
    const [x, y, z] = write.position;
    const existing = world.get(x, y, z) ?? null;
    if (existing && existing.name === write.state.name && sameState(existing, write.state)) unchanged++;
    else written++;
    world.set(x, y, z, write.state);
  }
  return { written, removed, unchanged };
}

/** Report shape used by the convenience entry points below. */
export function constructionSummary(plan: ConstructionPlan): Diagnostic {
  return coordinateDiagnostic({
    rule: 'construction.summary',
    severity: 'info',
    object: plan.object,
    region: plan.bounds ?? emptyBox(),
    message: `${plan.id}：写入 ${plan.writes.length} 格、挖除 ${plan.carves.length} 格（重复 ${plan.merges.duplicates}、层替换 ${plan.merges.replaced}、覆盖 ${plan.merges.overwritten}、回填 ${plan.merges.refilled}、开挖 ${plan.merges.excavated}）`,
    source: 'construction',
  });
}
