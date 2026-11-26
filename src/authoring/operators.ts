import { contains, type Box, type State, type Structure, type Vec3 } from '../core/structure.js';
import { coordinateDiagnostic, type Diagnostic, type DiagnosticObject } from './diagnostics.js';
import { ProtectionRegistry, protectionDiagnostics } from './protection.js';
import { collisionBoxes, type PlayerModel } from './traversal.js';
import { standableAt } from './reachability.js';
import { checkWaterSystem, type WaterCheckOptions } from './water/check.js';
import type { WaterPlan } from './water/contracts.js';
import { roadPassability, type RoadPlan } from './roads.js';

/**
 * 公共检查算子：所有建筑共享的最终模型判定。
 *
 * 每个算子都**在最终模型上重新执行**，不依赖生成时的乐观判断，也都读取对象
 * 契约（声明过的桥梁、悬挑、树枝、瀑布、水段类型），所以合法结构不会被统一
 * 判成"悬空错误"；建筑特有的审美阈值留在各建筑自己的 check 里。
 */

export const CHECK_RULES = {
  outOfBounds: 'support.out-of-bounds',
  floating: 'support.floating',
  overlapping: 'support.terrain-overlap',
  unreachable: 'route.unreachable',
  step: 'route.step',
  headroom: 'route.headroom',
} as const;

/* ------------------------------ 1) 保护区与净空 ----------------------------- */

/** Re-audit every registered protection zone against the final model. */
export function auditProtection(
  world: Structure,
  protection: ProtectionRegistry,
  options: Readonly<{ rule?: string }> = {},
): Diagnostic[] {
  const violations = protection.audit(world);
  return protectionDiagnostics(violations, { rule: options.rule ?? 'protection.occupied' });
}

/* --------------------- 2) 对象支撑、枝叶连通、地形重叠 --------------------- */

export type SupportContract = Readonly<{
  /** The object this contract describes. */
  object: DiagnosticObject | string;
  /** Cells the object legitimately occupies. */
  cells: readonly Vec3[];
  /**
   * `ground` — every cell must reach the ground through the object or the world;
   * `anchored` — at least one cell must rest on solid ground (cantilevers, branches);
   * `self-connected` — cells must form one face-connected mass (crowns, roofs);
   * `declared-floating` — waterfall sheets and hanging chains: nothing is required.
   */
  support: 'ground' | 'anchored' | 'self-connected' | 'declared-floating';
  /** Cells that must be solid under the object; defaults to the lowest cells. */
  anchors?: readonly Vec3[];
  /** Terrain overlap is allowed for these cells (bases, foundations). */
  allowTerrainOverlap?: readonly Vec3[];
  label?: string;
}>;

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function objectOf(value: DiagnosticObject | string): DiagnosticObject {
  return typeof value === 'string' ? { kind: value, id: value } : value;
}

/** Solid enough to carry something: a supported collision box with a real top. */
function carries(state: State | null): boolean {
  const collision = collisionBoxes(state);
  return collision.kind === 'supported' && collision.boxes.some((box) => box[4] >= 0.5);
}

/**
 * Object support, foliage connectivity and forbidden terrain overlap.
 *
 * The contract is what keeps this from flagging every legal bridge or branch:
 * only objects that *declare* `ground` support are asked to reach the ground,
 * and `declared-floating` objects (waterfall sheets, hanging chains) are checked
 * for connectivity alone.
 */
