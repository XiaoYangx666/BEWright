import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { transform, transformBox, transformPosition, transformState, type Rotation } from '../authoring/transform.js';
import { assertBox, block, Structure, type Box, type Vec3 } from '../core/structure.js';
import { resolveBuildingArgs, resolveTilePlan, type BuildingArgs } from './definition.js';
import { findBuilding, type ContentOptions } from './discover.js';
import { loadBuilding, type LoadedBuilding } from './load.js';
import { buildModel } from './model.js';

type Placement = {
  id: string;
  building: string;
  origin: Vec3;
  rotation: Rotation;
  params: BuildingArgs;
};

function object(value: unknown, label: string, fields?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = fields && Object.keys(record).find((key) => !fields.includes(key));
  if (unknown !== undefined) throw new Error(`Unknown ${label} field: ${JSON.stringify(unknown)}`);
  return record;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

export function isWorldCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}

function coordinates(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isWorldCoordinate))
    throw new Error(`${label} must be an array of three 32-bit integers`);
  return [value[0], value[1], value[2]];
}

export async function readWorldLayout(file: string) {
  const path = resolve(file);
  const raw: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  const layout = object(raw, 'layout', ['name', 'spawn', 'seed', 'placements']);
  const name = string(layout.name, 'layout.name');
  const spawn = coordinates(layout.spawn, 'layout.spawn');
  const seed = layout.seed === undefined ? 0 : layout.seed;
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw new Error('layout.seed must be an integer');
  if (!Array.isArray(layout.placements) || !layout.placements.length)
    throw new Error('layout.placements must be a nonempty array');
  const ids = new Set<string>();
  const placements = layout.placements.map((value, index): Placement => {
    const label = `layout.placements[${index}]`;
    const item = object(value, label, ['id', 'building', 'origin', 'rotation', 'params']);
    const id = string(item.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`Duplicate placement id: ${id}`);
    ids.add(id);
    const building = string(item.building, `${label}.building`);
    const origin = coordinates(item.origin, `${label}.origin`);
    const rotation = item.rotation === undefined ? 0 : item.rotation;
    if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270)
      throw new Error(`${label}.rotation must be 0, 90, 180, or 270`);
    const overrides = item.params === undefined ? {} : object(item.params, `${label}.params`);
    const params: Record<string, number | string | boolean> = Object.create(null);
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string')
        throw new Error(`${label}.params.${key} must be a number, boolean, or string`);
      params[key] = value;
    }
    return { id, building, origin, rotation, params };
  });
  return { path, name, spawn, seed, placements };
}

export function findLayoutBuilding(layoutPath: string, reference: string, options: ContentOptions) {
  const source = reference.startsWith('.') || /[\\/]/.test(reference) || reference === 'blockwright.building.json'
    ? resolve(dirname(layoutPath), reference)
    : reference;
  return findBuilding(source, options);
}

/** Accept repeatable and comma-separated placement ids (`--only a --only b,c`). */
export function normalizePlacementIds(values: readonly string[] | undefined) {
  return [...new Set((values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean))];
}

export async function composeWorldLayout(
  layout: Awaited<ReturnType<typeof readWorldLayout>>,
  options: {
    edition: 'bedrock' | 'java';
    content: ContentOptions;
    only: string[];
    except?: string[];
    skipAir: boolean;
    /** Off for one-shot imports: incremental preview bookkeeping is pure overhead. */
    meshVersions?: boolean;
  },
) {
  const selected = new Set(options.only);
  const excluded = new Set(options.except ?? []);
  for (const id of [...selected, ...excluded])
    if (!layout.placements.some((placement) => placement.id === id)) throw new Error(`Unknown placement id: ${id}`);
  const world = new Structure(options.meshVersions ?? true);
  const loaded = new Map<string, LoadedBuilding>();
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const results = [];
  let cells = 0;
  let explicitAir = 0;
  for (const placement of layout.placements) {
    if (selected.size && !selected.has(placement.id)) continue;
    if (excluded.has(placement.id)) continue;
    const reference = placement.building;
    let source = loaded.get(reference);
    if (!source) {
      source = await loadBuilding(await findLayoutBuilding(layout.path, reference, options.content));
      loaded.set(reference, source);
    }
    const { definition } = source;
    if (!(definition.editions ?? ['bedrock']).includes(options.edition))
      throw new Error(`Placement "${placement.id}": ${definition.id} does not declare the ${options.edition} edition`);
    const params = resolveBuildingArgs(definition.params, placement.params);
    const model = buildModel(definition, params).world;
    const region = (options.edition === 'bedrock' ? resolveTilePlan(definition.tiles, definition.bounds)?.placement.region : undefined)
      ?? definition.bounds;
    assertBox(region);
    const spec = transform(placement.rotation);
    const rotated = transformBox(region, spec);
    const offset = placement.origin.map((value, axis) => value - rotated.min[axis]) as Vec3;
    const bounds = { min: placement.origin, max: rotated.max.map((value, axis) => value + offset[axis]) as Vec3 };
    if (bounds.max.some((value) => !isWorldCoordinate(value - 1)))
      throw new Error(`Placement "${placement.id}" exceeds the world coordinate range`);
    const palette = new Map<number, number>();
    const identity = spec.rotation === 0 && spec.mirror === 'none';
    let placed = 0;
    let overlaps = 0;
    model.forEach((x, y, z, id) => {
      const state = model.palette[id]!;
      const air = state.name === 'minecraft:air';
      if (air && options.skipAir) return;
      // Unrotated placements dominate layout imports; skip the per-cell tuple
      // that transformPosition would allocate for a plain translation.
      let px: number, py: number, pz: number;
      if (identity) {
        px = x + offset[0];
        py = y + offset[1];
        pz = z + offset[2];
      } else {
        const point = transformPosition([x, y, z], spec, [0, 0, 0], offset);
        [px, py, pz] = point;
      }
      if (py < -64 || py > 319)
        throw new Error(`Placement "${placement.id}" exceeds the Overworld Y range -64..319 at ${px},${py},${pz}`);
      let mapped = palette.get(id);
      if (mapped === undefined) {
        const { states, untransformed, remapped } = transformState(state, spec);
        if (untransformed.length)
          throw new Error(`Placement "${placement.id}": cannot rotate ${state.name} state ${untransformed.join(', ')}`);
        mapped = world.intern(remapped ? block(state.name, states) : state);
        palette.set(id, mapped);
      }
      const previousId = world.getId(px, py, pz);
      if (previousId) {
        overlaps++;
        if (world.palette[previousId]?.name === 'minecraft:air') explicitAir--;
      } else {
        cells++;
      }
      if (air) explicitAir++;
      world.setId(px, py, pz, mapped);
      placed++;
      if (px < min[0]) min[0] = px;
      if (py < min[1]) min[1] = py;
      if (pz < min[2]) min[2] = pz;
      if (px + 1 > max[0]) max[0] = px + 1;
      if (py + 1 > max[1]) max[1] = py + 1;
      if (pz + 1 > max[2]) max[2] = pz + 1;
    }, region);
    results.push({ ...placement, building: definition.id, params, bounds, cells: placed, overlaps });
  }
  if (!cells) throw new Error('Selected placements contain no blocks to write');
  const bounds = { min, max };
  return { world, bounds, placements: results, cells, explicitAir };
}
