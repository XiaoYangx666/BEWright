import type { Box, State, Structure, Vec3 } from '../../core/structure.js';
import type { Diagnostic, DiagnosticObject } from '../diagnostic-core.js';
import { commitConstruction, planConstruction, type ConstructionMergeStats } from '../construction.js';
import type { ProtectionRegistry } from '../protection.js';
import type { ProtectionRuleSet } from '../rules.js';
import type { WaterPlan } from './contracts.js';

export type WaterMaterials = Readonly<{
  /**
   * Water block for a cell.
   *
   * `depth` is the liquid-depth state to write. The framework writes **0
   * (source)** everywhere and never fakes flow levels from a distance: a flow
   * state is a rendering decision, not geometry.
   */
  water: (cell: Vec3, depth: number) => State;
  bed: (cell: Vec3) => State | null;
  wall?: (cell: Vec3) => State | null;
}>;

export type WaterBuildTarget = Readonly<{
  put(
    x: number,
    y: number,
    z: number,
    material: import('../kit.js').AuthoringMaterial,
    states?: Record<string, string | number | boolean>,
    role?: import('../construction.js').ConstructionRole,
  ): void;
  air(x: number, y: number, z: number, role?: import('../construction.js').ConstructionRole): void;
  /** The structure being built; used to record world-space extents. */
  s: Structure;
  /** Optional sink for findings the build makes on the way. */
  report?(diagnostic: Diagnostic): void;
}>;

export type WaterBuildOptions = Readonly<{
  object?: DiagnosticObject | string;
  protection?: ProtectionRegistry;
  rules?: ProtectionRuleSet;
}>;

export type WaterBuildReport = Readonly<{
  waterCells: number;
  bedCells: number;
  bounds: Box | null;
  diagnostics: readonly Diagnostic[];
  /** True when the plan passed validation and was applied to the model. */
  committed: boolean;
  merges?: ConstructionMergeStats;
}>;

/**
 * Build a planned system into a target (a real kit, or a construction recorder):
 * channel walls first, then the bed, then water last. Never the other way round
 * — placing water first leaves the channel unsealed and the pool leaking.
 *
 * This is the recording pass; whether the model may be touched is decided by
 * the construction plan around it.
 */
export function recordWaterSystem(
  kit: Omit<WaterBuildTarget, 's'>,
  plan: WaterPlan,
  materials: WaterMaterials,
): WaterBuildReport {
  if (!plan.feasible)
    throw new Error(
      `Refusing to build an infeasible water system: ${plan.diagnostics.map((item) => item.message).join('; ')}`,
    );
  let bedCells = 0;
  let waterCells = 0;
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  const grow = (x: number, y: number, z: number) => {
    if (!min || !max) {
      min = [x, y, z];
      max = [x + 1, y + 1, z + 1];
      return;
    }
    min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
    max = [Math.max(max[0], x + 1), Math.max(max[1], y + 1), Math.max(max[2], z + 1)];
  };
  // Pass 1: open each water column, then lay its bed and walls. Water is only
  // placed once every column of every segment has its floor in place.
  for (const segment of plan.segments) {
    const hanging = segment.spec.kind === 'drop' || segment.spec.kind === 'wall-sheet';
    const carve = hanging ? (segment.spec.carve ?? 0) : (segment.spec.carve ?? 1);
    for (const column of segment.columns) {
      for (let y = column.bottom; y <= column.top + carve; y++) kit.air(column.x, y, column.z, 'water');
      grow(column.x, column.bottom, column.z);
      grow(column.x, column.top, column.z);
    }
    if (!hanging)
      for (const cell of segment.bedCells) {
        const block = materials.bed(cell);
        if (!block) continue;
        kit.put(cell[0], cell[1], cell[2], block, {}, 'bed');
        bedCells++;
        grow(cell[0], cell[1], cell[2]);
      }
    if (materials.wall)
      for (const cell of segment.surfaceCells) {
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const block = materials.wall([cell[0] + dx, cell[1], cell[2] + dz]);
          if (!block) continue;
          kit.put(cell[0] + dx, cell[1], cell[2] + dz, block, {}, 'bank');
          grow(cell[0] + dx, cell[1], cell[2] + dz);
        }
      }
  }
  // Pass 2: water, source blocks throughout.
  for (const segment of plan.segments)
    for (const cell of segment.surfaceCells) {
      kit.put(cell[0], cell[1], cell[2], materials.water(cell, 0), {}, 'water');
      grow(cell[0], cell[1], cell[2]);
      waterCells++;
    }
  return { waterCells, bedCells, bounds: min && max ? { min, max } : null, diagnostics: [], committed: false };
}

/**
 * Plan, validate and commit a water system as one operation group.
 *
 * Returns the world-space extents it touched so the caller can fold the system
 * into its own diagnostics and protection contracts. A refused plan leaves the
 * model exactly as it was.
 */
export function buildWaterSystem(
  kit: WaterBuildTarget,
  plan: WaterPlan,
  materials: WaterMaterials,
  options: WaterBuildOptions = {},
): WaterBuildReport {
  if (!plan.feasible)
    throw new Error(
      `Refusing to build an infeasible water system: ${plan.diagnostics.map((item) => item.message).join('; ')}`,
    );
  let recorded: WaterBuildReport = { waterCells: 0, bedCells: 0, bounds: null, diagnostics: [], committed: false };
  const construction = planConstruction(kit.s, {
    id: plan.id,
    object: options.object ?? { kind: 'water-system', id: plan.id },
    ...(options.protection ? { protection: options.protection } : {}),
    ...(options.rules ? { rules: options.rules } : {}),
    // A water system owns the ground it is cut into: the body, its bed and its
    // banks are planned, and what it may not touch is declared by protection.
    excavationAuthorized: true,
    build: (sink) => {
      recorded = recordWaterSystem(sink, plan, materials);
    },
  });
  if (!construction.feasible)
    return { ...recorded, waterCells: 0, bedCells: 0, committed: false, diagnostics: construction.diagnostics };
  const applied = commitConstruction(kit.s, construction);
  return {
    ...recorded,
    waterCells: applied.written,
    committed: true,
    diagnostics: construction.diagnostics,
    merges: construction.merges,
  };
}
