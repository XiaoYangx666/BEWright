import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareModel } from '../../content/model.js';
import { composeWorldLayout, isWorldCoordinate, readWorldLayout } from '../../content/world-layout.js';
import { CHUNK, type Box } from '../../core/structure.js';
import { defaultJavaWorldsDir } from '../../project/config.js';
import { WORLD_ROOT, atomicWrite, validateWorldFolderName, within } from '../../project/paths.js';
import { requireSidecar } from '../../project/sidecar.js';
import { createBedrockWorld, defaultMinecraftWorldsDir, minecraftRunning } from '../../targets/bedrock/create.js';
import { comparePreservation, preservationInfo } from '../../targets/bedrock/preserve.js';
import { analyzeDirectStructureInWorld, backupWorld, validateDirectStructure, validateWorldDirectory, writeStructureToWorld, type DirectAnalysis } from '../../targets/bedrock/world.js';
import { encodeJavaWorld, exportJavaWorld } from '../../targets/java/world.js';
import { contentOptions, parseTriple } from '../args.js';

type LayoutImportOptions = {
  layout: string;
  edition: 'bedrock' | 'java';
  content?: string[];
  world?: string;
  local?: boolean;
  'worlds-dir'?: string;
  'new-world'?: string;
  folder?: string;
  spawn?: string;
  seed?: string;
  only?: string[];
  except?: string[];
  'skip-air'?: boolean;
  'skip-verify'?: boolean;
  'backup-dir'?: string;
  'dry-run'?: boolean;
  json?: boolean;
  report?: string;
};

type WorldOverwrites = {
  cells: number;
  matched: number;
  air: number;
  nonAir: number;
  byBlock: Record<string, number>;
  samples: { position: [number, number, number]; current: string; placed: string }[];
};

function overwriteSummary(analysis: DirectAnalysis): WorldOverwrites {
  return {
    cells: analysis.cells,
    matched: analysis.matched,
    air: analysis.empty,
    nonAir: analysis.different,
    byBlock: analysis.byBlock,
    samples: analysis.samples.map((sample) => ({
      position: [sample.x, sample.y, sample.z],
      current: sample.current ?? 'minecraft:air',
      placed: sample.expected,
    })),
  };
}

async function requireAbsent(path: string) {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (entry) throw new Error(`Target world directory already exists: ${path}`);
}

