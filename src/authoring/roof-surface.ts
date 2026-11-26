import type { Box, Vec3 } from '../core/structure.js';
import { resolveMaterial, type Dir, type AuthoringMaterial, type BlockKit } from './kit.js';
import { assertRect, type RectXZ } from './layout.js';

export type RoofCell = Readonly<{
  position: Vec3;
  edge: boolean;
  ridge: boolean;
  /** A unique uphill direction; null at flat cells and intersecting slopes. */
  uphill: Dir | null;
  /** Fractional half-step of the surface level; only half-grid profiles produce 0.5. */
  half: 0 | 0.5;
}>;
export type RoofSurfaceSpec = RectXZ &
  Readonly<{
    /** Integer Y of the surface block, null outside a custom footprint. */
    heightAt: (x: number, z: number) => number | null;
    thickness?: number;
    /** If supplied, fill from this Y instead of making a thin shell. */
    solidFromY?: number;
    /** Half-step flag per column; only half-grid profile roofs supply it. */
    halfAt?: (x: number, z: number) => 0 | 0.5;
  }>;
export type RoofPlan = Readonly<{
  cells: readonly RoofCell[];
  eaves: readonly RoofCell[];
  ridges: readonly RoofCell[];
  bounds: Box;
  heightAt: (x: number, z: number) => number | null;
}>;
export type RoofSurfaceMaterials = Readonly<{
  tile: AuthoringMaterial;
  stairs?: AuthoringMaterial;
  slab?: AuthoringMaterial;
  /** Surface override only; null deliberately omits the surface block. */
  surface?: (cell: RoofCell) => AuthoringMaterial | null;
  /** Add ridge tiles, corner ornaments, etc. after each surface block. */
  decorate?: (kit: BlockKit, cell: RoofCell) => void;
}>;

/** Sample once so roof geometry and attachment queries always use the same heights. */
export function planRoof(spec: RoofSurfaceSpec): RoofPlan {
  assertRect(spec);
  const thickness = spec.thickness ?? 1;
  if (!Number.isSafeInteger(thickness) || thickness < 1) throw new Error('Roof thickness must be a positive integer');
  if (spec.solidFromY !== undefined && !Number.isSafeInteger(spec.solidFromY))
    throw new Error('solidFromY must be an integer');
  const heights = new Map<string, number>();
  for (let x = spec.x0; x <= spec.x1; x++)
    for (let z = spec.z0; z <= spec.z1; z++) {
      const y = spec.heightAt(x, z);
      if (y === null) continue;
      if (!Number.isSafeInteger(y)) throw new Error('Roof height must be an integer or null');
      if (spec.solidFromY !== undefined && spec.solidFromY > y) throw new Error('solidFromY exceeds roof surface');
      heights.set(`${x},${z}`, y);
    }
  if (!heights.size) throw new Error('Roof footprint is empty');
  const heightAt = (x: number, z: number) => heights.get(`${x},${z}`) ?? null;
  const cells: RoofCell[] = [],
    min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [key, y] of heights) {
    const [x, z] = key.split(',').map(Number);
    const neighbours = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].map(([dx, dz]) => heightAt(x + dx, z + dz));
    const higher = neighbours.flatMap((h, i) => (h !== null && h > y ? [i as Dir] : []));
    const lower = neighbours.filter((h) => h !== null && h < y).length;
    cells.push({
      position: [x, y, z],
      edge: neighbours.includes(null),
      ridge: higher.length === 0 && lower >= 2,
      uphill: higher.length === 1 ? higher[0] : null,
      half: spec.halfAt ? spec.halfAt(x, z) : 0,
    });
    const bottom = spec.solidFromY ?? y - thickness + 1;
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], bottom);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x + 1);
    max[1] = Math.max(max[1], y + 1);
    max[2] = Math.max(max[2], z + 1);
  }
  return {
    cells,
    eaves: cells.filter((c) => c.edge),
    ridges: cells.filter((c) => c.ridge),
    bounds: { min, max },
    heightAt,
  };
}
export function roofSurface(kit: BlockKit, spec: RoofSurfaceSpec, materials: RoofSurfaceMaterials) {
  const plan = planRoof(spec);
  for (const cell of plan.cells) {
    const [x, y, z] = cell.position;
    const bottom = spec.solidFromY ?? y - (spec.thickness ?? 1) + 1;
    kit.fill(x, bottom, z, x, y - 1, z, materials.tile);
    if (materials.surface) {
      const m = materials.surface(cell);
      if (m !== null) kit.put(x, y, z, m);
    } else if (cell.uphill !== null && materials.stairs) kit.stair(x, y, z, cell.uphill, materials.stairs);
    else if (!cell.ridge && materials.slab) kit.slab(x, y, z, materials.slab);
    else kit.put(x, y, z, materials.tile);
  }
  // Decorations are a second pass. A ridge ornament may occupy a neighbouring
  // roof cell, so running it while the surface is still being tiled lets a
  // later surface write erase the ornament.
  if (materials.decorate) for (const cell of plan.cells) materials.decorate(kit, cell);
  return plan;
}

