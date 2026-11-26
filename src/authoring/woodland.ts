import { type Box, type Structure, type Vec3 } from '../core/structure.js';
import { StructureKit, type AuthoringMaterial } from './kit.js';
import { tree, leafCluster } from './tree.js';
import { coordinateRandom } from './layout.js';
import { SurfaceQuery } from './surface.js';
import { simplex2D } from './terrain/fields.js';
import {
  growVegetation,
  type PlantGenerator,
  type SpeciesSpec,
  type VegetationLayer,
  type VegetationSpec,
} from './vegetation.js';
import type { RoadPlan } from './roads.js';
import type { ProtectionRegistry } from './protection.js';

export type PlantForm = Readonly<{
  form: 'broadleaf' | 'pine' | 'shrub' | 'ground';
  trunk?: AuthoringMaterial;
  foliage: AuthoringMaterial;
  height?: number;
  radius?: number;
  variation?: number;
}>;

/** Composable component generator; custom species can instead supply their own PlantGenerator. */
export function plantGenerator(spec: PlantForm): PlantGenerator {
  const height = spec.height ?? (spec.form === 'pine' ? 11 : spec.form === 'broadleaf' ? 7 : 2);
  const radius = spec.radius ?? (spec.form === 'shrub' ? 2 : 3),
    variation = spec.variation ?? 1;
  if (
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(radius) ||
    radius < 1 ||
    !Number.isSafeInteger(variation) ||
    variation < 0 ||
    variation >= height
  )
    throw new Error('Plant dimensions must be positive bounded integers');
  return (site) => {
    const kit = new StructureKit();
    const h = Math.max(
      3,
      height + Math.floor(coordinateRandom(0, 0, 0, site.seed, 0) * (variation * 2 + 1)) - variation,
    );
    if (spec.form === 'ground') kit.put(0, 0, 0, spec.foliage);
    else if (spec.form === 'shrub') {
      kit.put(0, 0, 0, spec.trunk ?? spec.foliage);
      leafCluster(kit, { center: [0, 1, 0], radii: [radius, 1, radius], material: spec.foliage });
    } else {
      const crowns =
        spec.form === 'pine'
          ? [
              {
                center: [0, h - Math.max(1, Math.ceil((h - 3) / 2)), 0] as Vec3,
                radii: [radius, Math.max(1, Math.ceil((h - 3) / 2)), radius] as Vec3,
                shape: 'cone' as const,
                // A linear radius leaves several one-block layers at voxel scale.
                // Taper area instead, retaining shoulders below the single apex.
                contains: (x: number, y: number, z: number) => Math.abs(y) <= 1 && x * x + z * z <= (1 - y) / 2,
                material: spec.foliage,
              },
            ]
          : [
              {
                center: [0, h - 1, 0] as Vec3,
                radii: [radius, 2, Math.max(1, radius - 1)] as Vec3,
                material: spec.foliage,
              },
              {
                center: [coordinateRandom(0, 0, 0, site.seed, 3) < 0.5 ? -1 : 1, h, 1] as Vec3,
                radii: [Math.max(1, radius - 1), 2, Math.max(1, radius - 1)] as Vec3,
                material: spec.foliage,
              },
            ];
      const branches = [
        {
          path: [
            [0, 0, 0],
            [0, spec.form === 'pine' ? h - Math.max(1, Math.ceil((h - 3) / 2)) : h - 2, 0],
          ] as Vec3[],
          material: spec.trunk ?? 'oak_log',
        },
      ];
      if (spec.form === 'broadleaf')
        for (const [x, z] of [
          [2, 0],
          [-2, 0],
          [0, 2],
          [0, -2],
        ])
          branches.push({
            path: [
              [0, h - 2, 0],
              [x!, h - 1, z!],
            ],
            material: spec.trunk ?? 'oak_log',
          });
      tree(kit, { branches, crowns, collision: 'error' });
    }
    return kit.s;
  };
}

export type WoodlandSpec = Readonly<{
  id: string;
  bounds: Box;
  seed: number;
  baseY: number;
  density?: number;
  roads?: readonly RoadPlan[];
  /** Keep crowns out of these world boxes' X/Z footprints too (buildings/view corridors). */
  clearings?: readonly Box[];
  roadMargin?: number;
  protection?: ProtectionRegistry;
  species?: Partial<Readonly<Record<VegetationLayer, readonly SpeciesSpec[]>>>;
}>;

