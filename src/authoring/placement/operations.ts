import type { Box, State, Structure, Vec3 } from '../../core/structure.js';
import type { DiagnosticObject } from '../diagnostic-core.js';
import type { ProtectionRegistry, ProtectionViolation } from '../protection.js';
import type { ProtectionRuleSet } from '../rules.js';
import {
  IDENTITY_TRANSFORM,
  transformPosition,
  transformState,
  type BlockTransform,
  type UntransformableState,
} from '../transform.js';
import { auditOperationCells } from './policy.js';
import { toVec3, emptyBox, growBox } from './cells.js';
import { assertPoint } from '../layout.js';

/* ---------------------------------------------------------------------------
 * 纯操作规划：真正决定"写什么、挖什么、会不会越权"的唯一实现。
 * `planPlacement`（完整放置规划）与 `placeObject`（整体提交）都调用它，
 * 所以预览与实际写入不可能出现两套判断。它**不写世界**——这是设计约束。
 * ------------------------------------------------------------------------- */

export type OperationRequest = Readonly<{
  prefab: Structure;
  origin: Vec3;
  transform?: BlockTransform;
  offset?: Vec3;
  object: DiagnosticObject | string;
  /** `true` (default) makes explicit-air prefab cells clear their target cells. */
  carveAir?: boolean;
  /** Extra world-space cells to clear (bounded excavation, foundation top-up). */
  extraCarves?: readonly Vec3[];
  rules?: ProtectionRuleSet;
  protection?: ProtectionRegistry;
  /**
   * Ownership predicate: returning true accepts an occupied cell instead of
   * reporting an overlap. This is the single place where "may this object
   * replace that block" is answered — material, object kind and the operation's
   * authority all have to be folded in by the caller's predicate, so a natural
   * rock and a placed stone path can be told apart.
   */
  overlapAllowed?: (existing: State | null, position: Vec3) => boolean;
  carveAllowed?: (existing: State | null, position: Vec3) => boolean;
  /**
   * The operation holds excavation authority (a bounded cut budget). Occupied
   * cells in the footprint are then handled by the cut rule, so they are not
   * ownership failures; the caller still reports the cut volume and its budget.
   */
  excavationAuthorized?: boolean;
  /** Material used for `foundation` cells; defaults to the prefab's first block. */
  foundation?: (position: Vec3, depthBelowSurface: number) => State;
}>;

export type OperationPlan = Readonly<{
  writes: readonly { position: Vec3; state: State }[];
  carves: readonly Vec3[];
  untransformable: readonly UntransformableState[];
  violations: readonly ProtectionViolation[];
  /** Writed cells that would overwrite something the object may not touch. */
  overlaps: readonly Vec3[];
  region: Box;
}>;

export function planOperation(world: Structure, request: OperationRequest): OperationPlan {
  assertPoint(request.origin);
  if (request.offset) assertPoint(request.offset);
  for (const point of request.extraCarves ?? []) assertPoint(point);
  const spec = request.transform ?? IDENTITY_TRANSFORM;
  const offset = request.offset ?? ([0, 0, 0] as Vec3);
  const origin = toVec3(request.origin);
  const object: DiagnosticObject =
    typeof request.object === 'string' ? { kind: request.object, id: request.object } : request.object;
  const untransformable: UntransformableState[] = [];
  const writes: { position: Vec3; state: State }[] = [];
  const carves: Vec3[] = [];
  const overlaps: Vec3[] = [];
  let region = emptyBox();

  request.prefab.forEach((x, y, z, id) => {
    const state = request.prefab.palette[id]!;
    const mapped = transformState(state, spec);
    if (mapped.untransformed.length) {
      untransformable.push({ name: state.name, keys: mapped.untransformed });
      return;
    }
    const turned = transformPosition([x, y, z], spec);
    const position: Vec3 = [
      turned[0] + origin[0] + offset[0],
      turned[1] + origin[1] + offset[1],
      turned[2] + origin[2] + offset[2],
    ];
    assertPoint(position);
    region = growBox(region, position);
    if (state.name === 'minecraft:air') {
      // Explicit air in a prefab is a clearing instruction, never a write: the
      // registry's air block is a no-op in the IR, so keeping it as a "write"
      // would silently drop the carve.
      if (request.carveAir !== false) carves.push(position);
      return;
    }
    const incoming: State = { name: state.name, states: mapped.states };
    writes.push({ position, state: incoming });
  });
  for (const extra of request.extraCarves ?? []) {
    carves.push([...extra] as Vec3);
    region = growBox(region, extra);
  }

  const violations: ProtectionViolation[] = [];
  const audit = auditOperationCells(world, {
    object,
    writes,
    carves,
    ...(request.rules ? { rules: request.rules } : {}),
    ...(request.protection ? { protection: request.protection } : {}),
    ...(request.overlapAllowed ? { overlapAllowed: request.overlapAllowed } : {}),
    ...(request.carveAllowed ? { carveAllowed: request.carveAllowed } : {}),
    ...(request.excavationAuthorized ? { excavationAuthorized: true } : {}),
  });
  violations.push(...audit.violations);
  overlaps.push(...audit.overlaps);
  // A cell cannot be both carved and written; the write wins.
  const writeKeys = new Set(writes.map((write) => write.position.join(',')));
  const uniqueCarves = new Map<string, Vec3>();
  for (const carve of carves) if (!writeKeys.has(carve.join(','))) uniqueCarves.set(carve.join(','), carve);
  return {
    writes,
    carves: [...uniqueCarves.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]),
    untransformable,
    violations,
    overlaps,
    region,
  };
}