/**
 * Shared shallow gable tiling recipe used by the Jiangnan and water-town
 * buildings. The building supplies bounds and palette; this keeps the
 * slab/stair alternation, ridge cap, and corner closure in one place.
 */
export type AlternatingGableRecipe = Readonly<{
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  ridgeAxis: 'x' | 'z';
  tile: AuthoringMaterial;
  stairs: AuthoringMaterial;
  slab: AuthoringMaterial;
  ridgeCap?: boolean;
  cornerClosure?: boolean;
  /** Optional material for the raised ridge cap; defaults to slab. */
  ridgeMaterial?: AuthoringMaterial;
  /**
   * Key the slab/stair choice off `cell.half` (from a half-grid profile roof)
   * instead of distance parity. Equivalent for linear half-block slopes.
   */
  halfGrid?: boolean;
}>;

export function alternatingGableRecipe(recipe: AlternatingGableRecipe): RoofSurfaceMaterials {
  const { x0, x1, z0, z1, ridgeAxis, tile, stairs, slab } = recipe;
  const ridgeCap = recipe.ridgeCap !== false;
  const cornerClosure = recipe.cornerClosure !== false;
  const ridgeMaterial = recipe.ridgeMaterial ?? slab;
  const mid = (ridgeAxis === 'x' ? z0 + z1 : x0 + x1) / 2;
  return {
    tile,
    surface: (cell) => {
      const [x, , z] = cell.position;
      const across = ridgeAxis === 'x' ? z : x;
      const low = ridgeAxis === 'x' ? z0 : x0;
      const high = ridgeAxis === 'x' ? z1 : x1;
      const distance = Math.min(across - low, high - across);
      if (across === mid) return resolveMaterial(tile);
      if (recipe.halfGrid) {
        if (cell.half === 0) return resolveMaterial(slab, { 'minecraft:vertical_half': 'bottom' });
        const uphill = cell.uphill ?? (ridgeAxis === 'x' ? (across < mid ? 2 : 3) : across < mid ? 0 : 1);
        return resolveMaterial(stairs, { weirdo_direction: uphill, upside_down_bit: false });
      }
      if (distance % 2 === 0) return resolveMaterial(slab, { 'minecraft:vertical_half': 'bottom' });
      const direction: Dir = ridgeAxis === 'x' ? (across < mid ? 2 : 3) : across < mid ? 0 : 1;
      return resolveMaterial(stairs, { weirdo_direction: direction, upside_down_bit: false });
    },
    decorate: (kit, { position: [x, y, z] }) => {
      const across = ridgeAxis === 'x' ? z : x;
      const onRidge = across === mid;
      if (ridgeCap && onRidge) kit.put(x, y + 1, z, ridgeMaterial);
      if (cornerClosure && (x === x0 || x === x1) && (z === z0 || z === z1)) {
        kit.put(x, y, z, tile);
        kit.slab(x, y + 1, z, slab);
      }
    },
  };
}
export type AlternatingGableSpec = Readonly<{
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  eaveY: number;
  profile: RoofProfile;
  tile: AuthoringMaterial;
  stairs: AuthoringMaterial;
  slab: AuthoringMaterial;
  ridgeAxis?: 'x' | 'z';
  thickness?: number;
  solidFromY?: number;
  offsetAt?: (x: number, z: number) => number;
  /** Passed to both the roof and the recipe so the two cannot drift apart. */
  halfGrid?: boolean;
  ridgeCap?: boolean;
  cornerClosure?: boolean;
  ridgeMaterial?: AuthoringMaterial;
}>;