/** Habitat defaults derive from the final model. No landscape coordinates live in the recipe. */
export function woodlandSpec(world: Structure, input: WoodlandSpec): VegetationSpec {
  const { bounds } = input,
    density = input.density ?? 1,
    margin = input.roadMargin ?? 2;
  if (
    !Number.isFinite(density) ||
    density < 0 ||
    density > 2 ||
    !Number.isSafeInteger(margin) ||
    margin < 0 ||
    !Number.isSafeInteger(input.seed)
  )
    throw new Error('Invalid woodland density, margin or seed');
  const range = world.inspect().bounds;
  const surface = new SurfaceQuery(world, {
    minY: bounds.min[1],
    maxY: Math.max(bounds.max[1], range?.max[1] ?? 0),
    scanLimit: Math.max(48, bounds.max[1] - bounds.min[1] + 2),
    airStopsTerrain: false,
  });
  const excluded = new Set<string>();
  for (const road of input.roads ?? [])
    for (const c of road.cells)
      for (let dx = -margin; dx <= margin; dx++)
        for (let dz = -margin; dz <= margin; dz++)
          if (Math.hypot(dx, dz) <= margin) excluded.add(`${c.x + dx},${c.z + dz}`);
  const distance = new Map<string, number>(),
    queue: [number, number][] = [];
  const x0 = bounds.min[0],
    x1 = bounds.max[0] - 1,
    z0 = bounds.min[2],
    z1 = bounds.max[2] - 1;
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++)
      if (surface.water(x, z) !== null) {
        distance.set(`${x},${z}`, 0);
        queue.push([x, z]);
      }
  // Four-neighbour distance is an explicit habitat approximation, not water depth.
  for (let i = 0; i < queue.length; i++) {
    const [x, z] = queue[i]!,
      d = distance.get(`${x},${z}`)!;
    if (d >= 14) continue;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx!,
        nz = z + dz!,
        key = `${nx},${nz}`;
      if (nx < x0 || nx > x1 || nz < z0 || nz > z1 || distance.has(key)) continue;
      distance.set(key, d + 1);
      queue.push([nx, nz]);
    }
  }
  const where = (x: number, z: number) =>
    !excluded.has(`${x},${z}`) &&
    surface.water(x, z) === null &&
    !(input.clearings ?? []).some((b) => x >= b.min[0] && x < b.max[0] && z >= b.min[2] && z < b.max[2]);
  const defaults: Record<VegetationLayer, readonly SpeciesSpec[]> = {
    tree: [
      {
        id: 'broadleaf',
        layer: 'tree',
        weight: 2,
        maxSlope: 2.2,
        moisture: 0.65,
        generate: plantGenerator({ form: 'broadleaf', trunk: 'oak_log', foliage: 'oak_leaves' }),
      },
      {
        id: 'pine',
        layer: 'tree',
        weight: 1,
        maxSlope: 3.5,
        moisture: 0.25,
        generate: plantGenerator({
          form: 'pine',
          trunk: 'spruce_log',
          foliage: 'spruce_leaves',
          radius: 3,
          height: 11,
          variation: 2,
        }),
      },
    ],
    shrub: [
      {
        id: 'low-shrub',
        layer: 'shrub',
        weight: 1,
        maxSlope: 2,
        moisture: 0.8,
        exposure: 0.3,
        generate: plantGenerator({ form: 'shrub', foliage: 'azalea_leaves', trunk: 'oak_log', radius: 1 }),
      },
    ],
    ground: [
      {
        id: 'fern',
        layer: 'ground',
        weight: 2,
        moisture: 0.8,
        generate: plantGenerator({ form: 'ground', foliage: 'fern' }),
      },
      { id: 'grass', layer: 'ground', weight: 4, generate: plantGenerator({ form: 'ground', foliage: 'short_grass' }) },
      {
        id: 'flowers',
        layer: 'ground',
        weight: 0.4,
        moisture: 0.5,
        generate: plantGenerator({ form: 'ground', foliage: 'oxeye_daisy' }),
      },
    ],
  };
  return {
    id: input.id,
    x0,
    x1,
    z0,
    z1,
    bounds,
    base: input.baseY,
    protection: input.protection,
    height: (x, z) => surface.terrain(x, z) ?? NaN,
    moisture: (x, z) => Math.max(0, 1 - (distance.get(`${x},${z}`) ?? 14) / 14),
    exposure: (x, z) => Math.min(1, 0.4 + Math.max(0, (surface.terrain(x, z) ?? input.baseY) - input.baseY) / 24),
    soil: (s) =>
      !!s && ['minecraft:grass_block', 'minecraft:dirt', 'minecraft:coarse_dirt', 'minecraft:podzol'].includes(s.name),
    where,
    layers: (['tree', 'shrub', 'ground'] as const).map((layer, i) => {
      const noise = simplex2D(input.seed + i * 101),
        scale = [13, 7, 5][i]!;
      return {
        layer,
        seed: input.seed + i * 101,
        coverage: [0.1, 0.2, 0.45][i]! * density,
        minSpacing: [7, 3, 1][i]!,
        patchScale: scale,
        patchThreshold: [0.42, 0.52, 0.43][i]!,
        patch: (x: number, z: number) => (noise.at(x / scale, z / scale) + 1) / 2,
        species: input.species?.[layer] ?? defaults[layer],
      };
    }),
  };
}

export const growWoodland = (world: Structure, spec: WoodlandSpec) => growVegetation(world, woodlandSpec(world, spec));
