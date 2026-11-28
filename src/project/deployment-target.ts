import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isBuildingId } from '../content/discover.js';
import { type Box, Structure, type StructureSnapshot, type Vec3 } from '../core/structure.js';
import { validateWorldDirectory } from '../targets/bedrock/world.js';
import { atomicWrite, PROJECT_ROOT } from './paths.js';

const root = join(PROJECT_ROOT, '.bewright', 'targets');

type Binding = { layout: string; world: string };
export type DeploymentTarget = Binding & { name: string };
export type DeploymentLayer = { id: string; bounds: Box; offset: Vec3; rotation: 0 | 90 | 180 | 270; world: Structure };
type StoredLayer = Omit<DeploymentLayer, 'world'> & { world: StructureSnapshot };

function targetDirectory(name: string) {
  if (!isBuildingId(name)) throw new Error('Target name must be a lowercase slug');
  return join(root, name);
}

export async function deploymentTargets() {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const names = entries.filter((entry) => entry.isDirectory() && isBuildingId(entry.name)).map((entry) => entry.name);
  return await Promise.all(names.sort().map((name) => deploymentTarget(name)));
}

export async function deploymentTarget(name: string): Promise<DeploymentTarget> {
  const path = join(targetDirectory(name), 'target.json');
  const data = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Unknown target "${name}". Run "bewright target list" or "bewright target add".`);
  });
  const binding = JSON.parse(data) as Binding;
  return { name, layout: resolve(PROJECT_ROOT, binding.layout), world: resolve(PROJECT_ROOT, binding.world) };
}

export async function registerDeploymentTarget(name: string, layout: string, world: string) {
  const directory = targetDirectory(name);
  const binding = {
    layout: relative(PROJECT_ROOT, await realpath(layout)),
    world: relative(PROJECT_ROOT, await realpath(await validateWorldDirectory(world))),
  };
  await mkdir(root, { recursive: true });
  await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Target "${name}" already exists`);
  });
  try {
    await atomicWrite(join(directory, 'target.json'), JSON.stringify(binding, null, 2) + '\n');
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return deploymentTarget(name);
}

async function worldIdentity(world: string) {
  const directory = await realpath(await validateWorldDirectory(world));
  const db = await stat(join(directory, 'db'));
  return { directory, created: db.birthtimeMs, device: db.dev, inode: db.ino };
}

export async function readDeploymentBase(target: DeploymentTarget): Promise<DeploymentLayer[] | undefined> {
  const path = join(targetDirectory(target.name), 'base.bin.gz');
  const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!bytes) return undefined;
  const base = deserialize(gunzipSync(bytes)) as {
    version: number;
    world: Awaited<ReturnType<typeof worldIdentity>>;
    layers: StoredLayer[];
  };
  if (base.version !== 1 || !Array.isArray(base.layers)) throw new Error(`Unsupported deployment baseline: ${path}`);
  const current = await worldIdentity(target.world);
  if (JSON.stringify(base.world) !== JSON.stringify(current))
    throw new Error(
      `The saved baseline is for a different world directory. Register the replacement world under a new target.`,
    );
  return base.layers.map((layer) => ({ ...layer, world: Structure.fromSnapshot(layer.world) }));
}

export async function writeDeploymentBase(target: DeploymentTarget, layers: DeploymentLayer[]) {
  const data = {
    version: 1,
    world: await worldIdentity(target.world),
    layers: layers.map((layer): StoredLayer => ({ ...layer, world: layer.world.snapshot() })),
  };
  await atomicWrite(join(targetDirectory(target.name), 'base.bin.gz'), gzipSync(serialize(data), { level: 1 }));
}

/** Serializes adoption and baseline updates for the same workspace target. */
export async function withDeploymentLock<T>(target: DeploymentTarget, work: () => Promise<T>): Promise<T> {
  const lock = join(targetDirectory(target.name), 'deploy.lock');
  await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(
      `Deployment lock exists at ${lock}. If a deployment was interrupted, confirm it exited before removing the empty lock directory.`,
    );
  });
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