/** One-call shallow gable: gableRoof composed with alternatingGableRecipe. */
export function alternatingGable(kit: BlockKit, spec: AlternatingGableSpec) {
  return gableRoof(
    kit,
    {
      x0: spec.x0,
      x1: spec.x1,
      z0: spec.z0,
      z1: spec.z1,
      eaveY: spec.eaveY,
      profile: spec.profile,
      ridgeAxis: spec.ridgeAxis,
      thickness: spec.thickness,
      solidFromY: spec.solidFromY,
      offsetAt: spec.offsetAt,
      halfGrid: spec.halfGrid,
    },
    alternatingGableRecipe({ ...spec, ridgeAxis: spec.ridgeAxis ?? 'x' }),
  );
}
export type RoofProfile = readonly number[] | ((distance: number, span: number) => number);
/** Raw profile level in blocks; may be fractional for half-grid roofs. */
export function profileLevel(profile: RoofProfile, distance: number, span: number) {
  if (typeof profile !== 'function' && !profile.length) throw new Error('Roof profile cannot be empty');
  const h =
    typeof profile === 'function'
      ? profile(distance, span)
      : profile[Math.min(Math.floor(distance), profile.length - 1)];
  if (!Number.isFinite(h)) throw new Error('Roof profile must return finite heights');
  return h;
}
export function profileHeight(profile: RoofProfile, distance: number, span: number) {
  return Math.round(profileLevel(profile, distance, span));
}
export type ProfileRoofSpec = RectXZ &
  Readonly<{
    eaveY: number;
    profile: RoofProfile;
    thickness?: number;
    solidFromY?: number;
    /** Add local upturns/asymmetry without rewriting tiling. */
    offsetAt?: (x: number, z: number) => number;
    /**
     * Half-grid mode: the profile rises in half-block steps (0.5 per block of
     * level). Surface Y floors the raw level and `cell.half` carries the
     * quantized fraction so cladding can pick slab vs stair.
     */
    halfGrid?: boolean;
  }>;
export function gableRoof(
  kit: BlockKit,
  spec: ProfileRoofSpec & { ridgeAxis?: 'x' | 'z' },
  materials: RoofSurfaceMaterials,
) {
  const alongX = (spec.ridgeAxis ?? 'x') === 'x';
  const span = (alongX ? spec.z1 - spec.z0 : spec.x1 - spec.x0) / 2;
  const distanceOf = (x: number, z: number) =>
    alongX ? Math.min(z - spec.z0, spec.z1 - z) : Math.min(x - spec.x0, spec.x1 - x);
  if (!spec.halfGrid)
    return roofSurface(
      kit,
      {
        ...spec,
        heightAt: (x, z) =>
          spec.eaveY + profileHeight(spec.profile, distanceOf(x, z), span) + (spec.offsetAt?.(x, z) ?? 0),
      },
      materials,
    );
  const levelOf = (x: number, z: number) =>
    spec.eaveY + profileLevel(spec.profile, distanceOf(x, z), span) + (spec.offsetAt?.(x, z) ?? 0);
  return roofSurface(
    kit,
    {
      ...spec,
      heightAt: (x, z) => Math.floor(levelOf(x, z)),
      halfAt: (x, z) => (levelOf(x, z) - Math.floor(levelOf(x, z)) >= 0.5 ? 0.5 : 0),
    },
    materials,
  );
}
/** Four-slope counterpart to gableRoof; the original hipRoof remains compatible. */
export function profileHipRoof(kit: BlockKit, spec: ProfileRoofSpec, materials: RoofSurfaceMaterials) {
  const span = Math.min(spec.x1 - spec.x0, spec.z1 - spec.z0) / 2;
  const distanceOf = (x: number, z: number) => Math.min(x - spec.x0, spec.x1 - x, z - spec.z0, spec.z1 - z);
  if (!spec.halfGrid)
    return roofSurface(
      kit,
      {
        ...spec,
        heightAt: (x, z) =>
          spec.eaveY + profileHeight(spec.profile, distanceOf(x, z), span) + (spec.offsetAt?.(x, z) ?? 0),
      },
      materials,
    );
  const levelOf = (x: number, z: number) =>
    spec.eaveY + profileLevel(spec.profile, distanceOf(x, z), span) + (spec.offsetAt?.(x, z) ?? 0);
  return roofSurface(
    kit,
    {
      ...spec,
      heightAt: (x, z) => Math.floor(levelOf(x, z)),
      halfAt: (x, z) => (levelOf(x, z) - Math.floor(levelOf(x, z)) >= 0.5 ? 0.5 : 0),
    },
    materials,
  );
}

