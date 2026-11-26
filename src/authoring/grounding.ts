import type { State, Structure, Vec3 } from '../core/structure.js';
import { type RectXZ, assertRect } from './layout.js';
import type { Lot } from './site.js';
import { SurfaceQuery } from './surface.js';
import { fullSupport } from './road-profile.js';
import { collisionBoxes } from './traversal.js';
import { structureIdentity } from './model-target.js';
import { coordinateDiagnostic, type Diagnostic } from './diagnostics.js';
import {
  planConstruction,
  commitConstruction,
  type ConstructionRequest,
  type ConstructionSink,
} from './construction.js';

export type GroundingSpec = Readonly<{
  id: string;
  /** World footprint, inclusive. floorY is the finished floor block, not foot height. */
  footprint: RectXZ;
  floorY: number;
  mode: 'plinth' | 'terrace' | 'stilts';
  maxCut: number;
  maxFill: number;
  earthworkBudget: number;
  headroom?: number;
  /** Terrace blend width; plinth has a vertical exposed foundation. */
  transition?: number;
  /** World X/Z support points; only these get columns in stilts mode. */
  supports?: readonly (readonly [number, number])[];
  waterClearance?: number;
}>;
export type GroundingColumn = Readonly<{
  x: number;
  z: number;
  ground: number;
  top: number;
  core: boolean;
  support: boolean;
  cut: number;
  fill: number;
  water: number | null;
}>;
export type GroundingPlan = Readonly<{
  spec: GroundingSpec;
  columns: readonly GroundingColumn[];
  diagnostics: readonly Diagnostic[];
  feasible: boolean;
  targetIdentity: number;
  baseRevision: number;
  cutBlocks: number;
  fillBlocks: number;
}>;
export type GroundingMaterials = Readonly<{
  floor: (column: GroundingColumn) => State;
  foundation: (column: GroundingColumn, y: number) => State;
  /** Surface of the terrace transition, independent of the building style. */
  transition?: (column: GroundingColumn) => State;
}>;

/** Derive a world footprint and floor from a transformed lot; no centre-based road connection. */
export function groundingFromLot(lot: Lot, input: Omit<GroundingSpec, 'id' | 'footprint' | 'floorY'>): GroundingSpec {
  const box = lot.boundsToWorld();
  return {
    ...input,
    id: lot.id,
    footprint: { x0: box.min[0], x1: box.max[0] - 1, z0: box.min[2], z1: box.max[2] - 1 },
    floorY: lot.origin[1],
  };
}

/** Entrance road waypoints: road enters from the anchor's transformed outward normal. */
export function entranceApproach(lot: Lot, length: number, roadY: number): readonly Vec3[] {
  const entry = lot.entrance();
  if (!entry || !Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(roadY))
    throw new Error('Entrance requires an anchor, integer road Y and positive approach length');
  const [dx, dz] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ][entry.worldFacing]!;
  return [[entry.position[0] + dx * length, roadY, entry.position[2] + dz * length], [...entry.position] as Vec3];
}

