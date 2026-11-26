import type { Box, State, Vec3 } from '../core/structure.js';
import { diagnosticObject, type Diagnostic, type DiagnosticObject } from './diagnostics.js';

/**
 * 水平变换：90° 旋转与镜像。
 *
 * 关键约束：**方向状态必须同步变换**。只搬坐标不改状态会得到朝向错误的结构，
 * 而错误的朝向不会自己报错——所以本模块把"状态键级"的重映射放在一起，
 * 对无法正确变换的状态（未知键、非默认状态）返回显式诊断，由放置层拒绝，
 * 而不是静默按原样保留。
 *
 * 坐标约定与核心 IR 一致：X 东、Y 上、Z 南，方块坐标是整数格，
 * 半开区间 `Box` 变换后仍按"格"而不是"角"计算。
 */

/** Direction indices follow the repository convention: 0=+X 1=-X 2=+Z 3=-Z. */
export type FacingIndex = 0 | 1 | 2 | 3;

/** Clockwise quarter turns when viewed from above (+Y looking down). */
export type Rotation = 0 | 90 | 180 | 270;
export type Mirror = 'none' | 'x' | 'z';

export type BlockTransform = Readonly<{
  rotation: Rotation;
  mirror: Mirror;
}>;

export const IDENTITY_TRANSFORM: BlockTransform = Object.freeze({ rotation: 0, mirror: 'none' });

function rotationTurns(rotation: Rotation): number {
  return ((rotation / 90) % 4 + 4) % 4;
}

export function transform(rotation: Rotation = 0, mirror: Mirror = 'none'): BlockTransform {
  if (![0, 90, 180, 270].includes(rotation)) throw new Error(`Rotation must be 0/90/180/270, got ${rotation}`);
  return Object.freeze({ rotation, mirror });
}

/** Apply a 90° clockwise turn about the origin: (x,z) -> (-z, x). */
/** A 90° clockwise turn about the origin, matching `Direction` 0=+X 1=-X 2=+Z 3=-Z. */
function rotatePoint(point: readonly [number, number], turns: number): [number, number] {
  let [x, z] = point;
  for (let turn = 0; turn < turns; turn++) [x, z] = [-z, x];
  return [x, z];
}

/**
 * `mirror: 'x'` names the **mirror plane's normal**: reflecting across the X axis
 * (equivalently, through the YZ plane) negates X and keeps Z. `mirror: 'z'`
 * negates Z and keeps X. Naming the reversed axis keeps a mirrored lot from
 * silently becoming the other reflection.
 */
function mirrorPoint(point: readonly [number, number], mirror: Mirror): [number, number] {
  const [x, z] = point;
  return mirror === 'x' ? [-x, z] : mirror === 'z' ? [x, -z] : [x, z];
}

/** Local offset -> rotated/mirrored offset (no translation applied). */
export function transformOffset(offset: Vec3, spec: BlockTransform): Vec3 {
  const [x, z] = mirrorPoint(rotatePoint([offset[0], offset[2]], rotationTurns(spec.rotation)), spec.mirror);
  return [x, offset[1], z];
}

/**
 * Local offset -> world position relative to `anchor`, where the anchor is the
 * world position of local `(0,0,0)`. Rotation/mirror happen about the anchor.
 */
export function transformPosition(
  position: Vec3,
  spec: BlockTransform,
  anchor: Vec3 = [0, 0, 0],
  offset: Vec3 = [0, 0, 0],
): Vec3 {
  const local: Vec3 = [position[0] - anchor[0], position[1] - anchor[1], position[2] - anchor[2]];
  const moved = transformOffset(local, spec);
  return [moved[0] + anchor[0] + offset[0], moved[1] + anchor[1] + offset[1], moved[2] + anchor[2] + offset[2]];
}

/**
 * Transform a half-open box. The box is converted to its inclusive corner
 * cloud, transformed, and re-closed — so a rotated box still covers exactly the
 * transformed cells (never one cell short).
 */
export function transformBox(box: Box, spec: BlockTransform, anchor: Vec3 = [0, 0, 0], offset: Vec3 = [0, 0, 0]): Box {
  const corners: Vec3[] = [];
  for (const x of [box.min[0], box.max[0] - 1])
    for (const y of [box.min[1], box.max[1] - 1])
      for (const z of [box.min[2], box.max[2] - 1]) corners.push(transformPosition([x, y, z], spec, anchor, offset));
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const corner of corners)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], corner[axis]);
      max[axis] = Math.max(max[axis], corner[axis] + 1);
    }
  return { min, max };
}

