import { contains, type State, type Structure, type Vec3 } from '../../core/structure.js';
import { coordinateDiagnostic, type Diagnostic, type DiagnosticObject } from '../diagnostic-core.js';
import { collisionBoxes } from '../traversal.js';
import { WATER_RULES, type WaterPlan } from './contracts.js';
import { segmentObject } from './geometry.js';

export type WaterCheckOptions = Readonly<{
  /** Treat water as continuous only when neighbouring cells are at most this far apart. */
  maxHydraulicGap?: number;
  /** Require declared `wall-sheet` segments to stay this far from rock. */
  requireWallDistance?: boolean;
}>;

/** Can this block be trusted to hold water in: a confirmed full cube? */
export function sealsWater(state: State | null | undefined): 'sealed' | 'open' | 'unknown' {
  if (!state || state.name === 'minecraft:air' || state.name === 'minecraft:water') return 'open';
  const collision = collisionBoxes(state);
  if (collision.kind === 'unknown') return 'unknown';
  const full = collision.boxes.some(
    (box) => box[0] === 0 && box[1] === 0 && box[2] === 0 && box[3] === 1 && box[4] === 1 && box[5] === 1,
  );
  return full ? 'sealed' : 'open';
}

/**
 * Check the finished model segment by segment.
 *
 * The rules are deliberately kind-specific:
 * - `drop` may hang in the air (that is what a waterfall is), so it has no floor
 *   or side contract, and only `wall-sheet` segments are asked to hug rock;
 * - `reach` needs a wet, monotonically descending, unbroken surface;
 * - `pool` needs a closed body: floor plus sides, so water cannot leak sideways.
 *
 * The body boundary is judged on real collision geometry, not on material names:
 * a full cube seals, air fails loudly and an unknown shape stays `unknown`
 * instead of passing.
 */