export function planGrounding(world: Structure, input: GroundingSpec): GroundingPlan {
  const spec: GroundingSpec = {
    ...input,
    footprint: { ...input.footprint },
    supports: input.supports?.map((p) => [...p] as [number, number]),
  };
  assertRect(spec.footprint);
  for (const value of [
    ...Object.values(spec.footprint),
    spec.floorY,
    spec.maxCut,
    spec.maxFill,
    spec.earthworkBudget,
    spec.headroom ?? 3,
    spec.transition ?? 0,
  ])
    if (!Number.isSafeInteger(value)) throw new Error('Grounding dimensions and budgets must be integers');
  if (Math.min(spec.maxCut, spec.maxFill, spec.earthworkBudget, spec.transition ?? 0) < 0 || (spec.headroom ?? 3) < 2)
    throw new Error('Invalid grounding limits');
  if (spec.waterClearance !== undefined && (!Number.isSafeInteger(spec.waterClearance) || spec.waterClearance < 1))
    throw new Error('waterClearance must be a positive integer');
  const targetIdentity = structureIdentity(world),
    baseRevision = world.revision;
  const diagnostics: Diagnostic[] = [];
  const fail = (rule: string, p: Vec3, message: string) =>
    diagnostics.push(
      coordinateDiagnostic({
        rule,
        position: p,
        object: { kind: 'foundation', id: spec.id },
        message,
        source: 'grounding-plan',
      }),
    );
  const r = spec.footprint;
  const support = new Set((spec.supports ?? []).map(([x, z]) => `${x},${z}`));
  if (spec.mode === 'stilts' && !support.size)
    fail('grounding.support-required', [r.x0, spec.floorY, r.z0], '架空接地必须声明支点');
  for (const [x, z] of spec.supports ?? [])
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z) || x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1)
      fail('grounding.support-outside', [x, spec.floorY, z], '支点必须位于建筑占地内的整数格');
  const bounds = world.inspect().bounds;
  const surface = new SurfaceQuery(world, {
    minY: bounds?.min[1] ?? 0,
    maxY: bounds?.max[1] ?? spec.floorY,
    scanLimit: Math.max(48, bounds ? bounds.max[1] - bounds.min[1] + 2 : 48),
    airStopsTerrain: false,
  });
  const band = spec.mode === 'terrace' ? (spec.transition ?? 3) : 0;
  const columns: GroundingColumn[] = [];
  for (let x = r.x0 - band; x <= r.x1 + band; x++)
    for (let z = r.z0 - band; z <= r.z1 + band; z++) {
      const distance = Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
      if (distance > band) continue;
      const ground = surface.terrain(x, z),
        water = surface.water(x, z),
        core = distance === 0;
      if (ground === null || !fullSupport(world, x, ground, z)) {
        fail('grounding.unresolved-ground', [x, spec.floorY, z], '接地范围没有确认的完整地面');
        continue;
      }
      const t = band ? Math.min(1, distance / band) : 0;
      const smooth = t * t * (3 - 2 * t);
      const top = core ? spec.floorY : Math.round((spec.floorY - 1) * (1 - smooth) + ground * smooth);
      const supported = spec.mode !== 'stilts' || support.has(`${x},${z}`);
      if (water !== null && (supported || top - (water + 1) < (spec.waterClearance ?? 2)))
        fail('grounding.water-conflict', [x, water, z], '基础或支点会占用水道，或架空净空不足');
      if (spec.mode === 'stilts' && ground >= top)
        fail('grounding.stilt-embedded', [x, top, z], '架空地板穿入地形；请调整地坪或使用顺坡接地');
      const cut = Math.max(0, ground - top),
        fill = supported ? Math.max(0, top - 1 - ground) : 0;
      if (cut > spec.maxCut || fill > spec.maxFill)
        fail(
          'grounding.depth-budget',
          [x, top, z],
          `此列需要削 ${cut} / 填 ${fill}，超过限制 ${spec.maxCut} / ${spec.maxFill}`,
        );
      columns.push({ x, z, ground, top, core, support: supported, cut, fill, water });
    }
  const cutBlocks = columns.reduce((n, c) => n + c.cut, 0),
    fillBlocks = columns.reduce((n, c) => n + c.fill, 0);
  if (cutBlocks + fillBlocks > spec.earthworkBudget)
    fail(
      'grounding.earthwork-budget',
      [r.x0, spec.floorY, r.z0],
      `接地削填 ${cutBlocks + fillBlocks} 超过预算 ${spec.earthworkBudget}`,
    );
  return {
    spec,
    columns,
    diagnostics,
    cutBlocks,
    fillBlocks,
    targetIdentity,
    baseRevision,
    feasible: diagnostics.length === 0,
  };
}

