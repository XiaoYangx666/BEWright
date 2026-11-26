import type { State, Vec3 } from '../core/structure.js';
import { resolveMaterial, type AuthoringMaterial, type BlockKit } from './kit.js';
import { assertRect, coordinateRandom, unitInterval, type RectXZ } from './layout.js';

export type PlantChoice = Readonly<{
  weight: number;
  /** Bottom-to-top blocks. Supply both states for two-block plants. */
  blocks: readonly AuthoringMaterial[];
  soil?: (state: State | null, position: Vec3) => boolean;
}>;
export type PlantScatterSpec = RectXZ &
  Readonly<{
    /** Ground block Y, not the plant's Y. Null excludes the column. */
    surfaceY: number | ((x: number, z: number) => number | null);
    plants: readonly PlantChoice[];
    coverage?: number;
    seed?: number;
    minSpacing?: number;
    where?: (x: number, z: number) => boolean;
    /** Multiplies coverage; use a noise/patch function for flower drifts. */
    densityAt?: (x: number, z: number) => number;
  }>;

export type PlantScatterReport = Readonly<{
  placed: Vec3[];
  /** Rejected candidates by reason; excluded columns (where/null surface) are not counted. */
  skipped: { noSoil: number; noHeadroom: number };
}>;

/**
 * Plan against the original world, then place complete plants; never overwrite
 * occupied cells. With no minSpacing the scan places directly (no ranking);
 * spacing keeps a ranked pass so no corner is systematically favoured.
 */
export function scatterPlants(kit: BlockKit, spec: PlantScatterSpec): PlantScatterReport {
  assertRect(spec);
  const coverage = spec.coverage ?? 0.25,
    seed = spec.seed ?? 0,
    spacing = spec.minSpacing ?? 0;
  unitInterval(coverage, 'coverage');
  if (!Number.isSafeInteger(seed) || !Number.isFinite(spacing) || spacing < 0)
    throw new Error('Invalid plant seed/spacing');
  if (!spec.plants.length) throw new Error('At least one plant is required');
  const choices = spec.plants.map((plant) => {
    if (!Number.isFinite(plant.weight) || plant.weight <= 0 || !plant.blocks.length)
      throw new Error('Plants require positive weights and nonempty blocks');
    return { ...plant, blocks: plant.blocks.map((m) => resolveMaterial(m)) };
  });
  const total = choices.reduce((n, c) => n + c.weight, 0);
  if (!Number.isFinite(total)) throw new Error('Plant weight total must be finite');
  const skipped = { noSoil: 0, noHeadroom: 0 };
  // Columns are independent (one plant each, filters read only the scan state),
  // so without spacing the placement set cannot depend on traversal order.
  if (!spacing) {
    const placed: Vec3[] = [];
    for (let x = spec.x0; x <= spec.x1; x++)
      for (let z = spec.z0; z <= spec.z1; z++) {
        if (spec.where && !spec.where(x, z)) continue;
        const y = typeof spec.surfaceY === 'number' ? spec.surfaceY : spec.surfaceY(x, z);
        if (y === null) continue;
        if (!Number.isSafeInteger(y)) throw new Error('surfaceY must return an integer or null');
        const density = spec.densityAt?.(x, z) ?? 1;
        unitInterval(density, 'densityAt');
        if (coordinateRandom(x, y, z, seed, 0) >= coverage * density) continue;
        let sample = coordinateRandom(x, y, z, seed, 1) * total;
        const choice = choices.find((c) => (sample -= c.weight) < 0) ?? choices.at(-1)!;
        const soil = kit.get(x, y, z);
        if (!(choice.soil ? choice.soil(soil, [x, y, z]) : soil?.name === 'minecraft:grass_block')) {
          skipped.noSoil++;
          continue;
        }
        if (choice.blocks.some((_, i) => !kit.empty(x, y + 1 + i, z))) {
          skipped.noHeadroom++;
          continue;
        }
        choice.blocks.forEach((block, i) => kit.put(x, y + 1 + i, z, block));
        placed.push([x, y + 1, z]);
      }
    return { placed, skipped };
  }
  const candidates: { position: Vec3; blocks: State[]; rank: number }[] = [];
  for (let x = spec.x0; x <= spec.x1; x++)
    for (let z = spec.z0; z <= spec.z1; z++) {
      if (spec.where && !spec.where(x, z)) continue;
      const y = typeof spec.surfaceY === 'number' ? spec.surfaceY : spec.surfaceY(x, z);
      if (y === null) continue;
      if (!Number.isSafeInteger(y)) throw new Error('surfaceY must return an integer or null');
      const density = spec.densityAt?.(x, z) ?? 1;
      unitInterval(density, 'densityAt');
      if (coordinateRandom(x, y, z, seed, 0) >= coverage * density) continue;
      let sample = coordinateRandom(x, y, z, seed, 1) * total;
      const choice = choices.find((c) => (sample -= c.weight) < 0) ?? choices.at(-1)!;
      const soil = kit.get(x, y, z);
      if (!(choice.soil ? choice.soil(soil, [x, y, z]) : soil?.name === 'minecraft:grass_block')) {
        skipped.noSoil++;
        continue;
      }
      if (choice.blocks.some((_, i) => !kit.empty(x, y + 1 + i, z))) {
        skipped.noHeadroom++;
        continue;
      }
      candidates.push({ position: [x, y + 1, z], blocks: choice.blocks, rank: coordinateRandom(x, y, z, seed, 2) });
    }
  // Priority order avoids always favouring one corner when enforcing spacing.
  candidates.sort((a, b) => a.rank - b.rank || a.position[0] - b.position[0] || a.position[2] - b.position[2]);
  const placed: Vec3[] = [],
    buckets = new Map<string, Vec3[]>();
  const bucketSize = Math.max(1, spacing);
  for (const { position, blocks } of candidates) {
    const [x, y, z] = position,
      bx = Math.floor(x / bucketSize),
      bz = Math.floor(z / bucketSize);
    let near = false;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        if (buckets.get(`${bx + dx},${bz + dz}`)?.some((p) => Math.hypot(p[0] - x, p[2] - z) < spacing)) near = true;
    if (near) continue;
    blocks.forEach((block, i) => kit.put(x, y + i, z, block));
    placed.push(position);
    const key = `${bx},${bz}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(position);
  }
  return { placed, skipped };
}
