import { coordinateDiagnostic, type Diagnostic, type DiagnosticObject } from '../diagnostics.js';
import type { Box, State, Structure, Vec3 } from '../../core/structure.js';
import type { SurfaceQuery } from '../surface.js';
import {
  commitConstruction,
  planConstruction,
  type ConstructionMergeStats,
  type ConstructionTarget,
} from '../construction.js';
import type { ProtectionRegistry } from '../protection.js';
import type { ProtectionRuleSet } from '../rules.js';

import type { TerrainRecipe } from './recipe.js';

/* ---------------------------------------------------------------------------
 * 实体化：由配方负责填充、土层厚度、裸岩、表皮材料与边界收口。
 * 建筑不需要再写全域三重循环，也不需要在山脚补洞。
 * ------------------------------------------------------------------------- */

export type TerrainSite = Readonly<{
  x: number;
  z: number;
  /** Final ground block Y of this column. */
  height: number;
  /** Height above the recipe base. */
  rise: number;
  /** One-step slope, in blocks. */
  slope: number;
  /** Blocks below the surface for this cell (0 = the surface block itself). */
  depth: number;
  /** Which layer this cell belongs to. */
  layer: 'surface' | 'soil' | 'rock';
  /** Existing ground Y in this column (null when the column had none). */
  existing: number | null;
}>;

export type TerrainMaterials = Readonly<{
  /** Mandatory body material. */
  rock: (site: TerrainSite) => State;
  /** Layer just under the surface; skipped when omitted. */
  soil?: (site: TerrainSite) => State;
  /**
   * Surface block. Returning `null` leaves the soil/rock choice in place, which
   * is what a caller wants on a cliff face where the "soil" is bare rock.
   */
  surface?: (site: TerrainSite) => State | null;
}>;

export type TerrainBuildOptions = Readonly<{
  /** Half-open XZ footprint. The builder never writes outside it. */
  region: Box;
  /** Everything is filled down to this Y, so the region has a solid base. */
  floorY: number;
  /** Soil thickness under the surface (default 3). */
  soilDepth?: number;
  materials: TerrainMaterials;
  /** Existing terrain to merge with: measured cut and fill, never a plain max. */
  existing?: SurfaceQuery;
  /** Columns where the builder may work; true includes the column (roads, water, protection). */
  where?: (x: number, z: number) => boolean;
  object?: DiagnosticObject | string;
  /**
   * Refuse (and report) when a single column would need more removal than this.
   * Without it, cutting is unlimited — the caller states its authority.
   */
  maxCut?: number;
  /** Material written when a column has to be lowered to the target height. */
  cutMaterial?: (site: TerrainSite) => State;
  /** Declared protection zones the terrain may not enter. */
  protection?: ProtectionRegistry;
  /** Framework protection rules consulted for this object. */
  rules?: ProtectionRuleSet;
}>;

export type TerrainBuildReport = Readonly<{
  columns: number;
  /** Cells written. */
  filled: number;
  /** Blocks removed because the old terrain stood above the target. */
  cut: number;
  /** Columns left untouched by `where`. */
  skipped: number;
  bounds: Box | null;
  diagnostics: readonly Diagnostic[];
  /** True when the plan passed validation and was applied to the model. */
  committed: boolean;
  /** Merge statistics from the construction plan. */
  merges?: ConstructionMergeStats;
}>;

/** An empty report, for callers that need a shape before anything is recorded. */
export function emptyTerrainReport(): TerrainBuildReport {
  return { columns: 0, filled: 0, cut: 0, skipped: 0, bounds: null, diagnostics: [], committed: false };
}

/**
 * Record the terrain into a target (a real kit, or a construction recorder).
 *
 * This is the **geometry pass**: it resolves materials, measures cut and fill
 * and reports findings, but it never decides whether the model may be touched —
 * that belongs to the construction plan around it.
 */
