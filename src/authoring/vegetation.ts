import { Structure, type State, type Vec3, type Box } from '../core/structure.js';
import { coordinateDiagnostic, type Diagnostic, type DiagnosticObject } from './diagnostics.js';
import { coordinateRandom } from './layout.js';
import { fieldSlope } from './terrain/fields.js';
import type { FieldSource } from './terrain/fields.js';
import { resolveMaterial, type AuthoringMaterial } from './kit.js';
import { collisionBoxes } from './traversal.js';
import { isTerrainSurface } from './surface.js';
import { planConstruction, commitConstruction, type ConstructionPlan, type ConstructionSink } from './construction.js';
import { auditOperationCells } from './placement/policy.js';
import type { ProtectionRegistry } from './protection.js';
import type { ProtectionRuleSet } from './rules.js';

/**
 * 植被群落：按生境权重分层生成。
 *
 * 分层是硬约束：**乔木 / 灌木 / 草花**各自独立控制密度、群聚尺度、间距与
 * 物种权重。上层先落，下层读取上层实际占用与新形成的冠幅，所以灌木不会长在
 * 树干里，草花也不会埋在树冠下。
 *
 * 报告候选数、成功数、实际覆盖，以及土壤、坡度、净空、冲突等拒绝原因——
 * 这些计数进入统一诊断，成为"生态检查"的证据，而不是靠肉眼看截图。
 *
 * 相同输入与种子必须可复现：所有随机都走 `coordinateRandom` 的独立通道。
 */

export const VEGETATION_RULES = {
  soil: 'vegetation.soil',
  slope: 'vegetation.slope',
  habitat: 'vegetation.habitat',
  headroom: 'vegetation.headroom',
  spacing: 'vegetation.spacing',
  crownConflict: 'vegetation.crown-conflict',
  support: 'vegetation.unsupported',
  protected: 'vegetation.protected',
} as const;

export type VegetationLayer = 'tree' | 'shrub' | 'ground';
export type PlantSite = Readonly<{
  position: Vec3;
  seed: number;
  moisture: number;
  exposure: number;
  slope: number;
  rise: number;
}>;
/** Local coordinates, rooted at 0,0,0. The whole component is accepted or rejected. */
export type PlantGenerator = (site: PlantSite) => Structure;

export type SpeciesSpec = Readonly<{
  id: string;
  weight: number;
  layer: VegetationLayer;
  /** Blocks this species occupies, bottom to top, relative to its base cell. */
  blocks?: readonly (string | State)[];
  /** Replaces the legacy vertical blocks list with an actual tree/shrub/component. */
  generate?: PlantGenerator;
  /** Trunk height in blocks, for trees (used by clearance and crown defaults). */
  height?: number;
  /** Crown radius in blocks; the engine reserves this much air. */
  crownRadius?: number;
  /** 0..1 preference for moisture; peaks at this value. */
  moisture?: number;
  /** 0..1 preference for exposure. */
  exposure?: number;
  /** Maximum terrain slope this species accepts. */
  maxSlope?: number;
  /** Minimum height above the base terrain field. */
  minRise?: number;
  /** Maximum height above the base terrain field. */
  maxRise?: number;
}>;

export type VegetationLayerSpec = Readonly<{
  layer: VegetationLayer;
  species: readonly SpeciesSpec[];
  /** 0..1 probability that a candidate column is attempted before other filters. */
  coverage: number;
  /** Feature size of the community patches, in blocks; 0 means uniform scatter. */
  patchScale?: number;
  /** 0..1 threshold on the patch field; patches below it are empty. */
  patchThreshold?: number;
  /** Optional smooth 0..1 patch field; replaces grid noise when supplied. */
  patch?: FieldSource;
  /** Minimum spacing between plants of this layer, in blocks. */
  minSpacing?: number;
  /** Independent random channel; layers must not share a channel. */
  seed: number;
}>;