export async function importLayout(options: LayoutImportOptions) {
  const { edition } = options;
  const existing = edition === 'bedrock' && options.world !== undefined;
  if (existing && ['local', 'worlds-dir', 'new-world', 'folder', 'spawn', 'seed'].some((name) => Object.hasOwn(options, name)))
    throw new Error('--world selects an existing Bedrock world; new-world options do not apply');
  if (options.world !== undefined && !options.world.trim()) throw new Error('--world needs a directory');
  if (edition === 'java' && options.world !== undefined &&
      (options.folder !== undefined || options['worlds-dir'] !== undefined))
    throw new Error('Use --world to set the Java output path, or use --folder and --worlds-dir');

  const layout = await readWorldLayout(options.layout);
  const model = await composeWorldLayout(layout, {
    edition,
    content: contentOptions(options),
    only: options.only ?? [],
    except: options.except ?? [],
    skipAir: options['skip-air'] ?? false,
    meshVersions: false,
  });
  const name = options['new-world']?.trim() || layout.name.trim();
  const spawn = options.spawn === undefined ? layout.spawn : parseTriple(options.spawn, 'spawn');
  if (!spawn.every(isWorldCoordinate) || spawn[1] < -64 || spawn[1] > 319)
    throw new Error('Spawn must use 32-bit integer coordinates and Y in -64..319');
  const seed = options.seed === undefined ? layout.seed : Number(options.seed);
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be an integer');
  const folder = validateWorldFolderName(options.folder ?? `BEWright-${randomUUID().slice(0, 8)}`);
  const root = options.local
    ? join(WORLD_ROOT, edition)
    : options['worlds-dir'];
  const destination = existing
    ? await realpath(await validateWorldDirectory(options.world!))
    : options.world !== undefined
      ? resolve(options.world)
      : join(resolve(root ?? (edition === 'java' ? await defaultJavaWorldsDir() : await defaultMinecraftWorldsDir())), folder);
  if (!existing) await requireAbsent(destination);

  const world = prepareModel(model.world, model.bounds, { connections: edition === 'bedrock' ? 'bedrock' : 'preserve' });
  let region: Box = model.bounds;
  if (edition === 'bedrock') {
    // The direct encoder groups cells by source chunk. Align the payload's
    // minimum to preserve those groups at the world origin, even when an
    // individual placement starts at an arbitrary block coordinate.
    const [x, y, z] = region.min;
    region = { min: [Math.floor(x / CHUNK) * CHUNK, y, Math.floor(z / CHUNK) * CHUNK], max: region.max };
    const size = region.max.map((value, axis) => value - region.min[axis]);
    if (!size.every(isWorldCoordinate) || !Number.isSafeInteger(size.reduce((volume, edge) => volume * edge, 1)))
      throw new Error('The layout spans more than the Bedrock placement format can represent');
    validateDirectStructure(world, region);
  }
  const dryRun = Boolean(options['dry-run']);
  // A dry run has nothing else to do, so it stays a pure analysis pass. A real
  // write gets the same comparison from the writer, which already reads the
  // chunk it is about to merge into; running both would decode every chunk twice.
  let overwrites: WorldOverwrites | undefined;
  if (existing && dryRun) {
    try {
      overwrites = overwriteSummary(await analyzeDirectStructureInWorld(world, region, {
        world: destination,
        position: region.min,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read ${destination} before writing (close the server first): ${message}`, { cause: error });
    }
  }
  const summary = {
    edition, dryRun, layout: layout.path, world: destination,
    mode: existing ? 'existing-world' : 'new-world',
    name: existing ? (await readFile(join(destination, 'levelname.txt'), 'utf8').catch(() => null))?.trim() ?? null : name,
    spawn: existing ? null : spawn, seed: existing ? null : seed,
    placements: model.placements.map(({ offset: _offset, ...placement }) => placement),
    bounds: model.bounds, cells: model.cells, explicitAir: model.explicitAir,
    worldOverwrites: overwrites,
    gameVerified: false,
  };

  if (dryRun) {
    if (edition === 'java') encodeJavaWorld(world, region, { name, spawn, seed });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  let report: Record<string, unknown>;
  if (edition === 'java') {
    report = { ...(await exportJavaWorld(world, region, { output: destination, name, spawn, seed })) };
  } else {
    const running = !within(WORLD_ROOT, destination) && await minecraftRunning();
    if (running) throw new Error(`${running} is running; close it before importing into ${destination}`);
    requireSidecar('blockwright-world');
    const write = (target: string) => writeStructureToWorld(world, region, {
      world: target, position: region.min, backup: false, skipEmptyChunks: true,
      reportOverwrites: existing, verify: existing && !options['skip-verify'],
    });
    if (existing) {
      const preservationBefore = await preservationInfo(destination);
      const backupPath = await backupWorld(destination, options['backup-dir']);
      let written: Awaited<ReturnType<typeof write>>;
      try {
        written = await write(destination);
      } catch (error) {
        throw new Error(`Writing ${destination} failed. Pre-import backup: ${backupPath}. ${String(error)}`, { cause: error });
      }
      const { overwrites: writtenOverwrites, verification, ...writeReport } = written;
      report = { ...writeReport, backupPath };
      if (writtenOverwrites) report.worldOverwrites = overwriteSummary(writtenOverwrites);
      if (verification) {
        report.verification = {
          checked: verification.cells,
          matched: verification.matched,
          mismatched: verification.different + verification.empty,
          missing: verification.empty,
          samples: verification.samples.map((sample) => ({
            position: [sample.x, sample.y, sample.z],
            placed: sample.expected,
            actual: sample.current,
          })),
        };
      }
      try {
        report.preservation = comparePreservation(preservationBefore, await preservationInfo(destination));
      } catch (error) {
        report.preservation = { error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      requireSidecar('blockwright-world-init');
      const parent = resolve(destination, '..');
      await mkdir(parent, { recursive: true });
      const staging = await mkdtemp(join(parent, '.blockwright-layout-'));
      try {
        const created = await createBedrockWorld({ parentDir: staging, folderName: folder, name, spawn, seed });
        report = await write(created.world);
        await requireAbsent(destination);
        await rename(created.world, destination);
      } finally {
        const path = resolve(staging);
        if (path !== parent && within(parent, path)) await rm(path, { recursive: true, force: true });
      }
    }
  }
  const result = { ...summary, ...report };
  if (options.report) await atomicWrite(resolve(options.report), JSON.stringify(result, null, 2));
  console.log(options.json ? JSON.stringify(result, null, 2) : destination);
}
