import type { Vec3 } from '../core/structure.js';
import { StructureKit, type BlockKit, type AuthoringMaterial } from './kit.js';
import { assertPoint, coordinateRandom, unitInterval, voxelPath } from './layout.js';

export type BranchSpec = Readonly<{
  path: readonly Vec3[];
  material: AuthoringMaterial;
  /** Radius in blocks along this branch; 0 gives a one-block branch. */
  radius?: number | ((t: number) => number);
}>;
export type LeafClusterSpec = Readonly<{
  center: Vec3;
  radii: Vec3;
  material: AuthoringMaterial;
  shape?: 'ellipsoid' | 'disc' | 'cone';
  density?: number;
  seed?: number;
  /** Normalized local coordinates; replace only the crown's silhouette. */
  contains?: (x: number, y: number, z: number) => boolean;
  /** Exact integer sample predicate for legacy or hand-authored foliage. */
  sample?: (x: number, y: number, z: number) => boolean;
  /** Override leaf state keys for legacy materials with a narrower state set. */
  leafStates?: Readonly<Record<string, string | number | boolean>>;
  /** Explicit compatibility mode for legacy crowns that overwrote trunk wood. */
  allowWoodOverlap?: boolean;
}>;
export function branch(kit: BlockKit, spec: BranchSpec) {
  if (!spec.path.length) throw new Error('Branch requires a path');
  const points = voxelPath(spec.path);
  const radii = points.map((_, i) =>
    typeof spec.radius === 'function' ? spec.radius(i / Math.max(1, points.length - 1)) : (spec.radius ?? 0),
  );
  if (radii.some((r) => !Number.isFinite(r) || r < 0)) throw new Error('Branch radius must be finite and nonnegative');
  points.forEach(([x, y, z], i) => {
    const r = radii[i],
      extent = Math.ceil(r),
      next = points[i + 1] ?? points[i - 1];
    const axis = next ? (next[0] !== x ? 'x' : next[2] !== z ? 'z' : 'y') : 'y';
    for (let dx = -extent; dx <= extent; dx++)
      for (let dz = -extent; dz <= extent; dz++)
        for (let dy = -extent; dy <= extent; dy++)
          if (dx * dx + dy * dy + dz * dz <= r * r) kit.log(x + dx, y + dy, z + dz, spec.material, axis);
  });
  return points;
}
/** Only fills empty cells, preserving branch wood and earlier crown clusters. */
export function leafCluster(kit: BlockKit, spec: LeafClusterSpec) {
  assertPoint(spec.center);
  if (!spec.radii.every((r) => Number.isFinite(r) && r > 0)) throw new Error('Leaf radii must be positive');
  const density = spec.density ?? 1,
    seed = spec.seed ?? 0;
  unitInterval(density, 'leaf density');
  if (!Number.isSafeInteger(seed)) throw new Error('Leaf seed must be an integer');
  const [rx, ry, rz] = spec.radii,
    [cx, cy, cz] = spec.center;
  let count = 0;
  // Integer samples never need a coordinate whose absolute value exceeds the
  // radius; floor bounds also make a 0.1-radius point a single voxel rather
  // than an asymmetric (-1, 0) pair.
  for (let dx = -Math.floor(rx); dx <= Math.floor(rx); dx++)
    for (let dz = -Math.floor(rz); dz <= Math.floor(rz); dz++)
      for (let dy = -Math.floor(ry); dy <= Math.floor(ry); dy++) {
        const u = dx / rx,
          v = dy / ry,
          w = dz / rz;
        const inside = spec.sample
          ? spec.sample(dx, dy, dz)
          : spec.contains
            ? spec.contains(u, v, w)
            : spec.shape === 'disc'
              ? u * u + w * w <= 1 && Math.abs(v) <= 1
              : spec.shape === 'cone'
                ? Math.abs(v) <= 1 && u * u + w * w <= ((1 - v) / 2) ** 2
                : u * u + v * v + w * w <= 1;
        const existing = kit.get(cx + dx, cy + dy, cz + dz);
        const woodOverlap = spec.allowWoodOverlap === true && !!existing && /_(log|wood)$/.test(existing.name);
        if (
          !inside ||
          coordinateRandom(dx, dy, dz, seed) >= density ||
          (!kit.empty(cx + dx, cy + dy, cz + dz) && !woodOverlap)
        )
          continue;
        kit.put(
          cx + dx,
          cy + dy,
          cz + dz,
          spec.material,
          spec.leafStates ?? { persistent_bit: true, update_bit: false },
        );
        count++;
      }
  return count;
}
export type TreeSpec = Readonly<{
  /** Local coordinates shared by branches and crowns. */
  branches: readonly BranchSpec[];
  crowns: readonly LeafClusterSpec[];
  origin?: Vec3;
  collision?: 'skip' | 'error' | 'replace';
}>;
/** Build independently, then merge with an explicit collision policy. Error mode is atomic. */
export function tree(kit: BlockKit, spec: TreeSpec) {
  const local = new StructureKit(),
    origin = spec.origin ?? [0, 0, 0];
  assertPoint(origin);
  const branchCells = new Set<string>();
  for (const b of spec.branches) for (const [x, y, z] of branch(local, b)) branchCells.add(`${x},${y},${z}`);
  for (const crown of spec.crowns) leafCluster(local, crown);
  const conflicts: Vec3[] = [];
  local.s.forEach((x, y, z) => {
    const p: Vec3 = [x + origin[0], y + origin[1], z + origin[2]];
    if (!kit.empty(...p)) conflicts.push(p);
  });
  if (spec.collision === 'error' && conflicts.length)
    throw new Error(`Tree intersects ${conflicts.length} occupied cells; first: ${conflicts[0]}`);
  // Diagnostics: crown cells that cannot reach any branch cell through
  // face-connected crown cells would render as floating foliage.
  const crownCells = new Set<string>();
  local.s.forEach((x, y, z) => {
    const key = `${x},${y},${z}`;
    if (!branchCells.has(key)) crownCells.add(key);
  });
  const reached = new Set<string>(),
    queue: Vec3[] = [];
  for (const key of branchCells) {
    const [x, y, z] = key.split(',').map(Number) as Vec3;
    if (local.s.get(x, y, z)) queue.push([x, y, z]);
  }
  const faceNeighbours: readonly [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  while (queue.length) {
    const [x, y, z] = queue.pop()!;
    for (const [dx, dy, dz] of faceNeighbours) {
      const key = `${x + dx},${y + dy},${z + dz}`;
      if (crownCells.has(key) && !reached.has(key)) {
        reached.add(key);
        queue.push([x + dx, y + dy, z + dz]);
      }
    }
  }
  const floating: Vec3[] = [...crownCells]
    .filter((key) => !reached.has(key))
    .map((key) => key.split(',').map(Number) as Vec3)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  local.s.forEach((x, y, z, id) => {
    const p: Vec3 = [x + origin[0], y + origin[1], z + origin[2]];
    if (spec.collision === 'replace' || kit.empty(...p)) kit.put(...p, local.s.palette[id]!);
  });
  return { structure: local.s, conflicts, floating };
}

export type TreePresetKind = 'pine' | 'broadleaf';
export type TreePresetSpec = Readonly<{
  kind: TreePresetKind;
  origin: Vec3;
  height: number;
  trunk: AuthoringMaterial;
  leaf: AuthoringMaterial;
  seed?: number;
  collision?: 'skip' | 'error' | 'replace';
}>;

/**
 * Small, explicit recipes for the tree silhouettes already used by the
 * buildings. The recipes are expressed through branch/leafCluster/tree so
 * custom trees keep the same composable primitives.
 */
export function treePreset(kit: BlockKit, spec: TreePresetSpec) {
  if (!Number.isSafeInteger(spec.height) || spec.height < 1) throw new Error('Tree height must be a positive integer');
  const seed = spec.seed ?? 0;
  if (!Number.isSafeInteger(seed)) throw new Error('Tree seed must be an integer');
  const trunk = {
    path: [
      [0, 0, 0],
      [0, spec.height, 0],
    ] as Vec3[],
    material: spec.trunk,
  };
  const crowns: LeafClusterSpec[] = [];
  if (spec.kind === 'pine') {
    for (let y = spec.height, r = 3; y >= Math.floor(spec.height / 3); y -= 2, r = Math.max(1, r - 1))
      crowns.push({
        center: [0, y, 0],
        radii: [r, 0.01, r],
        shape: 'disc',
        material: spec.leaf,
        sample: (dx, dy, dz) =>
          dy === 0 &&
          dx * dx + dz * dz <= r * r + 1 &&
          !(dx === 0 && dz === 0 && y < spec.height) &&
          (dx * 5 + dz * 7 + spec.origin[1] + y + seed) % 9 !== 0,
        allowWoodOverlap: true,
      });
  } else if (spec.kind === 'broadleaf') {
    trunk.path = [
      [0, 0, 0],
      [0, Math.max(0, spec.height - 1), 0],
    ];
    crowns.push({
      center: [0, spec.height, 0],
      radii: [3, 2, 3],
      material: spec.leaf,
      allowWoodOverlap: true,
      sample: (dx, dy, dz) =>
        dy >= -1 &&
        dy <= 2 &&
        dx * dx + dz * dz + dy * dy * 1.6 <= 10 &&
        (dx * 7 + dz * 11 + dy * 13 + seed) % 11 !== 0,
    });
    crowns.push({
      center: [0, spec.height + 2, 0],
      radii: [0.1, 0.1, 0.1],
      material: spec.leaf,
      sample: (dx, dy, dz) => dx === 0 && dy === 0 && dz === 0,
      allowWoodOverlap: true,
    });
  }
  return tree(kit, { branches: [trunk], crowns, origin: spec.origin, collision: spec.collision });
}