export type VegetationSpec = Readonly<{
  id: string;
  /** Inclusive scan rectangle. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /**
   * Ground height for habitat and slope. Should normally read the **model**
   * (`(x, z) => surfaces.terrain(x, z)`), not the design height field: a field
   * that returns fractional heights puts plants at `floor(h)+1`, which lands
   * them inside the next column's terrain and rejects the whole layer for
   * "no headroom". A model-based source cannot disagree with the blocks.
   */
  height: FieldSource;
  /** Base height of the terrain; `rise = height - base`. */
  base: number;
  /** 0..1 moisture field; defaults to a constant 0.5. */
  moisture?: FieldSource;
  /** 0..1 exposure field; defaults to a constant 0.5. */
  exposure?: FieldSource;
  /** Soil predicate over the actual block under the plant. */
  soil?: (state: State | null, x: number, z: number) => boolean;
  /** Columns where plants may grow; true includes the column. */
  where?: (x: number, z: number) => boolean;
  /** Full generated footprint is tested, including crowns. */
  bounds?: Box;
  protection?: ProtectionRegistry;
  rules?: ProtectionRuleSet;
  /** Layers in application order; earlier layers reserve space first. */
  layers: readonly VegetationLayerSpec[];
  object?: DiagnosticObject | string;
}>;

export type VegetationRejection = Readonly<{
  reason: (typeof VEGETATION_RULES)[keyof typeof VEGETATION_RULES];
  count: number;
  samples: readonly Vec3[];
}>;

export type VegetationLayerReport = Readonly<{
  layer: VegetationLayer;
  candidates: number;
  placed: number;
  /** Placed cells divided by candidates, when candidates is nonzero. */
  coverage: number;
  bySpecies: Readonly<Record<string, number>>;
  rejected: readonly VegetationRejection[];
  footprintCells?: number;
  areaCoverage?: number;
}>;

export type VegetationReport = Readonly<{
  layers: readonly VegetationLayerReport[];
  placed: number;
  candidates: number;
  diagnostics: readonly Diagnostic[];
  committed: boolean;
  instances: readonly PlantInstance[];
}>;
export type PlantInstance = Readonly<{
  species: string;
  layer: VegetationLayer;
  root: Vec3;
  soil: State;
  cells: readonly Readonly<{ position: Vec3; state: State }>[];
}>;
export type VegetationPlan = Readonly<{ construction: ConstructionPlan; report: VegetationReport }>;

function constant(value: number): FieldSource {
  return () => value;
}

/**
 * Material -> complete state.
 *
 * Strings must go through `resolveMaterial`, which fills the pinned registry
 * defaults (`birch_log` needs `pillar_axis`, leaves need their two bits). Building
 * a bare `{ name, states: {} }` here would skip that and produce a state the
 * encoder rejects — the species table is written by the building, so it is the
 * framework's job to complete it.
 */
function toState(material: AuthoringMaterial): State {
  return resolveMaterial(material);
}

/** Habitat weight: how well a site suits a species, in [0,1]. */
export function habitatWeight(
  species: SpeciesSpec,
  site: { rise: number; slope: number; moisture: number; exposure: number },
): number {
  if (species.maxSlope !== undefined && site.slope > species.maxSlope) return 0;
  if (species.minRise !== undefined && site.rise < species.minRise) return 0;
  if (species.maxRise !== undefined && site.rise > species.maxRise) return 0;
  const affinity = (preference: number | undefined, actual: number) =>
    preference === undefined ? 1 : 1 - Math.min(1, Math.abs(preference - actual));
  return Math.max(0, affinity(species.moisture, site.moisture) * affinity(species.exposure, site.exposure));
}

type Candidate = Readonly<{
  x: number;
  z: number;
  y: number;
  species: SpeciesSpec;
  weight: number;
  rank: number;
  moisture: number;
  exposure: number;
  rise: number;
  slope: number;
}>;

/**
 * Record trees, shrubs and ground plants through the sparse construction view.
 * Later strata see earlier planned crowns and trunks; the target stays unchanged.
 */
