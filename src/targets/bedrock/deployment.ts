import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inverseTransformPosition, transform, transformBox } from '../../authoring/transform.js';
import type { ContentOptions } from '../../content/discover.js';
import { prepareModel } from '../../content/model.js';
import { composeWorldLayout, readWorldLayout } from '../../content/world-layout.js';
import { AIR, CHUNK, contains, Structure, type Box, type State, type Vec3 } from '../../core/structure.js';
import type { DeploymentLayer, DeploymentTarget } from '../../project/deployment-target.js';
import { CACHE_ROOT, PROJECT_ROOT, WORLD_ROOT, within } from '../../project/paths.js';
import { minecraftRunning } from './create.js';
import { readWorldBlocks } from './readback.js';
import { directStructureStream, nextWorldBackupPath, validateDirectStructure, writeStructureToWorld } from './world.js';

type Layout = Awaited<ReturnType<typeof readWorldLayout>>;
type ConflictPolicy = 'stop' | 'keep-world' | 'use-source';

export function selectInstances(layout: Layout, ids: readonly string[]) {
  const all = layout.placements.map(({ id }) => id);
  for (const id of ids) if (!all.includes(id)) throw new Error(`Unknown placement id: ${id}`);
  return ids.length ? all.filter((id) => ids.includes(id)) : all;
}

export async function generateDeploymentLayers(
  layout: Layout,
  content: ContentOptions,
  selected: readonly string[],
  base?: readonly DeploymentLayer[],
) {
  // An omitted instance keeps its deployed layer, including its placement and
  // priority. Applying a changed instance order is a full-layout operation.
  if (
    base &&
    selected.length < layout.placements.length &&
    JSON.stringify(base.map(({ id }) => id)) !== JSON.stringify(layout.placements.map(({ id }) => id))
  )
    throw new Error('The layout placement list changed. Deploy the full layout to add, remove, or reorder instances.');
  const layers: DeploymentLayer[] = [];
  for (const placement of layout.placements) {
    if (!selected.includes(placement.id)) {
      if (base) layers.push(base.find(({ id }) => id === placement.id)!);
      continue;
    }
    const {
      world,
      placements: [result],
    } = await composeWorldLayout(
      { ...layout, placements: [placement] },
      {
        edition: 'bedrock',
        content,
        only: [],
        skipAir: false,
        meshVersions: false,
        allowEmpty: true,
      },
    );
    layers.push({
      id: placement.id,
      world,
      bounds: result.bounds,
      offset: result.offset,
      rotation: placement.rotation,
    });
  }
  return layers;
}

function combined(layers: readonly DeploymentLayer[]) {
  const world = new Structure(false);
  for (const layer of layers) world.paste(layer.world, [0, 0, 0]);
  if (world.chunks.size === 0) return world;
  return prepareModel(world, enclosingBox(layers.map(({ bounds }) => bounds)), { connections: 'bedrock' });
}

function enclosingBox(boxes: readonly Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], box.min[i]);
      max[i] = Math.max(max[i], box.max[i]);
    }
  }
  return { min, max };
}

const stateKeys = new WeakMap<State, string>();

function stateKey(state: State | null | undefined) {
  if (!state) return '';
  const cached = stateKeys.get(state);
  if (cached !== undefined) return cached;
  const name = state.name === 'minecraft:chain' ? 'minecraft:iron_chain' : state.name;
  const states = Object.entries(state.states)
    .filter(([key]) => {
      const property = key.replace(/^minecraft:/, '');
      if (name.endsWith('_stairs') && property === 'corner') return false;
      const connects = name.endsWith('_fence') || name.endsWith('_pane') || name === 'minecraft:iron_bars';
      return !connects || !/^connection_(east|north|south|west)$/.test(property);
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value]);
  const result = JSON.stringify([name, states]);
  stateKeys.set(state, result);
  return result;
}

function equal(a: State | null | undefined, b: State | null | undefined) {
  return a === b || stateKey(a) === stateKey(b);
}

function location(layers: readonly DeploymentLayer[], position: Vec3) {
  const layer =
    layers.findLast(({ world }) => world.getId(...position)) ??
    layers.findLast(({ bounds }) => contains(bounds, ...position));
  return layer
    ? {
        position,
        instance: layer.id,
        local: inverseTransformPosition(position, transform(layer.rotation), [0, 0, 0], layer.offset),
      }
    : { position, instance: null, local: null };
}

export async function diffDeployment(
  target: DeploymentTarget,
  layers: DeploymentLayer[],
  selected: readonly string[],
  limit: number,
) {
  const scope = layers.filter(({ id }) => selected.includes(id));
  const regions = scope.map(({ bounds }) => bounds);
  const source = combined(layers);
  const live = await readWorldBlocks(target.world, regions);
  const counts = { same: 0, changed: 0, missing: 0, filled: 0, unowned: 0 };
  type Kind = Exclude<keyof typeof counts, 'same'>;
  type Sample = ReturnType<typeof location> & { source: State | null; world: State };
  const samples: Record<Kind, Sample[]> = { changed: [], missing: [], filled: [], unowned: [] };
  const groups = new Map<string, { kind: Kind; source: string | null; world: string; cells: number }>();
  const track = (kind: Kind, position: Vec3, expected: State | null, actual: State) => {
    counts[kind]++;
    const key = JSON.stringify([kind, expected?.name, actual.name]);
    const group = groups.get(key);
    if (group) group.cells++;
    else groups.set(key, { kind, source: expected?.name ?? null, world: actual.name, cells: 1 });
    if (samples[kind].length < limit)
      samples[kind].push({ ...location(expected ? layers : scope, position), source: expected, world: actual });
  };
  source.forEach((x, y, z, id) => {
    if (!regions.some((region) => contains(region, x, y, z))) return;
    const expected = source.palette[id]!;
    const actual = live.get(x, y, z) ?? AIR;
    if (equal(expected, actual)) counts.same++;
    else
      track(
        actual.name === AIR.name ? 'missing' : expected.name === AIR.name ? 'filled' : 'changed',
        [x, y, z],
        expected,
        actual,
      );
  });
  live.forEach((x, y, z, id) => {
    if (source.getId(x, y, z) === 0) track('unowned', [x, y, z], null, live.palette[id]!);
  });
  return {
    target: target.name,
    world: target.world,
    instances: selected,
    counts,
    groups: [...groups.values()].sort((a, b) => b.cells - a.cells),
    samples,
  };
}

