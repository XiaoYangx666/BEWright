import { collisionBoxes } from './traversal.js';
import { contains, type Box, type Structure, type Vec3 } from '../core/structure.js';
import { materials } from '../blocks/materials.js';
import { fromMessage, type Diagnostic } from './diagnostics.js';

/**
 * 通行与自检：把“建筑能不能走、放得对不对”变成可复用的静态体素检查。
 * 这些检查不模拟游戏物理——碰撞来自框架的碰撞盒表，
 * 通行判定允许“跳上一格”，头顶净空按玩家身高折算。
 */
export const PLAYER = { width: 0.6, height: 1.8, maxStepUp: 1.1, maxStepDown: 1 } as const;

/** 该格没有实体碰撞（空气、水体、嵌草等），可以进入。 */
export function passableCell(world: Structure, x: number, y: number, z: number): boolean {
  const collision = collisionBoxes(world.get(x, y, z));
  return collision.kind === 'supported' && collision.boxes.length === 0;
}

/** 该格实体碰撞的最高点（脚可以站在其上的标高）。 */
export function supportTopAt(world: Structure, x: number, y: number, z: number): number {
  const collision = collisionBoxes(world.get(x, y, z));
  if (collision.kind !== 'supported') return 0;
  return collision.boxes.reduce((top, box) => Math.max(top, box[4]), 0);
}

/** 玩家能否在此格站立：脚下有 ≥0.5 的支撑，身体两格无碰撞。 */
export function standableAt(world: Structure, x: number, y: number, z: number): boolean {
  return supportTopAt(world, x, y - 1, z) >= 0.5 && passableCell(world, x, y, z) && passableCell(world, x, y + 1, z);
}

/**
 * 玩家可达格集合：从出生格出发，四向移动允许 ±1 落差，
 * 上跳一格还要求头顶再上一格无碰撞。不可站立的起点会被忽略。
 * 返回 "x,y,z" 键集合。
 */
export function walkableCells(world: Structure, starts: Vec3[]): Set<string> {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  // Collision depends on the palette state, not its position. Large maps can
  // visit millions of candidate cells while containing only dozens of states.
  const collision = world.palette.map((state) => collisionBoxes(state));
  const passable = (x: number, y: number, z: number) => {
    const entry = collision[world.getId(x, y, z)]!;
    return entry.kind === 'supported' && entry.boxes.length === 0;
  };
  const supportTop = (x: number, y: number, z: number) => {
    const entry = collision[world.getId(x, y, z)]!;
    return entry.kind === 'supported' ? entry.boxes.reduce((top, box) => Math.max(top, box[4]), 0) : 0;
  };
  const standable = (x: number, y: number, z: number) =>
    supportTop(x, y - 1, z) >= 0.5 && passable(x, y, z) && passable(x, y + 1, z);
  const valid = starts.filter((p) => standable(...p));
  const seen = new Set(valid.map((p) => key(...p)));
  const queue: Vec3[] = [...valid];
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i]!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (const dy of [-1, 0, 1]) {
        if (dy > PLAYER.maxStepUp || dy < -PLAYER.maxStepDown) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const k = key(nx, ny, nz);
        if (seen.has(k) || !standable(nx, ny, nz)) continue;
        if (dy === 1 && !passable(x, y + 2, z)) continue;
        seen.add(k);
        queue.push([nx, ny, nz]);
      }
    }
  }
  return seen;
}

/** 可达格是否落入某个目标盒子（半开区间）。 */
export function reachableIn(cells: Set<string>, box: Box): boolean {
  return [...cells].some((k) => {
    const [x, y, z] = k.split(',').map(Number) as Vec3;
    return contains(box, x, y, z);
  });
}

/** 每盏灯笼必须有实体支撑（悬挂灯笼看上方，落地灯笼看下方）。 */
export function lanternSupportErrors(world: Structure, bounds?: Box, label = 'lantern'): string[] {
  const issues: string[] = [];
  world.forEach((x, y, z, id) => {
    const state = world.palette[id]!;
    if (state.name !== 'minecraft:lantern') return;
    if (bounds && !contains(bounds, x, y, z)) return;
    const hanging = state.states.hanging === true;
    if (!world.get(x, y + (hanging ? 1 : -1), z)) issues.push(`${label}：灯笼 ${x},${y},${z} 没有支撑`);
  });
  return issues;
}

export type StandardIssueOptions = Readonly<{ minOccupied?: number; maxIssues?: number; label?: string }>;

/**
 * 标准模型诊断，返回统一诊断对象。
 *
 * 覆盖：方块落在声明边界内、可见几何已确认（无洋红占位）、每盏灯笼有支撑，
 * 以及可选的体量下限。占用为 0 时单独报 unknown——"没有方块"不等于"检查通过"。
 */
export function modelIssues(world: Structure, bounds: Box, options: StandardIssueOptions = {}): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const max = options.maxIssues ?? 20;
  const label = options.label ?? 'model';
  const object = { kind: 'model', id: label };
  let occupied = 0;
  world.forEach((x, y, z, id) => {
    if (issues.length >= max) return;
    occupied++;
    if (!contains(bounds, x, y, z)) {
      issues.push(fromMessage(`方块越界 ${x},${y},${z}`, 'model.out-of-bounds', object, bounds));
      return;
    }
    const state = world.palette[id]!;
    if (materials[state.name.replace('minecraft:', '')]!.geometry === 'placeholder') {
      const message = `${state.name} 没有确认的视觉几何`;
      if (!issues.some((issue) => issue.message.includes(message)))
        issues.push(fromMessage(message, 'model.placeholder-geometry', { kind: 'geometry', id: state.name }));
    }
    if (state.name === 'minecraft:lantern') {
      const hanging = state.states.hanging === true;
      if (!world.get(x, y + (hanging ? 1 : -1), z))
        issues.push(fromMessage(`灯笼 ${x},${y},${z} 没有支撑`, 'model.floating-lantern', object));
    }
  });
  if (options.minOccupied !== undefined && occupied < options.minOccupied && issues.length < max)
    issues.push(fromMessage(`体量过小（${occupied} 格）`, 'model.under-volume', object));
  if (occupied === 0)
    issues.push({
      rule: 'model.empty',
      severity: 'unknown',
      object,
      target: { kind: 'region', region: bounds },
      message: '模型没有任何方块，诊断无法判断生成是否成功',
      conclusive: false,
      source: 'standard-issues',
    });
  return issues;
}

/**
 * 兼容入口：把标准诊断渲染成原有的人读字符串。
 * 新代码请直接用 `modelIssues()`——它带规则编号、严重度与坐标。
 * `label` 作为每条消息的前缀（如建筑名）。
 */
export function standardIssues(world: Structure, bounds: Box, options: StandardIssueOptions = {}): string[] {
  const label = options.label ? `${options.label}：` : '';
  return modelIssues(world, bounds, options).map((diagnostic) => `${label}${diagnostic.message}`);
}