export type RoofLine = Readonly<{
  /** Ordered end to end; shared junction cells appear in every line through them. */
  cells: RoofCell[];
  /** Unit step from the first to the second cell; [0, 0] for single-cell lines. */
  step: readonly [number, number];
}>;

const lineKey = (x: number, z: number) => `${x},${z}`;
const step8 = (dx: number, dz: number) => Math.abs(dx) + Math.abs(dz);
const DIAGONALS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Split ridge cells into maximal straight segments (8-connected, diagonals
 * included so hip ridges stay whole). Junction cells are shared between
 * lines; the output is deterministic and covers every ridge cell.
 */
export function ridgeLines(plan: RoofPlan): RoofLine[] {
  const cells = new Map<string, RoofCell>();
  for (const cell of plan.ridges) cells.set(lineKey(cell.position[0], cell.position[2]), cell);
  const neighboursOf = (cell: RoofCell) =>
    DIAGONALS.flatMap(([dx, dz]) => {
      const n = cells.get(lineKey(cell.position[0] + dx, cell.position[2] + dz));
      return n ? [{ n, dx, dz }] : [];
    });
  // A node starts or ends a line: endpoints, corners and junctions. Cells
  // with exactly two opposite neighbours continue a line; a pure crossing
  // (two opposite pairs, e.g. hips meeting at an apex) passes straight too.
  const isNode = (cell: RoofCell) => {
    const ns = neighboursOf(cell);
    if (ns.length === 2) return ns[0].dx !== -ns[1].dx || ns[0].dz !== -ns[1].dz;
    if (ns.length === 4) {
      const dirs = new Set(ns.map(({ dx, dz }) => `${dx},${dz}`));
      return !(
        (dirs.has('1,0') && dirs.has('-1,0')) ||
        (dirs.has('0,1') && dirs.has('0,-1')) ||
        (dirs.has('1,1') && dirs.has('-1,-1')) ||
        (dirs.has('1,-1') && dirs.has('-1,1'))
      );
    }
    return true;
  };
  const straight = new Set<string>();
  const lines: RoofLine[] = [];
  const signatures = new Set<string>();
  const emit = (list: RoofCell[]) => {
    if (list.length > 1) {
      const [a, b] = [list[0]!, list.at(-1)!];
      if (a.position[0] > b.position[0] || (a.position[0] === b.position[0] && a.position[2] > b.position[2]))
        list.reverse();
    }
    const signature = list
      .map((c) => lineKey(c.position[0], c.position[2]))
      .sort()
      .join(';');
    if (signatures.has(signature)) return;
    signatures.add(signature);
    const [a, b] = [list[0]!, list.at(-1)!];
    const step: [number, number] =
      list.length > 1 ? [Math.sign(b.position[0] - a.position[0]), Math.sign(b.position[2] - a.position[2])] : [0, 0];
    lines.push({ cells: list, step });
  };
  const walk = (start: RoofCell, dx: number, dz: number) => {
    const list = [start];
    let cx = start.position[0],
      cz = start.position[2];
    for (;;) {
      const next = cells.get(lineKey(cx + dx, cz + dz));
      if (!next) break;
      list.push(next);
      if (isNode(next)) break;
      straight.add(lineKey(cx + dx, cz + dz));
      cx += dx;
      cz += dz;
    }
    return list;
  };
  for (const cell of cells.values()) {
    if (!isNode(cell) || straight.has(lineKey(cell.position[0], cell.position[2]))) continue;
    const neighbours = neighboursOf(cell);
    const outgoing = neighbours.filter(
      ({ dx, dz }) =>
        !cells.get(lineKey(cell.position[0] - dx, cell.position[2] - dz)) &&
        !straight.has(lineKey(cell.position[0] + dx, cell.position[2] + dz)),
    );
    if (!neighbours.length) emit([cell]);
    for (const { dx, dz } of outgoing) emit(walk(cell, dx, dz));
  }
  return lines.sort(
    (a, b) => a.cells[0]!.position[0] - b.cells[0]!.position[0] || a.cells[0]!.position[2] - b.cells[0]!.position[2],
  );
}