export function recordTerrain(
  target: ConstructionTarget,
  recipe: TerrainRecipe,
  options: TerrainBuildOptions,
): TerrainBuildReport {
  const object: DiagnosticObject =
    typeof options.object === 'string'
      ? { kind: 'terrain', id: options.object }
      : (options.object ?? { kind: 'terrain', id: 'recipe' });
  const soilDepth = Math.max(0, options.soilDepth ?? 3);
  const diagnostics: Diagnostic[] = [];
  const report = (diagnostic: Diagnostic) => {
    diagnostics.push(diagnostic);
    target.report?.(diagnostic);
  };
  let columns = 0;
  let filled = 0;
  let cut = 0;
  let skipped = 0;
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;

  for (let x = options.region.min[0]; x < options.region.max[0]; x++)
    for (let z = options.region.min[2]; z < options.region.max[2]; z++) {
      if (options.where && !options.where(x, z)) {
        skipped++;
        continue;
      }
      const height = recipe.at(x, z);
      const existing = options.existing?.terrain(x, z) ?? null;
      columns++;
      if (options.maxCut !== undefined && existing !== null && existing - height > options.maxCut) {
        report(
          coordinateDiagnostic({
            rule: 'terrain.cut-budget',
            object,
            position: [x, existing, z],
            message: `${x},${z} 需要削掉 ${existing - height} 格，超过 maxCut=${options.maxCut}`,
            data: { cut: existing - height, budget: options.maxCut },
            source: 'terrain',
          }),
        );
        continue;
      }
      const top = height;
      const bottom = Math.min(options.floorY, top);
      // Column geometry is invariant across its rock/soil/surface layers.
      const slope = recipe.slope(x, z);
      // Cut first (ground standing above the target), then lay the column from
      // the target surface down to the floor. Cut and fill are counted
      // separately, so a report can tell a carve from a spoil heap.
      if (existing !== null && existing > top)
        for (let y = top + 1; y <= existing; y++) {
          target.air(x, y, z, 'terrain');
          cut++;
        }
      for (let y = top; y >= bottom; y--) {
        const depth = top - y;
        const layer: TerrainSite['layer'] =
          depth === 0 ? 'surface' : depth <= soilDepth && options.materials.soil ? 'soil' : 'rock';
        const site: TerrainSite = {
          x,
          z,
          height: top,
          rise: top - recipe.base,
          slope,
          depth,
          layer,
          existing,
        };
        const material =
          layer === 'surface'
            ? (options.materials.surface?.(site) ?? options.materials.soil?.(site) ?? options.materials.rock(site))
            : layer === 'soil'
              ? options.materials.soil!(site)
              : options.materials.rock(site);
        target.put(x, y, z, material, {}, 'terrain');
        filled++;
        if (!min || !max) {
          min = [x, y, z];
          max = [x + 1, y + 1, z + 1];
        } else {
          min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
          max = [Math.max(max[0], x + 1), Math.max(max[1], y + 1), Math.max(max[2], z + 1)];
        }
      }
    }
  return {
    columns,
    filled,
    cut,
    skipped,
    bounds: min && max ? { min, max } : null,
    diagnostics,
    committed: false,
  };
}

/**
 * Materialize a recipe into a structure as one verified operation group.
 *
 * The merge with existing terrain is measured per column: ground above the
 * target is **cut**, ground below it is **filled**, and both totals are
 * reported. Doing this with a plain `max()` is what turns every merge into a
 * spoil heap and leaves cliffs where a slope was asked for.
 *
 * Planning, validation and commit happen inside this call: a refused plan
 * leaves the model untouched instead of half-carved.
 */
export function buildTerrain(
  kit: ConstructionTarget & { s: Structure },
  recipe: TerrainRecipe,
  options: TerrainBuildOptions,
): TerrainBuildReport {
  let recorded = emptyTerrainReport();
  const plan = planConstruction(kit.s, {
    id: typeof options.object === 'string' ? options.object : (options.object?.id ?? 'terrain'),
    object: options.object ?? { kind: 'terrain', id: 'recipe' },
    ...(options.protection ? { protection: options.protection } : {}),
    ...(options.rules ? { rules: options.rules } : {}),
    // Terrain owns the region it is told to build: it measures the cut and fill
    // itself, and what it may not touch is declared by where or protection.
    excavationAuthorized: true,
    build: (sink) => {
      recorded = recordTerrain(sink, recipe, options);
    },
  });
  if (!plan.feasible) return { ...recorded, filled: 0, committed: false, diagnostics: plan.diagnostics };
  const applied = commitConstruction(kit.s, plan);
  return {
    ...recorded,
    filled: applied.written,
    committed: true,
    diagnostics: plan.diagnostics,
    merges: plan.merges,
  };
}