export function recordVegetation(sink: ConstructionSink, world: Structure, spec: VegetationSpec): VegetationReport {
  const object: DiagnosticObject =
    typeof spec.object === 'string'
      ? { kind: 'vegetation', id: spec.object }
      : (spec.object ?? { kind: 'vegetation', id: spec.id });
  const diagnostics: Diagnostic[] = [];
  const layerReports: VegetationLayerReport[] = [];
  const instances: PlantInstance[] = [];
  const moistureField = spec.moisture ?? constant(0.5);
  const exposureField = spec.exposure ?? constant(0.5);
  let placedTotal = 0;
  let candidateTotal = 0;

  for (const layer of spec.layers) {
    const active = layer.species.filter((species) => species.layer === layer.layer && species.weight > 0);
    if (!active.length) throw new Error(`Vegetation layer ${layer.layer} has no species with a positive weight`);
    const rejections = new Map<string, { reason: VegetationRejection['reason']; count: number; samples: Vec3[] }>();
    const reject = (reason: VegetationRejection['reason'], cell: Vec3) => {
      const existing = rejections.get(reason);
      if (existing) {
        existing.count++;
        if (existing.samples.length < 8) existing.samples.push(cell);
      } else rejections.set(reason, { reason, count: 1, samples: [cell] });
    };
    const candidates: Candidate[] = [];
    let layerCandidates = 0;

    for (let x = spec.x0; x <= spec.x1; x++)
      for (let z = spec.z0; z <= spec.z1; z++) {
        if (spec.where && !spec.where(x, z)) continue;
        const rawHeight = spec.height(x, z);
        if (!Number.isFinite(rawHeight)) continue;
        const height = Math.floor(rawHeight);
        const rise = height - spec.base;
        const slope = fieldSlope({ id: 'h', at: spec.height }, x, z);
        const moisture = moistureField(x, z);
        let exposure = exposureField(x, z);
        if (layer.layer !== 'tree')
          for (let y = height + 2; y <= height + 16; y++)
            if (sink.get(x, y, z)?.name.endsWith('_leaves')) {
              exposure *= 0.4;
              break;
            }
        // Community patches: a smooth field gates whole neighbourhoods, so the
        // result reads as groves rather than evenly sprinkled dots.
        const patch = layer.patch
          ? layer.patch(x, z)
          : layer.patchScale
            ? coordinateRandom(
                Math.floor(x / Math.max(1, layer.patchScale)),
                0,
                Math.floor(z / Math.max(1, layer.patchScale)),
                layer.seed,
                7,
              )
            : 1;
        if (layer.patchThreshold !== undefined && patch < layer.patchThreshold) continue;
        const density = layer.coverage * (layer.patchScale ? 0.35 + 0.65 * patch : 1);
        if (coordinateRandom(x, height, z, layer.seed, 0) >= density) continue;
        layerCandidates++;

        const ground = sink.get(x, height, z);
        if (!(spec.soil ? spec.soil(ground, x, z) : isTerrainSurface(ground?.name ?? null))) {
          reject(VEGETATION_RULES.soil, [x, height, z]);
          continue;
        }
        const choices = active
          .map((species) => ({
            species,
            weight: species.weight * habitatWeight(species, { rise, slope, moisture, exposure }),
          }))
          .filter((entry) => entry.weight > 0);
        if (!choices.length) {
          reject(VEGETATION_RULES.habitat, [x, height, z]);
          continue;
        }
        const choiceTotal = choices.reduce((sum, entry) => sum + entry.weight, 0);
        let sample = coordinateRandom(x, height, z, layer.seed, 1) * choiceTotal;
        const chosen = choices.find((entry) => (sample -= entry.weight) < 0) ?? choices.at(-1)!;
        candidates.push({
          x,
          z,
          y: height + 1,
          species: chosen.species,
          weight: chosen.weight,
          rank: coordinateRandom(x, height, z, layer.seed, 2),
          moisture,
          exposure,
          rise,
          slope,
        });
      }

    // Spacing keeps the highest-ranked candidates and drops crowded ones.
    candidates.sort((a, b) => a.rank - b.rank || a.x - b.x || a.z - b.z);
    const bySpecies: Record<string, number> = {};
    let placed = 0;
    /*
     * Spacing is enforced by scanning the integer offsets inside the spacing
     * radius that have already been accepted, rather than by hashing into
     * buckets. Buckets need their own search radius to agree with the spacing
     * radius, and getting that wrong let plants one block apart through in a
     * layer that asked for three. Offsets are exact and the radius is small, so
     * the direct lookup is both correct and cheap.
     */
    const spacing = layer.minSpacing ?? 0;
    const radius = Math.ceil(spacing);
    const accepted = new Set<string>();
    const tooClose = (x: number, z: number): boolean => {
      if (spacing <= 0) return false;
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx === 0 && dz === 0) continue;
          if (!accepted.has(`${x + dx},${z + dz}`)) continue;
          if (Math.hypot(dx, dz) < spacing) return true;
        }
      return false;
    };
    for (const candidate of candidates) {
      if (tooClose(candidate.x, candidate.z)) {
        reject(VEGETATION_RULES.spacing, [candidate.x, candidate.y, candidate.z]);
        continue;
      }
      const local =
        candidate.species.generate?.({
          position: [candidate.x, candidate.y, candidate.z],
          seed: Math.floor(coordinateRandom(candidate.x, candidate.y, candidate.z, layer.seed, 41) * 0x7fffffff),
          moisture: candidate.moisture,
          exposure: candidate.exposure,
          slope: candidate.slope,
          rise: candidate.rise,
        }) ?? new Structure();
      if (!candidate.species.generate)
        (candidate.species.blocks ?? []).map(toState).forEach((b, i) => local.set(0, i, 0, b));
      const writes: { position: Vec3; state: State }[] = [];
      local.forEach((x, y, z, id) => {
        const state = toState(local.palette[id]!);
        if (state.name === 'minecraft:air') throw new Error('Plant components must not carve air');
        writes.push({ position: [candidate.x + x, candidate.y + y, candidate.z + z], state });
      });
      if (!writes.length || !local.get(0, 0, 0))
        throw new Error(`Species ${candidate.species.id} must contain a root at local 0,0,0`);
      if (candidate.species.generate && !connectedPlant(writes, [candidate.x, candidate.y, candidate.z]))
        throw new Error(`Species ${candidate.species.id} contains disconnected branches or foliage`);
      const outside = writes.find(
        ({ position: p }) =>
          p[0] < spec.x0 ||
          p[0] > spec.x1 ||
          p[2] < spec.z0 ||
          p[2] > spec.z1 ||
          (spec.where && !spec.where(p[0], p[2])) ||
          (spec.bounds && p.some((v, axis) => v < spec.bounds!.min[axis] || v >= spec.bounds!.max[axis])),
      );
      if (outside) {
        reject(VEGETATION_RULES.protected, outside.position);
        continue;
      }
      const audit = auditOperationCells(world, {
        object,
        writes,
        carves: [],
        protection: spec.protection,
        rules: spec.rules,
      });
      if (audit.violations.length) {
        reject(VEGETATION_RULES.protected, audit.violations[0]!.cell);
        continue;
      }
      const blocks = candidate.species.generate ? [] : (candidate.species.blocks ?? []);
      const componentConflict = writes.find(({ position: p }) => {
        const s = sink.get(...p);
        return s && s.name !== 'minecraft:air';
      });
      if (componentConflict) {
        reject(VEGETATION_RULES.headroom, componentConflict.position);
        continue;
      }
      // Crown reservation for trees: the declared radius must be clear so the
      // canopy does not grow through a roof or a neighbouring trunk.
      const crown = candidate.species.crownRadius ?? 0;
      if (crown > 0 && !candidate.species.generate) {
        let conflict: Vec3 | null = null;
        const top = candidate.y + (candidate.species.height ?? blocks.length) + 1;
        for (let dx = -crown; dx <= crown && !conflict; dx++)
          for (let dz = -crown; dz <= crown && !conflict; dz++)
            for (let y = candidate.y; y <= top; y++) {
              const state = sink.get(candidate.x + dx, y, candidate.z + dz);
              if (!state || state.name === 'minecraft:air') continue;
              const collision = collisionBoxes(state);
              if (collision.kind === 'supported' && collision.boxes.length === 0) continue;
              conflict = [candidate.x + dx, y, candidate.z + dz];
              break;
            }
        if (conflict) {
          reject(VEGETATION_RULES.crownConflict, conflict);
          continue;
        }
      }
      // Support: the plant must stand on ground, never on another plant's leaves.
      const support = sink.get(candidate.x, candidate.y - 1, candidate.z);
      const supportCollision = collisionBoxes(support);
      if (!support || supportCollision.kind !== 'supported' || !supportCollision.boxes.some((box) => box[4] >= 0.5)) {
        reject(VEGETATION_RULES.support, [candidate.x, candidate.y - 1, candidate.z]);
        continue;
      }
      for (const write of writes) sink.put(...write.position, write.state, {}, 'object');
      instances.push({
        species: candidate.species.id,
        layer: layer.layer,
        root: [candidate.x, candidate.y, candidate.z],
        soil: support,
        cells: writes,
      });
      placed++;
      accepted.add(`${candidate.x},${candidate.z}`);
      bySpecies[candidate.species.id] = (bySpecies[candidate.species.id] ?? 0) + 1;
    }

    placedTotal += placed;
    candidateTotal += layerCandidates;
    layerReports.push({
      layer: layer.layer,
      candidates: layerCandidates,
      placed,
      coverage: layerCandidates ? placed / layerCandidates : 0,
      bySpecies,
      rejected: [...rejections.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      footprintCells: new Set(
        instances
          .filter((p) => p.layer === layer.layer)
          .flatMap((p) => p.cells.map((c) => `${c.position[0]},${c.position[2]}`)),
      ).size,
      areaCoverage:
        new Set(
          instances
            .filter((p) => p.layer === layer.layer)
            .flatMap((p) => p.cells.map((c) => `${c.position[0]},${c.position[2]}`)),
        ).size /
        ((spec.x1 - spec.x0 + 1) * (spec.z1 - spec.z0 + 1)),
    });
  }

  for (const report of layerReports) {
    for (const rejection of report.rejected)
      diagnostics.push(
        coordinateDiagnostic({
          rule: rejection.reason,
          severity: 'info',
          object,
          position: rejection.samples[0] ? [...rejection.samples[0]] : [0, 0, 0],
          message: `${report.layer} 层因${
            rejection.reason === VEGETATION_RULES.soil
              ? '土壤不符'
              : rejection.reason === VEGETATION_RULES.slope
                ? '坡度过陡'
                : rejection.reason === VEGETATION_RULES.habitat
                  ? '生境权重为 0'
                  : rejection.reason === VEGETATION_RULES.headroom
                    ? '净空被占'
                    : rejection.reason === VEGETATION_RULES.spacing
                      ? '间距不足'
                      : rejection.reason === VEGETATION_RULES.crownConflict
                        ? '冠幅冲突'
                        : rejection.reason === VEGETATION_RULES.support
                          ? '缺少支撑'
                          : '保护区限制'
          }拒绝 ${rejection.count} 株`,
          data: { layer: report.layer, reason: rejection.reason, count: rejection.count, samples: rejection.samples },
          source: 'vegetation',
        }),
      );
    diagnostics.push(
      coordinateDiagnostic({
        rule: 'vegetation.summary',
        severity: 'info',
        object,
        region: { min: [spec.x0, 0, spec.z0], max: [spec.x1 + 1, 1, spec.z1 + 1] },
        message: `${report.layer} 层：候选 ${report.candidates}，成功 ${report.placed}，候选成功率 ${(report.coverage * 100).toFixed(1)}%`,
        data: {
          layer: report.layer,
          candidates: report.candidates,
          placed: report.placed,
          bySpecies: report.bySpecies,
        },
        source: 'vegetation',
      }),
    );
  }

  for (const diagnostic of diagnostics) sink.report(diagnostic);
  return {
    layers: layerReports,
    placed: placedTotal,
    candidates: candidateTotal,
    diagnostics,
    instances,
    committed: false,
  };
}