/**
 * Ordered eave boundary lines: connected edge runs walked cell by cell.
 * Rectangular footprints yield one closed loop (first and last cells are
 * adjacent; the start cell is not repeated); interior holes yield their own
 * inner loops.
 */
export function eaveLines(plan: RoofPlan): RoofLine[] {
  const cells = new Map<string, RoofCell>();
  for (const cell of plan.eaves) cells.set(lineKey(cell.position[0], cell.position[2]), cell);
  const components: RoofCell[][] = [];
  const seen = new Set<string>();
  for (const cell of cells.values()) {
    if (seen.has(lineKey(cell.position[0], cell.position[2]))) continue;
    const component = [cell],
      queue = [cell];
    seen.add(lineKey(cell.position[0], cell.position[2]));
    while (queue.length) {
      const current = queue.pop()!;
      for (const [dx, dz] of DIAGONALS) {
        const k = lineKey(current.position[0] + dx, current.position[2] + dz);
        const n = cells.get(k);
        if (n && !seen.has(k)) {
          seen.add(k);
          component.push(n);
          queue.push(n);
        }
      }
    }
    components.push(component);
  }
  return components
    .map((component) => {
      // Face-first depth-first walk: straight boundary runs stay face-adjacent,
      // concave corners wrap diagonally, dead ends backtrack instead of
      // shortcutting past unvisited cells.
      const start = component.reduce((a, b) =>
        b.position[0] < a.position[0] || (b.position[0] === a.position[0] && b.position[2] < a.position[2]) ? b : a,
      );
      const visited = new Set<string>([lineKey(start.position[0], start.position[2])]);
      const ordered = [start];
      const stack: { cell: RoofCell }[] = [];
      const pushSteps = (cell: RoofCell) => {
        const steps = DIAGONALS.map(([dx, dz]) => ({ dx, dz, face: step8(dx, dz) === 1 }))
          .sort((a, b) => Number(b.face) - Number(a.face) || a.dx - b.dx || a.dz - b.dz)
          .map(({ dx, dz }) => cells.get(lineKey(cell.position[0] + dx, cell.position[2] + dz)))
          .filter((n): n is RoofCell => !!n && !visited.has(lineKey(n.position[0], n.position[2])));
        for (let i = steps.length - 1; i >= 0; i--) stack.push({ cell: steps[i]! });
      };
      pushSteps(start);
      while (stack.length) {
        const { cell } = stack.pop()!;
        const key = lineKey(cell.position[0], cell.position[2]);
        if (visited.has(key)) continue;
        visited.add(key);
        ordered.push(cell);
        pushSteps(cell);
      }
      const second = ordered[1] ?? start;
      return {
        cells: ordered,
        step: (ordered.length > 1
          ? [Math.sign(second.position[0] - start.position[0]), Math.sign(second.position[2] - start.position[2])]
          : [0, 0]) as [number, number],
      };
    })
    .sort(
      (a, b) => a.cells[0]!.position[0] - b.cells[0]!.position[0] || a.cells[0]!.position[2] - b.cells[0]!.position[2],
    );
}
