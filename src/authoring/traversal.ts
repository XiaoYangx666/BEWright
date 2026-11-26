import { registryBlock } from '../blocks/registry.js';
import { contains, type Box, type State, type Vec3, Structure } from '../core/structure.js';

export type Aabb = [number, number, number, number, number, number];
export type TraversalStatus = 'reachable' | 'unreachable' | 'unknown';
export type TraversalZone = Readonly<{ box: Box; footY: number }>;
export type TraversalTarget = TraversalZone & Readonly<{ id: string }>;
export type PlayerModel = Readonly<{ width: number; height: number; maxStepUp: number; maxStepDown: number }>;
export type CollisionSupport =
  Readonly<{ kind: 'supported'; boxes: readonly Aabb[] }> | Readonly<{ kind: 'unknown'; reason: string }>;
export type TraversalRoute = Readonly<{
  id: string;
  status: TraversalStatus;
  reason: string;
  samples?: number;
  minimumHeadroom?: number;
  path?: readonly Vec3[];
}>;
export type TraversalReport = Readonly<{
  player: PlayerModel;
  supportedCollision: readonly string[];
  unknownCollision: readonly { name: string; count: number; samples: readonly Vec3[] }[];
  routes: readonly TraversalRoute[];
}>;

const DEFAULT_PLAYER: PlayerModel = { width: 0.6, height: 1.8, maxStepUp: 1, maxStepDown: 1 };
/** Up to this rise the player walks; above it (and up to maxStepUp) they jump and need clearance. */
const WALK_STEP = 0.6;

/**
 * Collision models admitted by the traversal checker. Anything outside this
 * small, explicit set is unknown rather than silently treated as a cube.
 */
export function collisionBoxes(state: State | null): CollisionSupport {
  if (!state || state.name === 'minecraft:air') return { kind: 'supported', boxes: [] };
  const name = state.name.replace(/^minecraft:/, '');
  if (name.endsWith('_stairs')) {
    const direction = Number(state.states.weirdo_direction);
    const upsideDown = state.states.upside_down_bit === true;
    if (![0, 1, 2, 3].includes(direction) || typeof state.states.upside_down_bit !== 'boolean') {
      return { kind: 'unknown', reason: 'unsupported stair state' };
    }
    const low: Aabb = [0, upsideDown ? 0.5 : 0, 0, 1, upsideDown ? 1 : 0.5, 1];
    const y0 = upsideDown ? 0 : 0.5,
      y1 = upsideDown ? 0.5 : 1;
    const high: Aabb =
      direction === 0
        ? [0.5, y0, 0, 1, y1, 1]
        : direction === 1
          ? [0, y0, 0, 0.5, y1, 1]
          : direction === 2
            ? [0, y0, 0.5, 1, y1, 1]
            : [0, y0, 0, 1, y1, 0.5];
    return { kind: 'supported', boxes: [low, high] };
  }
  if (name.endsWith('_slab')) {
    const half = state.states['minecraft:vertical_half'];
    if (half !== 'top' && half !== 'bottom') return { kind: 'unknown', reason: 'unsupported slab state' };
    return { kind: 'supported', boxes: [half === 'top' ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1]] };
  }
  if (name.endsWith('_fence')) return { kind: 'supported', boxes: [[0, 0, 0, 1, 1.5, 1]] };
  if (name.endsWith('_wall')) {
    const boxes: Aabb[] = [];
    if (state.states.wall_post_bit === true) boxes.push([0.25, 0, 0.25, 0.75, 1.5, 0.75]);
    for (const [direction, dx, dz] of [
      ['east', 1, 0],
      ['west', -1, 0],
      ['south', 0, 1],
      ['north', 0, -1],
    ] as const) {
      const value = state.states[`wall_connection_type_${direction}`];
      if (value !== 'short' && value !== 'tall') continue;
      boxes.push(
        dx
          ? [dx < 0 ? 0 : 0.5, 0, 0.3125, dx < 0 ? 0.5 : 1, 1.5, 0.6875]
          : [0.3125, 0, dz < 0 ? 0 : 0.5, 0.6875, 1.5, dz < 0 ? 0.5 : 1],
      );
    }
    return { kind: 'supported', boxes: boxes.length ? boxes : [[0.25, 0, 0.25, 0.75, 1.5, 0.75]] };
  }
  if (name === 'lantern') {
    return state.states.hanging === true
      ? { kind: 'supported', boxes: [[0.3125, 0.75, 0.3125, 0.6875, 1, 0.6875]] }
      : { kind: 'supported', boxes: [[0.3125, 0, 0.3125, 0.6875, 0.5625, 0.6875]] };
  }
  if (name === 'chain') return { kind: 'supported', boxes: [] };
  if (name === 'flower_pot') return { kind: 'supported', boxes: [[0.3125, 0, 0.3125, 0.6875, 0.375, 0.6875]] };
  if (name === 'waterlily') return { kind: 'supported', boxes: [[0, 0, 0, 1, 0.0625, 1]] };
  if (name === 'quartz_block' || name === 'chiseled_quartz_block')
    return { kind: 'supported', boxes: [[0, 0, 0, 1, 1, 1]] };
  if (name === 'bed') return { kind: 'supported', boxes: [[0, 0, 0, 1, 0.5625, 1]] };
  if (name === 'water' || name === 'fern' || name === 'short_grass') return { kind: 'supported', boxes: [] };
  if (name.endsWith('_leaves')) return { kind: 'supported', boxes: [[0, 0, 0, 1, 1, 1]] };
  // A block outside the pinned registry has no confirmed collision either:
  // report `unknown` so callers never treat it as a plain cube, and never let a
  // registry lookup throw out of a geometry query.
  let info: ReturnType<typeof registryBlock>;
  try {
    info = registryBlock(name);
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  if (info.uniformFullCollision && info.boundingBox === 'block')
    return { kind: 'supported', boxes: [[0, 0, 0, 1, 1, 1]] };
  if (info.boundingBox === 'empty') return { kind: 'supported', boxes: [] };
  return { kind: 'unknown', reason: `collision shape not supported for ${state.name}` };
}