function connectedPlant(cells: readonly { position: Vec3 }[], root: Vec3): boolean {
  const remaining = new Set(cells.map((c) => c.position.join(','))),
    queue = [root];
  remaining.delete(root.join(','));
  while (queue.length) {
    const p = queue.pop()!;
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      const n: Vec3 = [p[0] + d[0]!, p[1] + d[1]!, p[2] + d[2]!];
      if (remaining.delete(n.join(','))) queue.push(n);
    }
  }
  return remaining.size === 0;
}

export function checkVegetation(world: Pick<Structure, 'get'>, report: VegetationReport): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const plant of report.instances) {
    const missing = plant.cells.find((c) => {
      const actual = world.get(...c.position);
      return (
        !actual ||
        actual.name !== c.state.name ||
        Object.entries(c.state.states).some(([k, v]) => actual.states[k] !== v)
      );
    });
    if (missing)
      diagnostics.push(
        coordinateDiagnostic({
          rule: 'vegetation.component-damaged',
          object: plant.species,
          position: missing.position,
          message: '树形/群落构件不完整或状态发生变化',
        }),
      );
    const [x, y, z] = plant.root,
      soil = world.get(x, y - 1, z);
    const support = collisionBoxes(soil);
    if (soil?.name !== plant.soil.name || support.kind !== 'supported' || !support.boxes.some((b) => b[4] === 1))
      diagnostics.push(
        coordinateDiagnostic({
          rule: VEGETATION_RULES.support,
          object: plant.species,
          position: plant.root,
          severity: support.kind === 'unknown' ? 'unknown' : 'error',
          conclusive: support.kind !== 'unknown',
          message: '植物根部失去原有土壤或完整地面支撑',
        }),
      );
  }
  return diagnostics;
}

