import nbt, { type Compound } from 'prismarine-nbt';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { TARGET } from '../../blocks/target.js';
import { configuredWorldsDir } from '../../project/config.js';
import { validateWorldFolderName } from '../../project/paths.js';
import { requireSidecar, runSidecar, sidecarBinary } from '../../project/sidecar.js';

const runTasklist = promisify(execFile);

export async function minecraftRunning(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  for (const image of ['Minecraft.Windows.exe', 'bedrock_server.exe']) {
    const { stdout } = await runTasklist('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], {
      windowsHide: true,
      timeout: 4000,
    }).catch((error: Error) => {
      throw new Error('Could not check whether Minecraft is running. For an isolated new world, use --local.', { cause: error });
    });
    if (stdout.toLowerCase().includes(image.toLowerCase())) return image;
  }
  return undefined;
}

export type NewWorldOptions = {
  parentDir: string;
  name: string;
  folderName?: string;
  spawn?: readonly [number, number, number];
  seed?: number;
  timeOfDay?: number;
  marker?: Record<string, unknown>;
};

export type CreatedWorld = {
  world: string;
  folderName: string;
  name: string;
  spawn: [number, number, number];
  seed: number;
};

const FLAT_LAYERS = {
  biome_id: 1,
  block_layers: [
    { block_name: 'minecraft:bedrock', count: 1 },
    { block_name: 'minecraft:dirt', count: 2 },
    { block_name: 'minecraft:grass_block', count: 1 },
  ],
  encoding_version: 6,
  structure_options: null,
  world_version: 'version.post_1_18',
};

export async function defaultMinecraftWorldsDir() {
  const configured = await configuredWorldsDir('bedrock');
  if (configured) return configured;
  if (process.platform !== 'win32')
    throw new Error('Automatic Bedrock world discovery only supports Windows; pass --worlds-dir explicitly');
  const usersRoot = resolve(homedir(), 'AppData', 'Roaming', 'Minecraft Bedrock', 'Users');
  return await readdirFirst(usersRoot);
}

async function readdirFirst(usersRoot: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  for (const user of (await readdir(usersRoot, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    const candidate = join(usersRoot, user.name, 'games', 'com.mojang', 'minecraftWorlds');
    if ((await stat(candidate).catch(() => undefined))?.isDirectory()) return candidate;
  }
  throw new Error(`No Bedrock minecraftWorlds directory found under ${usersRoot}; pass --worlds-dir explicitly`);
}

export function worldInitBinary() {
  return sidecarBinary('blockwright-world-init');
}

function longParts(value: number): [number, number] {
  const big = BigInt(Math.trunc(value));
  return [Number((big >> 32n) & 0xffffffffn), Number(big & 0xffffffffn)];
}

function stamp() {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
}

export async function createBedrockWorld(options: NewWorldOptions): Promise<CreatedWorld> {
  const name = options.name?.trim();
  if (!name) throw new Error('World name is required');
  const folderName = validateWorldFolderName(options.folderName ?? `BEWright-${stamp()}-${randomUUID().slice(0, 8)}`);
  const binary = requireSidecar('blockwright-world-init');
  const parent = resolve(options.parentDir);
  await mkdir(parent, { recursive: true });
  const world = join(parent, folderName);
  if (await stat(world).catch(() => undefined)) throw new Error(`Target world directory already exists: ${world}`);
  const spawnPoint: [number, number, number] = [...(options.spawn ?? [0, -60, 0])];
  const seed = options.seed ?? 0;
  const version = [...TARGET.gameVersion.split('.').map(Number), 0, 0];
  const metadata: Compound['value'] = {
    LevelName: nbt.string(name),
    StorageVersion: nbt.int(10),
    Generator: nbt.int(2),
    GameType: nbt.int(1),
    Difficulty: nbt.int(0),
    SpawnX: nbt.int(spawnPoint[0]),
    SpawnY: nbt.int(spawnPoint[1]),
    SpawnZ: nbt.int(spawnPoint[2]),
    spawnradius: nbt.int(0),
    RandomSeed: nbt.long(longParts(seed)),
    Time: nbt.long(longParts(options.timeOfDay ?? 6000)),
    LastPlayed: nbt.long([0, Math.floor(Date.now() / 1000)] as [number, number]),
    commandsEnabled: nbt.byte(1),
    cheatsEnabled: nbt.byte(1),
    hasBeenLoadedInCreative: nbt.byte(1),
    doMobSpawning: nbt.byte(0),
    dodaylightcycle: nbt.byte(0),
    doweathercycle: nbt.byte(0),
    spawnMobs: nbt.byte(0),
    isMultiplayerGame: nbt.byte(0),
    LANBroadcast: nbt.byte(0),
    isFromWorldTemplate: nbt.byte(0),
    isFromLockedTemplate: nbt.byte(0),
    ForceGameType: nbt.byte(1),
    immutableWorld: nbt.byte(0),
    lastOpenedWithVersion: { type: 'list', value: { type: 'int', value: version } },
    MinimumCompatibleClientVersion: { type: 'list', value: { type: 'int', value: version } },
    FlatWorldLayers: nbt.string(JSON.stringify(FLAT_LAYERS)),
  };
  const payload = nbt.writeUncompressed({ name: '', type: 'compound', value: metadata }, 'little');
  const header = Buffer.alloc(8);
  header.writeInt32LE(10);
  header.writeInt32LE(payload.length, 4);
  await mkdir(world, { recursive: false });
  await writeFile(join(world, 'level.dat'), Buffer.concat([header, payload]));
  await writeFile(join(world, 'levelname.txt'), name);
  if (options.marker)
    await writeFile(
      join(world, 'blockwright-world.json'),
      JSON.stringify({ createdBy: 'blockwright', createdAt: new Date().toISOString(), ...options.marker }, null, 2),
    );
  await runSidecar(binary, [world]);
  return { world, folderName, name, spawn: spawnPoint, seed };
}