export function checkSupport(
  world: Pick<Structure, 'get'>,
  contracts: readonly SupportContract[],
  bounds?: Box,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const contract of contracts) {
    const object = objectOf(contract.object);
    const label = contract.label ?? object.id;
    if (bounds)
      for (const cell of contract.cells)
        if (!contains(bounds, cell[0], cell[1], cell[2]))
          diagnostics.push(
            coordinateDiagnostic({
              rule: CHECK_RULES.outOfBounds,
              object,
              position: [...cell] as Vec3,
              message: `${label} 的方块 ${cell.join(',')} 越出声明范围`,
              source: 'support-check',
            }),
          );
    if (contract.support === 'declared-floating') continue;

    const anchors = contract.anchors ?? contract.cells;
    if (contract.support === 'anchored' || contract.support === 'ground') {
      const anchored = anchors.some((cell) => carries(world.get(cell[0], cell[1] - 1, cell[2])));
      if (!anchored)
        diagnostics.push(
          coordinateDiagnostic({
            rule: CHECK_RULES.floating,
            object,
            position: anchors[0] ? ([...anchors[0]] as Vec3) : [0, 0, 0],
            message: `${label} 没有任何落脚点（${anchors.length} 个候选锚点下方都不是可支撑方块）`,
            data: { anchors: anchors.slice(0, 8) },
            source: 'support-check',
          }),
        );
      if (contract.support === 'anchored') continue;
    }

    if (contract.support === 'ground') {
      // Flood the object's own cells and any solid world block; anything not
      // reachable is genuinely floating.
      const cells = new Set(contract.cells.map((cell) => key(cell[0], cell[1], cell[2])));
      const reached = new Set<string>();
      const queue: Vec3[] = [];
      for (const cell of contract.cells) if (carries(world.get(cell[0], cell[1] - 1, cell[2]))) queue.push(cell);
      while (queue.length) {
        const [x, y, z] = queue.pop()!;
        const k = key(x, y, z);
        if (reached.has(k)) continue;
        reached.add(k);
        for (const [dx, dy, dz] of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ] as const) {
          const nx = x + dx,
            ny = y + dy,
            nz = z + dz;
          const nk = key(nx, ny, nz);
          if (cells.has(nk) && !reached.has(nk)) queue.push([nx, ny, nz]);
        }
      }
      const floating = contract.cells.filter((cell) => !reached.has(key(cell[0], cell[1], cell[2])));
      if (floating.length)
        diagnostics.push(
          coordinateDiagnostic({
            rule: CHECK_RULES.floating,
            object,
            position: [...floating[0]!] as Vec3,
            message: `${label} 有 ${floating.length} 格无法经自身连通到地面（首格 ${floating[0]!.join(',')}）`,
            data: { count: floating.length, samples: floating.slice(0, 8) },
            source: 'support-check',
          }),
        );
      continue;
    }

    if (contract.support === 'self-connected') {
      // Face-connected components; more than one means the object is in pieces.
      const cells = new Set(contract.cells.map((cell) => key(cell[0], cell[1], cell[2])));
      const seen = new Set<string>();
      let components = 0;
      for (const cell of contract.cells) {
        const k = key(cell[0], cell[1], cell[2]);
        if (seen.has(k)) continue;
        components++;
        const stack: Vec3[] = [cell];
        while (stack.length) {
          const [x, y, z] = stack.pop()!;
          const current = key(x, y, z);
          if (seen.has(current)) continue;
          seen.add(current);
          for (const [dx, dy, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ] as const)
            if (cells.has(key(x + dx, y + dy, z + dz))) stack.push([x + dx, y + dy, z + dz]);
        }
      }
      if (components > 1)
        diagnostics.push(
          coordinateDiagnostic({
            rule: CHECK_RULES.floating,
            object,
            position: contract.cells[0] ? ([...contract.cells[0]] as Vec3) : [0, 0, 0],
            message: `${label} 分成 ${components} 块互不面连的部分，枝叶或屋面不连通`,
            data: { components },
            source: 'support-check',
          }),
        );
    }
  }
  return diagnostics;
}

/** Terrain overlap: object cells that sit inside the ground without permission. */
export function checkTerrainOverlap(world: Structure, contract: SupportContract): Diagnostic[] {
  const allowed = new Set((contract.allowTerrainOverlap ?? []).map((cell) => key(cell[0], cell[1], cell[2])));
  const diagnostics: Diagnostic[] = [];
  const object = objectOf(contract.object);
  for (const cell of contract.cells) {
    if (allowed.has(key(cell[0], cell[1], cell[2]))) continue;
    const state = world.get(cell[0], cell[1], cell[2]);
    // Overlap is only a problem when the object cell itself holds natural
    // terrain: a placed block of the object is the expected content.
    if (!state || !carries(state)) continue;
    if (
      !/^(stone|andesite|granite|diorite|tuff|deepslate|dirt|coarse_dirt|grass_block|podzol|gravel|clay|sand)$/.test(
        state.name.replace(/^minecraft:/, ''),
      )
    )
      continue;
    diagnostics.push(
      coordinateDiagnostic({
        rule: CHECK_RULES.overlapping,
        object,
        position: [...cell] as Vec3,
        message: `${contract.label ?? object.id} 的 ${cell.join(',')} 与地形重叠（${state.name}）且未声明允许`,
        data: { block: state.name },
        source: 'support-check',
      }),
    );
  }
  return diagnostics;
}

/* ------------------------ 3) 路线逐步高差与通行 ------------------------- */

export type RouteContract = Readonly<{
  object: DiagnosticObject | string;
  /** Ordered walking cells (feet positions). */
  path: readonly Vec3[];
  /** Player model used for passability; defaults to framework values. */
  player?: Partial<PlayerModel>;
  /** Required headroom above each foot cell. */
  headroom?: number;
  /** Maximum rise/drop between consecutive cells. */
  maxStepUp?: number;
  maxStepDown?: number;
  /** Where the route must start and end (feet cells). */
  start?: Vec3;
  end?: Vec3;
}>;