type Node = { qx: number; qz: number; hy: number };
const nodeKey = (n: Node) => `${n.qx},${n.qz},${n.hy}`;
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 - 1e-6 && a1 > b0 + 1e-6;

export function checkTraversal(
  world: Structure,
  request: Readonly<{
    bounds: Box;
    start: TraversalZone;
    targets: readonly TraversalTarget[];
    player?: Partial<PlayerModel>;
  }>,
): TraversalReport {
  const player: PlayerModel = { ...DEFAULT_PLAYER, ...request.player };
  const local = new Map<number, CollisionSupport>();
  const supportFor = (id: number) => {
    let support = local.get(id);
    if (!support) {
      support = collisionBoxes(world.palette[id] ?? null);
      local.set(id, support);
    }
    return support;
  };
  const unknownCells: { p: Vec3; name: string }[] = [];
  const unknownSummary = new Map<string, { name: string; count: number; samples: Vec3[] }>();
  world.forEach((x, y, z, id) => {
    const support = supportFor(id);
    if (support.kind !== 'unknown') return;
    const p: Vec3 = [x, y, z];
    unknownCells.push({ p, name: world.palette[id]!.name });
    const old = unknownSummary.get(world.palette[id]!.name) ?? { name: world.palette[id]!.name, count: 0, samples: [] };
    old.count++;
    if (old.samples.length < 16) old.samples.push(p);
    unknownSummary.set(old.name, old);
  }, request.bounds);

  const collisionCache = new Map<string, Aabb[]>();
  const collisionAt = (x: number, y: number, z: number): Aabb[] => {
    const key = `${x},${y},${z}`;
    const old = collisionCache.get(key);
    if (old) return old;
    const support = supportFor(world.getId(x, y, z));
    const boxes =
      support.kind === 'supported'
        ? support.boxes.map((b) => [b[0] + x, b[1] + y, b[2] + z, b[3] + x, b[4] + y, b[5] + z] as Aabb)
        : [];
    collisionCache.set(key, boxes);
    return boxes;
  };
  const bodyState = (px: number, foot: number, pz: number): 'clear' | 'blocked' | 'unknown' => {
    const half = player.width / 2,
      top = foot + player.height;
    for (let x = Math.floor(px - half); x <= Math.floor(px + half); x++)
      for (let y = Math.floor(foot); y <= Math.floor(top); y++)
        for (let z = Math.floor(pz - half); z <= Math.floor(pz + half); z++) {
          const support = supportFor(world.getId(x, y, z));
          if (
            support.kind === 'unknown' &&
            overlaps(px - half, px + half, x, x + 1) &&
            overlaps(foot + 1e-5, top, y, y + 1) &&
            overlaps(pz - half, pz + half, z, z + 1)
          )
            return 'unknown';
          for (const b of collisionAt(x, y, z)) {
            if (b[4] <= foot + 0.50001) continue;
            if (
              overlaps(px - half, px + half, b[0], b[3]) &&
              overlaps(foot + 1e-5, top, b[1], b[4]) &&
              overlaps(pz - half, pz + half, b[2], b[5])
            )
              return 'blocked';
          }
        }
    return 'clear';
  };
  const headroom = (px: number, foot: number, pz: number) => {
    const half = player.width / 2;
    let ceiling = request.bounds.max[1];
    for (let x = Math.floor(px - half); x <= Math.floor(px + half); x++)
      for (let y = Math.floor(foot); y < request.bounds.max[1]; y++)
        for (let z = Math.floor(pz - half); z <= Math.floor(pz + half); z++)
          for (const b of collisionAt(x, y, z))
            if (
              b[4] > foot + 0.50001 &&
              b[1] > foot + 1e-5 &&
              overlaps(px - half, px + half, b[0], b[3]) &&
              overlaps(pz - half, pz + half, b[2], b[5])
            )
              ceiling = Math.min(ceiling, b[1]);
    return ceiling - foot;
  };

  const raw = new Map<string, Node>();
  world.forEach((x, y, z, id) => {
    const support = supportFor(id);
    if (support.kind !== 'supported') return;
    for (const b of support.boxes)
      for (const ox of [0.25, 0.75])
        for (const oz of [0.25, 0.75]) {
          if (ox < b[0] - 1e-6 || ox > b[3] + 1e-6 || oz < b[2] - 1e-6 || oz > b[5] + 1e-6) continue;
          const n = { qx: 4 * x + Math.round(ox * 4), qz: 4 * z + Math.round(oz * 4), hy: Math.round((y + b[4]) * 2) };
          if (contains(request.bounds, n.qx / 4, n.hy / 2, n.qz / 4)) raw.set(nodeKey(n), n);
        }
  }, request.bounds);
  const nodes = new Map<string, Node>(),
    columns = new Map<string, Node[]>();
  for (const [key, n] of raw) {
    if (bodyState(n.qx / 4, n.hy / 2, n.qz / 4) !== 'clear') continue;
    nodes.set(key, n);
    const column = `${n.qx},${n.qz}`,
      list = columns.get(column) ?? [];
    list.push(n);
    columns.set(column, list);
  }
  for (const list of columns.values()) list.sort((a, b) => a.hy - b.hy);
  const inZone = (n: Node, zone: TraversalZone) =>
    n.hy === zone.footY * 2 && contains(zone.box, n.qx / 4, n.hy / 2, n.qz / 4);
  const starts = [...nodes.values()].filter((n) => inZone(n, request.start));
  const queue = [...starts],
    visited = new Set(starts.map(nodeKey)),
    parent = new Map<string, string>();
  let cursor = 0;
  while (cursor < queue.length) {
    const n = queue[cursor++];
    // Walking connects quarter-cells 0.5 apart; a 1-block jump also needs the
    // 1.0-block horizontal step because the player cannot stand flush against
    // the block being jumped onto.
    for (const step of [2, 4] as const)
      for (const [dqx, dqz] of [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
      ] as const)
        for (const next of columns.get(`${n.qx + dqx},${n.qz + dqz}`) ?? []) {
          const dy = (next.hy - n.hy) / 2;
          if (dy > player.maxStepUp || dy < -player.maxStepDown) continue;
          if (step === 4 && dy <= WALK_STEP) continue;
          // A rise above walking height is a jump: the player needs two blocks of
          // clearance at the take-off cell to actually get up there.
          if (dy > WALK_STEP && headroom(n.qx / 4, n.hy / 2, n.qz / 4) < 1.99) continue;
          const key = nodeKey(next);
          if (visited.has(key)) continue;
          visited.add(key);
          parent.set(key, nodeKey(n));
          queue.push(next);
        }
  }
  // Unknown is relevant only when a real next graph step from the supported
  // reachable component would sweep the player's body through that cell.
  // This keeps unrelated unknown decoration from poisoning a proven route.
  const unknownTouchesReachable = unknownCells.some(({ p }) =>
    [...visited].some((key) => {
      const n = nodes.get(key)!,
        px = n.qx / 4,
        pz = n.qz / 4,
        foot = n.hy / 2,
        half = player.width / 2;
      if (!overlaps(foot, foot + player.height, p[1], p[1] + 1)) return false;
      return (
        [
          [0.5, 0],
          [-0.5, 0],
          [0, 0.5],
          [0, -0.5],
        ] as const
      ).some(
        ([dx, dz]) =>
          overlaps(Math.min(px, px + dx) - half, Math.max(px, px + dx) + half, p[0], p[0] + 1) &&
          overlaps(Math.min(pz, pz + dz) - half, Math.max(pz, pz + dz) + half, p[2], p[2] + 1),
      );
    }),
  );
  const routes = request.targets.map((target) => {
    const end = [...nodes.values()].find((n) => visited.has(nodeKey(n)) && inZone(n, target));
    if (end) {
      const path: Node[] = [];
      let key: string | undefined = nodeKey(end);
      while (key) {
        const n = nodes.get(key);
        if (!n) break;
        path.push(n);
        key = parent.get(key);
      }
      path.reverse();
      const minimumHeadroom = Math.min(...path.map((n) => headroom(n.qx / 4, n.hy / 2, n.qz / 4)));
      return {
        id: target.id,
        status: 'reachable',
        reason: 'supported collision path found',
        samples: path.length,
        minimumHeadroom,
        path: path.map((n) => [n.qx / 4, n.hy / 2, n.qz / 4] as Vec3),
      } satisfies TraversalRoute;
    }
    const unknownAtEndpoint =
      unknownCells.some(({ p }) => contains(target.box, p[0] + 0.5, target.footY, p[2] + 0.5)) ||
      (!starts.length &&
        unknownCells.some(({ p }) => contains(request.start.box, p[0] + 0.5, request.start.footY, p[2] + 0.5)));
    const status: TraversalStatus = unknownAtEndpoint || unknownTouchesReachable ? 'unknown' : 'unreachable';
    return {
      id: target.id,
      status,
      reason:
        status === 'unknown'
          ? 'unsupported collision may change connectivity'
          : 'no path in fully supported relevant search space',
    } satisfies TraversalRoute;
  });
  return {
    player,
    supportedCollision: [
      'air/empty',
      'uniform full cube',
      'straight stairs',
      'slab',
      'fence',
      'wall',
      'bed',
      'water',
      'any leaves',
      'lantern',
      'chain',
      'flower_pot',
      'fern/short_grass',
    ],
    unknownCollision: [...unknownSummary.values()],
    routes,
  };
}