export function planVegetation(world: Structure, spec: VegetationSpec): VegetationPlan {
  let report: VegetationReport = {
    layers: [],
    placed: 0,
    candidates: 0,
    diagnostics: [],
    instances: [],
    committed: false,
  };
  const construction = planConstruction(world, {
    id: spec.id,
    object: spec.object ?? { kind: 'vegetation', id: spec.id },
    bounds: spec.bounds,
    protection: spec.protection,
    rules: spec.rules,
    build: (sink) => {
      report = recordVegetation(sink, world, spec);
      for (const d of checkVegetation(sink, report)) sink.report(d);
    },
  });
  return { construction, report: { ...report, diagnostics: construction.diagnostics } };
}

/** Compatibility entry, now atomic across all layers. */
export function growVegetation(world: Structure, spec: VegetationSpec): VegetationReport {
  const { construction, report } = planVegetation(world, spec);
  if (!construction.feasible)
    return {
      ...report,
      placed: 0,
      instances: [],
      layers: report.layers.map((l) => ({
        ...l,
        placed: 0,
        coverage: 0,
        bySpecies: {},
        footprintCells: 0,
        areaCoverage: 0,
      })),
    };
  commitConstruction(world, construction);
  return { ...report, committed: true };
}

/** Distances between placed plants, useful for "实际覆盖" assertions in tests. */
export function nearestNeighbourDistances(cells: readonly Vec3[]): number[] {
  const out: number[] = [];
  for (const [index, cell] of cells.entries()) {
    let best = Infinity;
    for (const [otherIndex, other] of cells.entries()) {
      if (index === otherIndex) continue;
      best = Math.min(best, Math.hypot(cell[0] - other[0], cell[2] - other[2]));
    }
    if (Number.isFinite(best)) out.push(best);
  }
  return out;
}