export async function planDeployment(
  target: DeploymentTarget,
  base: readonly DeploymentLayer[],
  next: readonly DeploymentLayer[],
  { policy, clearRemoved, limit }: { policy: ConflictPolicy; clearRemoved: boolean; limit: number },
) {
  const before = combined(base);
  const after = combined(next);
  const changes = new Structure(false);
  let released = 0;
  after.forEach((x, y, z, id) => {
    if (!equal(before.get(x, y, z), after.palette[id])) changes.set(x, y, z, after.palette[id]);
  });
  before.forEach((x, y, z) => {
    if (after.getId(x, y, z) !== 0) return;
    if (clearRemoved) changes.set(x, y, z, AIR);
    else released++;
  });
  // A small edit reads just the affected subchunks, even in a large layout.
  const regions = [...changes.chunks.values()].map(({ origin }) => ({
    min: origin,
    max: origin.map((value) => value + CHUNK) as Vec3,
  }));
  const live = await readWorldBlocks(target.world, regions);
  const patch = new Structure(false);
  const expected = new Structure(false);
  const counts = { write: 0, alreadyApplied: 0, conflicts: 0, released };
  const conflicts: (ReturnType<typeof location> & { before: State | null; source: State; world: State })[] = [];
  const apply = (x: number, y: number, z: number, from: State, to: State) => {
    patch.set(x, y, z, to);
    expected.set(x, y, z, from);
    counts.write++;
  };
  changes.forEach((x, y, z, id) => {
    const source = changes.palette[id]!;
    const old = before.get(x, y, z) ?? null;
    const actual = live.get(x, y, z) ?? AIR;
    if (equal(source, actual)) counts.alreadyApplied++;
    else if (equal(old ?? AIR, actual)) apply(x, y, z, actual, source);
    else {
      counts.conflicts++;
      if (conflicts.length < limit)
        conflicts.push({
          ...location(after.getId(x, y, z) ? next : base, [x, y, z]),
          before: old,
          source,
          world: actual,
        });
      if (policy === 'use-source') apply(x, y, z, actual, source);
    }
  });
  const writeRegions = [...patch.chunks.values()].map(({ origin }) => ({
    min: origin,
    max: origin.map((value) => value + CHUNK) as Vec3,
  }));
  const writeBounds = counts.write ? enclosingBox(writeRegions) : undefined;
  if (writeBounds) validateDirectStructure(patch, writeBounds);
  return {
    patch,
    expected,
    writeBounds,
    counts,
    conflicts,
    blocked: policy === 'stop' && counts.conflicts > 0,
  };
}

export async function applyDeployment(
  target: DeploymentTarget,
  plan: Awaited<ReturnType<typeof planDeployment>>,
  backupDir?: string,
) {
  if (plan.blocked) throw new Error('Resolve deployment conflicts first');
  if (!plan.writeBounds) return { placedBlocks: 0, checkedBlocks: 0 };
  const running = !within(WORLD_ROOT, target.world) && (await minecraftRunning());
  if (running) throw new Error(`${running} is running; close it before deploying to ${target.world}`);
  const backupRoot = resolve(backupDir ?? join(PROJECT_ROOT, '.bewright', 'backups', target.name));
  if (within(target.world, backupRoot)) throw new Error('The backup directory must be outside the target world');
  const backupPath = await nextWorldBackupPath(target.world, backupRoot);
  const region = plan.writeBounds;
  await mkdir(CACHE_ROOT, { recursive: true });
  const directory = await mkdtemp(join(CACHE_ROOT, 'world-deploy-'));
  try {
    const expectedFile = join(directory, 'expected');
    const expected = directStructureStream(plan.expected, region, { worldSnapshot: true });
    await pipeline(Readable.from(expected.chunks), createWriteStream(expectedFile, { flags: 'wx' }));
    const report = await writeStructureToWorld(plan.patch, region, {
      world: target.world,
      position: region.min,
      backup: false,
      skipEmptyChunks: true,
      expectedFile,
      backupDestination: backupPath,
      verify: true,
    });
    const verification = report.verification;
    if (verification?.cells !== plan.counts.write || verification.matched !== plan.counts.write) {
      const sample = verification?.samples[0];
      const at = sample ? ` at ${sample.x},${sample.y},${sample.z}` : '';
      throw new Error(`Written block states did not verify${at} (${verification?.matched ?? 0}/${plan.counts.write})`);
    }
    return { ...report, backupPath, checkedBlocks: verification.matched };
  } catch (error) {
    const backup = (await stat(backupPath).catch(() => undefined))?.isDirectory()
      ? ` Pre-deployment backup: ${backupPath}.`
      : '';
    throw new Error(`Deployment failed.${backup} ${String(error)}`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