/**
 * Step heights and player passability along a declared route.
 *
 * Every verdict reads the final model's collision boxes, so a missing slab or a
 * leaf across the corridor is caught here rather than in a screenshot.
 */
export function checkRoute(world: Structure, contract: RouteContract): Diagnostic[] {
  const object = objectOf(contract.object);
  const diagnostics: Diagnostic[] = [];
  const label = object.id;
  const maxStepUp = contract.maxStepUp ?? 1;
  const maxStepDown = contract.maxStepDown ?? 1;
  const headroom = contract.headroom ?? 2;
  for (const [index, cell] of contract.path.entries()) {
    const [x, y, z] = cell;
    const support = world.get(x, y - 1, z);
    const supportCollision = collisionBoxes(support);
    if (supportCollision.kind === 'unknown')
      diagnostics.push(
        coordinateDiagnostic({
          rule: CHECK_RULES.unreachable,
          severity: 'unknown',
          object,
          position: [x, y - 1, z],
          message: `${label} 第 ${index} 步（${x},${y},${z}）下方 ${support?.name ?? '空'} 的碰撞形状未确认`,
          conclusive: false,
          source: 'route-check',
        }),
      );
    else if (!standableAt(world, x, y, z))
      diagnostics.push(
        coordinateDiagnostic({
          rule: CHECK_RULES.unreachable,
          object,
          position: [x, y, z],
          message: `${label} 第 ${index} 步（${x},${y},${z}）不可站立`,
          source: 'route-check',
        }),
      );
    for (let offset = 0; offset < headroom; offset++) {
      const state = world.get(x, y + offset, z);
      const collision = collisionBoxes(state);
      if (collision.kind === 'unknown') {
        diagnostics.push(
          coordinateDiagnostic({
            rule: CHECK_RULES.headroom,
            severity: 'unknown',
            object,
            position: [x, y + offset, z],
            message: `${label} 第 ${index} 步头顶 ${state?.name} 的碰撞形状未确认`,
            conclusive: false,
            source: 'route-check',
          }),
        );
        continue;
      }
      if (collision.boxes.some((box) => box[4] > 0.5))
        diagnostics.push(
          coordinateDiagnostic({
            rule: CHECK_RULES.headroom,
            object,
            position: [x, y + offset, z],
            message: `${label} 第 ${index} 步头顶净空被 ${state?.name} 占用`,
            source: 'route-check',
          }),
        );
    }
    const previous = contract.path[index - 1];
    if (previous) {
      const horizontal = Math.max(Math.abs(previous[0] - x), Math.abs(previous[2] - z));
      const rise = y - previous[1];
      if (horizontal > 1)
        diagnostics.push(
          coordinateDiagnostic({
            rule: CHECK_RULES.unreachable,
            object,
            position: [x, y, z],
            message: `${label} 第 ${index} 步与上一步水平相距 ${horizontal} 格，中间断开`,
            source: 'route-check',
          }),
        );
      const limit = rise >= 0 ? maxStepUp : maxStepDown;
      if (Math.abs(rise) > limit)
        diagnostics.push(
          coordinateDiagnostic({
            rule: CHECK_RULES.step,
            object,
            position: [x, y, z],
            message: `${label} 第 ${index} 步高差 ${rise}，超过允许的 ${limit}`,
            data: { step: index, rise, limit },
            source: 'route-check',
          }),
        );
    }
  }
  if (contract.start && !standableAt(world, ...contract.start))
    diagnostics.push(
      coordinateDiagnostic({
        rule: CHECK_RULES.unreachable,
        object,
        position: [...contract.start] as Vec3,
        message: `${label} 的起点不可站立`,
        source: 'route-check',
      }),
    );
  if (contract.end && !standableAt(world, ...contract.end))
    diagnostics.push(
      coordinateDiagnostic({
        rule: CHECK_RULES.unreachable,
        object,
        position: [...contract.end] as Vec3,
        message: `${label} 的终点不可站立`,
        source: 'route-check',
      }),
    );
  return diagnostics;
}

/** Route operator for a paved road plan (plan cells are the walking path). */
export function checkRoadRoute(world: Structure, plan: RoadPlan): Diagnostic[] {
  return roadPassability(world, plan);
}

/* --------------------------- 4) 水段连续性与容水边界 --------------------------- */

/** Water operator: re-check every segment kind against the final model. */
export function checkWater(world: Structure, plan: WaterPlan, options: WaterCheckOptions = {}): Diagnostic[] {
  return checkWaterSystem(world, plan, options);
}
