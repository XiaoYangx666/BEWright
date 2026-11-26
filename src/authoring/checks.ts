import type { Vec3 } from '../core/structure.js';
import type { BlockKit } from './kit.js';
import type { RoofPlan } from './roof-surface.js';

/**
 * 结构诊断：生成后调用，只报告、不抛错、不放置。
 * 悬空的判定基于调用时刻的 kit 状态，因此应在建筑主体完成后检查。
 * 通用自检（越界、占位几何、灯笼支撑）见 `reachability.ts` 的 `modelIssues()`。
 */

/**
 * 屋面格中“正下方为空且同层四个面邻全为空”的悬空瓦。
 * 薄壳屋面横向相连不会误报；同层的烟囱、山墙等已有方块也算支撑。
 */
export function floatingRoofTiles(kit: BlockKit, plan: RoofPlan): Vec3[] {
  const floating: Vec3[] = [];
  for (const cell of plan.cells) {
    const [x, y, z] = cell.position;
    if (!kit.empty(x, y - 1, z)) continue;
    if (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].every(([dx, dz]) => kit.empty(x + dx, y, z + dz))
    )
      floating.push([x, y, z]);
  }
  return floating;
}