/** Check the built floor, foundations and occupied interior against actual collision. */
export function checkGrounding(
  world: Pick<Structure, 'get'>,
  plan: GroundingPlan,
  options: Readonly<{ interior?: boolean }> = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fail = (rule: string, c: GroundingColumn, y: number, message: string) =>
    diagnostics.push(
      coordinateDiagnostic({
        rule,
        position: [c.x, y, c.z],
        object: { kind: 'foundation', id: plan.spec.id },
        message,
        conclusive: collisionBoxes(world.get(c.x, y, c.z)).kind !== 'unknown',
        severity: collisionBoxes(world.get(c.x, y, c.z)).kind === 'unknown' ? 'unknown' : 'error',
        source: 'grounding-check',
      }),
    );
  for (const c of plan.columns) {
    if (!fullSupport(world, c.x, c.top, c.z)) fail('grounding.floor-gap', c, c.top, '地坪或接坡表皮不是完整实体');
    if (c.support)
      for (let y = Math.min(c.ground, c.top - 1); y < c.top; y++)
        if (!fullSupport(world, c.x, y, c.z)) {
          fail('grounding.foundation-gap', c, y, '基础或支柱未连续接到实体地面');
          break;
        }
    // Foundation validation precedes custom superstructure: it may later add columns.
    if (c.core && options.interior !== false)
      for (let y = c.top + 1; y <= c.top + (plan.spec.headroom ?? 3); y++) {
        const shape = collisionBoxes(world.get(c.x, y, c.z));
        if (shape.kind === 'unknown' || shape.boxes.length) {
          fail('grounding.interior-blocked', c, y, '整地后建筑占地内仍有障碍');
          break;
        }
      }
    if (plan.spec.mode === 'stilts' && !c.support)
      for (let y = c.ground + 1; y < c.top; y++) {
        const shape = collisionBoxes(world.get(c.x, y, c.z));
        if (shape.kind === 'unknown' || shape.boxes.length) {
          fail('grounding.underfloor-blocked', c, y, '架空区被填实或存在未知障碍');
          break;
        }
      }
  }
  return diagnostics;
}

export function recordGrounding(
  sink: ConstructionSink,
  world: Structure,
  plan: GroundingPlan,
  materials: GroundingMaterials,
): void {
  for (const d of plan.diagnostics) sink.report(d);
  if (!plan.feasible) return;
  if (structureIdentity(world) !== plan.targetIdentity || world.revision !== plan.baseRevision) {
    sink.report(
      coordinateDiagnostic({
        rule: 'grounding.stale-target',
        object: plan.spec.id,
        position: [plan.spec.footprint.x0, plan.spec.floorY, plan.spec.footprint.z0],
        message: '接地依据的模型已改变，必须重新规划',
      }),
    );
    return;
  }
  for (const c of plan.columns) {
    const role = c.core ? 'object' : 'terrain';
    for (let y = c.top + 1; y <= c.ground; y++) sink.air(c.x, y, c.z, role);
    if (c.support)
      for (let y = c.ground + 1; y < c.top; y++) sink.put(c.x, y, c.z, materials.foundation(c, y), {}, role);
    sink.put(
      c.x,
      c.top,
      c.z,
      c.core ? materials.floor(c) : (materials.transition?.(c) ?? materials.foundation(c, c.top)),
      {},
      role,
    );
  }
  for (const d of checkGrounding(sink, plan)) sink.report(d);
}

export function buildGrounding(
  world: Structure,
  plan: GroundingPlan,
  materials: GroundingMaterials,
  options: Pick<ConstructionRequest, 'protection' | 'rules' | 'bounds'> = {},
) {
  const construction = planConstruction(world, {
    ...options,
    id: plan.spec.id,
    object: { kind: 'foundation', id: plan.spec.id },
    excavationAuthorized: true,
    build: (sink) => recordGrounding(sink, world, plan, materials),
  });
  return {
    plan: construction,
    committed: construction.feasible ? (commitConstruction(world, construction), true) : false,
    diagnostics: construction.diagnostics,
  };
}