/**
 * The transform that undoes `spec`.
 *
 * `transform` composes as "rotate, then mirror", so the inverse has to compose
 * the other way round. Conjugating the mirror by the rotation keeps the same
 * canonical form — and because a quarter turn moves the mirror plane onto the
 * other axis, `mirror: 'x'` becomes `mirror: 'z'` (and back) exactly when the
 * turn count is odd. Reusing the original mirror here is the bug that made
 * `worldToLocal(localToWorld(p))` return `(-x, -z)` for a mirrored quarter turn.
 */
export function inverseTransform(spec: BlockTransform): BlockTransform {
  const turns = rotationTurns(spec.rotation);
  const mirror: Mirror =
    spec.mirror === 'none' || turns % 2 === 0 ? spec.mirror : spec.mirror === 'x' ? 'z' : 'x';
  return transform(((360 - spec.rotation) % 360) as Rotation, mirror);
}

/**
 * Inverse of `transformPosition`: world position -> local position, with the
 * same anchor and additive offset. Round-trips exactly for every rotation,
 * mirror, negative coordinate and non-zero anchor.
 */
export function inverseTransformPosition(
  position: Vec3,
  spec: BlockTransform,
  anchor: Vec3 = [0, 0, 0],
  offset: Vec3 = [0, 0, 0],
): Vec3 {
  const local: Vec3 = [
    position[0] - anchor[0] - offset[0],
    position[1] - anchor[1] - offset[1],
    position[2] - anchor[2] - offset[2],
  ];
  const moved = transformOffset(local, inverseTransform(spec));
  return [moved[0] + anchor[0], moved[1] + anchor[1], moved[2] + anchor[2]];
}

/** Direction index -> unit horizontal offset, matching the repo convention. */
export function directionVector(direction: number): [number, number] | null {
  switch (direction) {
    case 0:
      return [1, 0];
    case 1:
      return [-1, 0];
    case 2:
      return [0, 1];
    case 3:
      return [0, -1];
    default:
      return null;
  }
}

function vectorDirection(vector: readonly [number, number]): FacingIndex | null {
  if (vector[0] === 1 && vector[1] === 0) return 0;
  if (vector[0] === -1 && vector[1] === 0) return 1;
  if (vector[0] === 0 && vector[1] === 1) return 2;
  if (vector[0] === 0 && vector[1] === -1) return 3;
  return null;
}

/** Remap a horizontal direction index through the transform. */
export function transformDirection(direction: number, spec: BlockTransform): number | null {
  const vector = directionVector(direction);
  if (!vector) return null;
  const [x, z] = mirrorPoint(rotatePoint(vector, rotationTurns(spec.rotation)), spec.mirror);
  return vectorDirection([x, z]);
}

/** Remap an axis. Vertical axes are invariant; X and Z swap exactly when the transform is handed. */
export function transformAxis(axis: string, spec: BlockTransform): string | null {
  // Odd turn (90/270) swaps X and Z; a single mirror also swaps them, so the
  // two effects cancel when both are present (a mirrored 90° turn).
  const swapped = (rotationTurns(spec.rotation) % 2 === 1) !== (spec.mirror !== 'none');
  if (axis === 'y' || axis === 'Y') return axis;
  const lower = axis.toLowerCase();
  if (lower !== 'x' && lower !== 'z') return null;
  const mapped = swapped ? (lower === 'x' ? 'z' : 'x') : lower;
  return axis === axis.toUpperCase() ? mapped.toUpperCase() : mapped;
}

export type DirectionalStateResult = Readonly<{
  /** State with every supported directional key remapped. */
  states: Readonly<Record<string, string | number | boolean>>;
  /** Keys that look directional but could not be transformed. */
  untransformed: readonly string[];
  /** True when at least one directional key was remapped. */
  remapped: boolean;
}>;

/**
 * Keys whose values carry orientation. Anything here is remapped or reported;
 * a key in this list that we cannot map becomes `untransformed` and blocks the
 * placement instead of silently keeping the old facing.
 */