export function checkWaterSystem(
  world: Pick<Structure, 'get'>,
  plan: WaterPlan,
  options: WaterCheckOptions = {},
): Diagnostic[] {
  const object: DiagnosticObject = { kind: 'water-system', id: plan.id };
  const diagnostics: Diagnostic[] = [];
  const isWater = (x: number, y: number, z: number) => world.get(x, y, z)?.name === 'minecraft:water';
  const plannedWet = new Set<string>();
  for (const segment of plan.segments)
    for (const cell of [...segment.surfaceCells, ...segment.basinCells]) plannedWet.add(cell.join(','));
  for (const segment of plan.segments) for (const cell of segment.spec.inflows ?? []) plannedWet.add(cell.join(','));

  const boundaryDiagnostic = (
    rule: string,
    segmentId: DiagnosticObject,
    position: Vec3,
    message: string,
    status: 'open' | 'unknown',
    data: Record<string, unknown> = {},
  ) =>
    diagnostics.push(
      coordinateDiagnostic({
        rule: status === 'unknown' ? WATER_RULES.boundaryUnknown : rule,
        severity: status === 'unknown' ? 'unknown' : 'error',
        conclusive: status !== 'unknown',
        object: segmentId,
        position,
        message,
        data,
        source: 'water-check',
      }),
    );

  // The source must really be water in the finished model — but only when the
  // plan actually puts water there. A `source` is often just an upstream
  // reference point (the lip above a fall), and demanding water at a reference
  // point is the kind of rule that makes a legitimate waterfall look broken.
  {
    const [sx, sy, sz] = plan.source;
    if (plannedWet.has(plan.source.join(',')) && !isWater(sx, sy, sz))
      diagnostics.push(
        coordinateDiagnostic({
          rule: WATER_RULES.drySource,
          object,
          position: [...plan.source] as Vec3,
          message: `源头 ${plan.source.join(',')} 在最终模型里没有水（实际为 ${world.get(sx, sy, sz)?.name ?? '未设置'}）`,
          source: 'water-check',
        }),
      );
  }

  for (const segment of plan.segments) {
    const kind = segment.spec.kind;
    const segmentId = segmentObject(segment.spec);
    const label = kind === 'wall-sheet' ? '贴壁水帘' : kind === 'drop' ? '跌水' : kind === 'pool' ? '潭' : '河段';
    if (kind === 'reach' || kind === 'wall-sheet') {
      // 1) Continuity: every planned water cell must exist as water.
      for (const cell of segment.surfaceCells)
        if (!isWater(cell[0], cell[1], cell[2]))
          diagnostics.push(
            coordinateDiagnostic({
              rule: WATER_RULES.discontinuity,
              object: segmentId,
              position: cell,
              message: `${label} ${segment.spec.id} 在 ${cell.join(',')} 断水（实际为 ${world.get(cell[0], cell[1], cell[2])?.name ?? '未设置'}）`,
              source: 'water-check',
            }),
          );
      // 2) Monotonic descent along the declared design levels: an unexpected
      //    uphill is a leak or a mis-set surface, not a stylistic choice.
      let previous: number | null = null;
      for (const step of segment.steps) {
        if (previous !== null && step[1] > previous)
          diagnostics.push(
            coordinateDiagnostic({
              rule: WATER_RULES.uphill,
              object: segmentId,
              position: [...step] as Vec3,
              message: `${segment.spec.id} 在 ${step.join(',')} 出现非预期逆坡：水面从 ${previous} 抬到 ${step[1]}`,
              data: { previous, current: step[1] },
              source: 'water-check',
            }),
          );
        previous = step[1];
      }
    }
    if (kind === 'drop' || kind === 'wall-sheet') {
      // 3) A declared wall sheet must keep its declared distance from the wall:
      //    a sheet that hangs one block off the rock is not "attached to it".
      //    Only `wall-sheet` segments are asked for this — a free-falling
      //    waterfall is allowed to be nowhere near a wall.
      if (kind === 'wall-sheet' && (segment.spec.wallDistance ?? 0) > 0 && options.requireWallDistance !== false) {
        const want = segment.spec.wallDistance!;
        const head = segment.spec.path[0]!;
        const tail = segment.spec.path.at(-1)!;
        const solid = (x: number, y: number, z: number) => sealsWater(world.get(x, y, z)) !== 'open';
        /*
         * Which side carries the rock is a property of the scene, not of the
         * declared path: a sheet that falls straight down has no horizontal
         * direction to take a perpendicular from, and the wall may sit on either
         * side. Probe the four cardinal directions from the sheet's head and use
         * the nearest rock as the normal for the whole segment.
         */
        let normal: [number, number] | null = null;
        let nearest = Infinity;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const)
          for (let step = 1; step <= want + 2; step++) {
            if (!solid(head[0] + dx * step, head[1], head[2] + dz * step)) continue;
            if (step < nearest) {
              nearest = step;
              normal = [dx, dz];
            }
            break;
          }
        void tail;
        for (const cell of segment.surfaceCells) {
          if (!normal) {
            diagnostics.push(
              coordinateDiagnostic({
                rule: WATER_RULES.wallDistance,
                object: segmentId,
                position: [...cell] as Vec3,
                message: `贴壁水帘 ${segment.spec.id} 声明贴壁 ${want} 格，但 ${cell.join(',')} 四周找不到岩壁`,
                data: { declared: want, actual: null },
                source: 'water-check',
              }),
            );
            break;
          }
          let found: number | null = null;
          for (let step = 1; step <= want + 2; step++)
            if (solid(cell[0] + normal[0] * step, cell[1], cell[2] + normal[1] * step)) {
              found = step;
              break;
            }
          if (found !== want && cell[1] >= Math.min(head[1], tail[1]) && cell[1] <= Math.max(head[1], tail[1]))
            diagnostics.push(
              coordinateDiagnostic({
                rule: WATER_RULES.wallDistance,
                object: segmentId,
                position: [...cell] as Vec3,
                message:
                  found === null
                    ? `贴壁水帘 ${segment.spec.id} 声明贴壁 ${want} 格，但 ${cell.join(',')} 沿法向找不到岩壁`
                    : `贴壁水帘 ${segment.spec.id} 声明贴壁 ${want} 格，实际离岩壁 ${found} 格`,
                data: { declared: want, actual: found },
                source: 'water-check',
              }),
            );
        }
      }
      // A drop must still be wet end to end, but never requires support below.
      for (const cell of segment.surfaceCells)
        if (!isWater(cell[0], cell[1], cell[2]))
          diagnostics.push(
            coordinateDiagnostic({
              rule: WATER_RULES.discontinuity,
              object: segmentId,
              position: cell,
              message: `${label} ${segment.spec.id} 在 ${cell.join(',')} 断水`,
              source: 'water-check',
            }),
          );
      continue;
    }

    // 4) Body boundary for anything that is supposed to hold water: the floor
    //    under every column and the sides of every water cell must be sealed by
    //    a confirmed full cube, be part of another planned water body (a legal
    //    mouth), or be declared as an inflow. Air fails; unknown stays unknown.
    if (kind === 'pool' && !segment.spec.basin)
      diagnostics.push(
        coordinateDiagnostic({
          rule: WATER_RULES.basinLeak,
          object: segmentId,
          position: [...plan.source] as Vec3,
          message: `潭 ${segment.spec.id} 没有声明容水边界，无法判定是否漏水`,
          source: 'water-check',
        }),
      );
    for (const column of segment.columns) {
      if (!isWater(column.x, column.top, column.z) || !isWater(column.x, column.bottom, column.z)) {
        // Continuity for bodies is reported per cell below; the boundary rules
        // only judge cells that exist.
      }
      const floorState = world.get(column.x, column.bed, column.z);
      const floor = sealsWater(floorState);
      if (floor !== 'sealed')
        boundaryDiagnostic(
          WATER_RULES.basinFloor,
          segmentId,
          [column.x, column.bed, column.z],
          floor === 'open'
            ? `${label} ${segment.spec.id} 在 ${column.x},${column.bed},${column.z} 水底开口（实际为 ${floorState?.name ?? '未设置'}）`
            : `${label} ${segment.spec.id} 在 ${column.x},${column.bed},${column.z} 的水底材料 ${floorState?.name} 无法确认为封闭方块`,
          floor === 'unknown' ? 'unknown' : 'open',
          { column: { x: column.x, z: column.z, top: column.top, bottom: column.bottom } },
        );
    }
    for (const cell of segment.surfaceCells) {
      if (!isWater(cell[0], cell[1], cell[2]))
        diagnostics.push(
          coordinateDiagnostic({
            rule: kind === 'pool' ? WATER_RULES.basinLeak : WATER_RULES.discontinuity,
            object: segmentId,
            position: [...cell] as Vec3,
            message:
              kind === 'pool'
                ? `潭 ${segment.spec.id} 在 ${cell.join(',')} 没有蓄水`
                : `${label} ${segment.spec.id} 在 ${cell.join(',')} 断水`,
            source: 'water-check',
          }),
        );
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cell[0] + dx;
        const ny = cell[1];
        const nz = cell[2] + dz;
        const key = `${nx},${ny},${nz}`;
        const external = segment.spec.externalOutlet;
        if (external) {
          const [ex, ez] = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ][external.facing]!;
          const onPort = segment.outletCells.some((p) => p[0] === cell[0] && p[2] === cell[2]);
          if (
            onPort &&
            dx === ex &&
            dz === ez &&
            contains(external.bounds, ...cell) &&
            !contains(external.bounds, nx, ny, nz)
          )
            continue;
        }
        if (plannedWet.has(key)) continue;
        const neighbour = world.get(nx, ny, nz);
        if (neighbour?.name === 'minecraft:water') {
          diagnostics.push(
            coordinateDiagnostic({
              rule: WATER_RULES.basinLeak,
              object: segmentId,
              position: [nx, ny, nz],
              message: `${label} ${segment.spec.id} 的水从侧面 ${key} 漏出容水边界（计划里没有这段水）`,
              source: 'water-check',
            }),
          );
          continue;
        }
        const seal = sealsWater(neighbour);
        if (seal === 'sealed') continue;
        boundaryDiagnostic(
          WATER_RULES.basinLeak,
          segmentId,
          [nx, ny, nz],
          seal === 'open'
            ? `${label} ${segment.spec.id} 的侧面 ${key} 是${neighbour ? ` ${neighbour.name} ` : '空气'}，水会从这里漏出容水边界`
            : `${label} ${segment.spec.id} 的侧面 ${key} 材料 ${neighbour?.name} 无法确认为封闭方块`,
          seal === 'unknown' ? 'unknown' : 'open',
          { from: [...cell] as Vec3 },
        );
      }
    }
  }

  // Outlet: water must actually reach the declared exit.
  if (plan.outlet) {
    const [x, y, z] = plan.outlet;
    const state = world.get(x, y, z);
    if (state?.name !== 'minecraft:water')
      diagnostics.push(
        coordinateDiagnostic({
          rule: WATER_RULES.outlet,
          object,
          position: [...plan.outlet] as Vec3,
          message: `出口 ${plan.outlet.join(',')} 没有水（实际为 ${state?.name ?? '未设置'}）`,
          source: 'water-check',
        }),
      );
  }
  return diagnostics;
}