const DIRECTION_KEYS = new Map<string, (value: string | number | boolean, spec: BlockTransform) => string | number | boolean | null>([
  ['weirdo_direction', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  [
    'facing_direction',
    (value, spec) => {
      if (typeof value !== 'number') return null;
      // Bedrock `facing_direction`: 0=down 1=up, horizontals 2..5 as ±Z/±X.
      if (value === 0 || value === 1) return value;
      const vector = value === 2 ? ([0, -1] as const) : value === 3 ? ([0, 1] as const) : value === 4 ? ([-1, 0] as const) : value === 5 ? ([1, 0] as const) : null;
      if (!vector) return null;
      const [x, z] = mirrorPoint(rotatePoint(vector, rotationTurns(spec.rotation)), spec.mirror);
      if (x === 0 && z === -1) return 2;
      if (x === 0 && z === 1) return 3;
      if (x === -1 && z === 0) return 4;
      if (x === 1 && z === 0) return 5;
      return null;
    },
  ],
  [
    'minecraft:cardinal_direction',
    (value, spec) => {
      if (typeof value !== 'string') return null;
      const index = { north: 3, east: 0, south: 2, west: 1 }[value];
      if (index === undefined) return null;
      const mapped = transformDirection(index, spec);
      return mapped === null ? null : ['east', 'west', 'south', 'north'][mapped];
    },
  ],
  ['direction', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  ['orientation', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  ['torch_facing_direction', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  ['lever_direction', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  ['coral_direction', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  ['coral_fan_direction', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  ['pillar_axis', (value, spec) => (typeof value === 'string' ? transformAxis(value, spec) : null)],
  ['portal_axis', (value, spec) => (typeof value === 'string' ? transformAxis(value, spec) : null)],
  ['rail_direction', (value, spec) => (typeof value === 'number' ? transformDirection(value, spec) : null)],
  [
    'ground_sign_direction',
    (value, spec) => {
      if (typeof value !== 'number' || value < 0 || value > 15) return null;
      // 16 steps, 22.5° each, increasing clockwise from south.
      const steps = rotationTurns(spec.rotation) * 4;
      const mirrored = spec.mirror === 'none' ? value : spec.mirror === 'x' ? (16 - value) % 16 : (8 - value + 16) % 16;
      return (mirrored + steps) % 16;
    },
  ],
  ['rotation', (value, spec) => (typeof value === 'number' ? (value + rotationTurns(spec.rotation) * 90) % 360 : null)],
]);

export function transformState(state: State, spec: BlockTransform): DirectionalStateResult {
  if (spec.rotation === 0 && spec.mirror === 'none')
    return { states: { ...state.states }, untransformed: [], remapped: false };
  const states: Record<string, string | number | boolean> = { ...state.states };
  const untransformed: string[] = [];
  let remapped = false;
  for (const [key, value] of Object.entries(state.states)) {
    const mapper = DIRECTION_KEYS.get(key);
    if (!mapper) continue;
    const mapped = mapper(value, spec);
    if (mapped === null) {
      untransformed.push(key);
      continue;
    }
    if (mapped !== value) remapped = true;
    states[key] = mapped;
  }
  return { states, untransformed, remapped };
}

/** True when the transform is the identity (no coordinate or state change). */
export function isIdentity(spec: BlockTransform): boolean {
  return spec.rotation === 0 && spec.mirror === 'none';
}

/** Describe a transform for messages and reports. */
export function describeTransform(spec: BlockTransform): string {
  const mirror = spec.mirror === 'none' ? '' : ` mirror:${spec.mirror}`;
  return `rotate:${spec.rotation}${mirror}`;
}

/**
 * Diagnose states that cannot be transformed correctly. Placement calls this
 * before committing; a nonempty result means the candidate must be rejected.
 */
export function untransformableDiagnostics(
  states: readonly UntransformableState[],
  options: Readonly<{ object?: DiagnosticObject | string; rule?: string }> = {},
): Diagnostic[] {
  const grouped = new Map<string, { name: string; keys: string[]; count: number }>();
  for (const entry of states) {
    const key = `${entry.name}|${[...entry.keys].sort().join(',')}`;
    const old = grouped.get(key);
    if (old) old.count++;
    else grouped.set(key, { name: entry.name, keys: [...entry.keys], count: 1 });
  }
  return [...grouped.values()].map((entry) => ({
    rule: options.rule ?? 'transform.untransformed-state',
    severity: 'error',
    object: diagnosticObject(options.object ?? { kind: 'geometry', id: entry.name }),
    target: { kind: 'region', region: { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 } },
    message: `${entry.name} 的 ${entry.keys.join(', ')} 无法随旋转变换（${entry.count} 格），拒绝放置以免朝向静默出错`,
    data: { block: entry.name, keys: entry.keys, count: entry.count },
    source: 'transform',
  }));
}

export type UntransformableState = Readonly<{ name: string; keys: readonly string[] }>;
