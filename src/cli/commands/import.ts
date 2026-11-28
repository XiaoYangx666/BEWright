import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { contains, type Box } from '../../core/structure.js';
import { createBedrockWorld, defaultMinecraftWorldsDir, minecraftRunning } from '../../targets/bedrock/create.js';
import { placeStructureInWorld, validateDirectStructure, validateWorldDirectory, writeStructureToWorld } from '../../targets/bedrock/world.js';
import { exportJavaWorld } from '../../targets/java/world.js';
import { buildModel, prepareModel } from '../../content/model.js';
import { PROJECT_ROOT, WORLD_ROOT, atomicWrite, validateWorldFolderName, within } from '../../project/paths.js';
import { defaultJavaWorldsDir } from '../../project/config.js';
import { requireSidecar } from '../../project/sidecar.js';
import { resolveTilePlan } from '../../content/definition.js';
import { placementBatches } from '../../content/pipeline.js';
import { findBuilding } from '../../content/discover.js';
import { loadBuilding } from '../../content/load.js';
import { buildingOutputDir } from '../../content/output.js';
import { buildingArgs, CONTENT_OPTION, PARAM_OPTION, contentOptions, parseTriple, type Triple } from '../args.js';
import { importLayout } from './import-layout.js';
import { normalizePlacementIds } from '../../content/world-layout.js';

export const IMPORT_HELP = `bewright import <building> --edition bedrock|java [options]
bewright import --layout FILE [--only ID ...] [--skip-air] [options]

  --edition bedrock        place the model into a Bedrock world (default)
  --edition java           export an Anvil world instead
  --world DIR              existing world directory (backed up before writing)
  --local                  create an isolated world under the building's output/
  --worlds-dir DIR         parent directory for a new world
  --new-world NAME         level name for the new world
  --folder NAME            folder name for the new world
  --origin x,y,z           Bedrock placement origin (0,-60,0 with --local; otherwise 0,64,0)
  --spawn x,y,z            override the new-world spawn point
  --seed N                 new-world seed
  --rotation 0|90|180|270  placement rotation
  --dimension 0|1|2        Bedrock dimension
  --file FILE              place an existing .mcstructure instead of building
  --layout FILE            import an ordered JSON layout into one Overworld
  --only ID[,ID...]        select layout placements (repeatable, comma-separated)
  --except ID[,ID...]      skip layout placements (repeatable, comma-separated)
  --skip-air               omit explicit air when importing a layout
  --skip-verify            skip the post-write cell and preservation report
  --backup-dir DIR         put the pre-write world copy in DIR instead of next to the world
  --dry-run                resolve the destination and placements without writing
  --json                   print machine-readable results
  --report FILE            save a world-write report
  --force                  proceed while Minecraft is running`;

export async function importCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      content: CONTENT_OPTION,
      param: PARAM_OPTION,
      edition: { type: 'string', default: 'bedrock' },
      world: { type: 'string' },
      local: { type: 'boolean' },
      'worlds-dir': { type: 'string' },
      'new-world': { type: 'string' },
      folder: { type: 'string' },
      origin: { type: 'string' },
      spawn: { type: 'string' },
      seed: { type: 'string' },
      rotation: { type: 'string' },
      dimension: { type: 'string' },
      file: { type: 'string' },
      layout: { type: 'string' },
      only: { type: 'string', multiple: true },
      except: { type: 'string', multiple: true },
      'skip-air': { type: 'boolean' },
      'skip-verify': { type: 'boolean' },
      'backup-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      report: { type: 'string' },
    },
    strict: true,
  });

  const edition = values.edition;
  if (edition !== 'bedrock' && edition !== 'java') throw new Error('--edition must be bedrock or java');
  if (values.local && (values.world !== undefined || values['worlds-dir'] !== undefined))
    throw new Error('--local creates a new workspace world and cannot be combined with --world or --worlds-dir');
  if (values.layout !== undefined) {
    if (positionals.length || values.file !== undefined || values.param || values.origin !== undefined ||
        values.rotation !== undefined || values.dimension !== undefined || values.force)
      throw new Error('--layout defines Overworld placements; use its building, params, origin and rotation fields');
    return await importLayout({
      ...values,
      edition,
      layout: values.layout,
      only: normalizePlacementIds(values.only),
      except: normalizePlacementIds(values.except),
    });
  }
  if (values.only || values.except || values['skip-air']) throw new Error('--only, --except and --skip-air require --layout');
  const origin = parseTriple(values.origin ?? (values.local ? '0,-60,0' : '0,64,0'), 'origin');
  const rotation = Number(values.rotation ?? '0');
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('--rotation must be 0, 90, 180, or 270');
  const dimension = Number(values.dimension ?? '0');
  if (![0, 1, 2].includes(dimension)) throw new Error('--dimension must be 0, 1, or 2');

  const id = positionals[0];
  if (positionals.length > 1 || (!id && !values.file))
    throw new Error('Usage: bewright import <building> [--edition bedrock|java] (or --file FILE)');
  if (edition === 'java' && values.file) throw new Error('--file placement is Bedrock-only');
  const started = Date.now();
  const loaded = id ? await loadBuilding(await findBuilding(id, contentOptions(values))) : null;
  if (loaded && !values.file && !(loaded.definition.editions ?? ['bedrock']).includes(edition))
    throw new Error(`Building "${loaded.definition.id}" does not declare the ${edition} edition`);
  const worldsRoot = values.local
    ? loaded
      ? await buildingOutputDir(loaded, edition === 'java' ? 'java-worlds' : 'bedrock-worlds')
      : join(WORLD_ROOT, edition)
    : values['worlds-dir'];

  if (edition === 'java' && loaded) {
    const { world: source } = buildModel(loaded.definition, buildingArgs(loaded, values));
    const world = prepareModel(source, loaded.definition.bounds, { connections: 'preserve' });
    const seed = values.seed === undefined ? 0 : Number(values.seed);
    if (!Number.isSafeInteger(seed)) throw new Error('--seed must be an integer');
    const name = values['new-world'] ?? loaded.definition.name;
    const folderName = values.folder ?? (values.local ? `${loaded.definition.id}-${randomUUID().slice(0, 8)}` : name.trim());
    const spawn = values.spawn ? parseTriple(values.spawn, 'spawn') : loaded.definition.spawn;
    if (values['dry-run']) {
      const output = values.world
        ? resolve(values.world)
        : join(resolve(worldsRoot ?? (await defaultJavaWorldsDir())), validateWorldFolderName(folderName));
      const inspect = world.inspect();
      console.log(
        JSON.stringify(
          {
            edition,
            dryRun: true,
            world: output,
            name,
            folderName,
            spawn,
            seed,
            bounds: loaded.definition.bounds,
            occupied: inspect.occupied,
            note: 'dry run: no world was written',
          },
          null,
          2,
        ),
      );
      return;
    }
    const report = await exportJavaWorld(world, loaded.definition.bounds, {
      name,
      output: values.world,
      worldsDir: worldsRoot,
      folderName,
      spawn,
      seed,
    });
    const summary = { edition, ...report, durationMs: Date.now() - started, gameVerified: false };
    if (values.report) await atomicWrite(resolve(values.report), JSON.stringify(summary, null, 2));
    console.log(values.json ? JSON.stringify(summary, null, 2) : report.world);
    return;
  }

  const args = loaded ? buildingArgs(loaded, values) : undefined;
  const placements: { region: Box | null; file?: string; position: Triple }[] = [];
  if (values.file) {
    const file = resolve(values.file);
    if (!(await stat(file).catch(() => undefined))?.isFile()) throw new Error(`Structure file not found: ${file}`);
    placements.push({ region: null, file, position: origin });
  } else if (loaded) {
    const bounds = loaded.definition.bounds;
    const plan = resolveTilePlan(loaded.definition.tiles, bounds);
    if (plan) {
      // World placement follows the *placement* stage, not the export shard
      // size: the two used to be the same number by accident of implementation.
      for (const batch of placementBatches(plan, origin))
        placements.push({ region: batch.region, position: batch.position });
    } else {
      placements.push({ region: bounds, position: origin });
    }
  }
  for (const placement of placements)
    if (placement.position[0] % 16 !== 0 || placement.position[2] % 16 !== 0)
      throw new Error(`Placement anchor must keep world x/z on multiples of 16: ${placement.position}`);

  // Prepare once before creating a new world. Dry runs retain their planning-only
  // semantics: no model build, registry scan, sidecar or world writes.
  const source = !values['dry-run'] && !values.file && loaded && args
    ? buildModel(loaded.definition, args).world : null;
  const world = source && loaded
    ? prepareModel(source, loaded.definition.bounds, { connections: 'bedrock' }) : null;
  if (world)
    for (const placement of placements) validateDirectStructure(world, placement.region!);

  if (!values['dry-run']) {
    if (!values.local && !values.force) {
      const running = await minecraftRunning();
      if (running) {
        const hint = values.world ?? worldsRoot;
        const target = hint ? await realpath(hint).catch(() => undefined) : undefined;
        // Keep the existing ability to work on an explicitly isolated workspace world.
        if (!target || !within(WORLD_ROOT, target))
          throw new Error(`${running} is running; close it first or create an isolated world with --local`);
        console.error(`warning: ${running} is running; writing to a workspace world continues`);
      }
    }
    requireSidecar('blockwright-world');
  }

  let destination: string;
  let levelName: string | null = null;
  let folderName: string | null = null;
  let spawnPoint: Triple | null = null;
  let seed: number | null = null;
  if (values.world) {
    destination = await validateWorldDirectory(values.world);
    levelName = (await readFile(join(destination, 'levelname.txt'), 'utf8').catch(() => null))?.trim() ?? null;
  } else {
    const worldsDir = resolve(worldsRoot ?? (await defaultMinecraftWorldsDir()));
    const declaredSpawn = loaded?.definition.spawn;
    const spawnPlacement = values.local && rotation === 0 && declaredSpawn
      ? placements.find(({ region }) => region && contains(region, ...declaredSpawn))
      : undefined;
    const localSpawn: Triple = [origin[0] - 2, -60, origin[2]];
    if (declaredSpawn && spawnPlacement?.region) {
      for (const axis of [0, 1, 2] as const)
        localSpawn[axis] = spawnPlacement.position[axis] + declaredSpawn[axis] - spawnPlacement.region.min[axis];
    }
    spawnPoint = values.spawn ? parseTriple(values.spawn, 'spawn') : values.local ? localSpawn : [0, -60, 0];
    seed = values.seed === undefined ? 0 : Number(values.seed);
    if (!Number.isSafeInteger(seed)) throw new Error('--seed must be an integer');
    if (values['dry-run']) {
      destination = join(worldsDir, values.folder === undefined ? 'BEWright-<generated>' : validateWorldFolderName(values.folder));
    } else {
      const created = await createBedrockWorld({
        parentDir: worldsDir,
        name: values['new-world']?.trim() || loaded?.definition.name || 'BEWright',
        folderName: values.folder,
        spawn: spawnPoint,
        seed,
        marker: { scene: loaded?.definition.id ?? 'file', levelName: values['new-world'] ?? null,
          origin, rotation, dimension, spawn: spawnPoint, seed },
      });
      destination = created.world;
      folderName = created.folderName;
      levelName = created.name;
    }
  }

  const results = [];
  let placedBlocks = 0,
    regionCells = 0,
    touchedChunks = 0;
  if (!values['dry-run']) {
    for (const placement of placements) {
      const result = placement.file
        ? await placeStructureInWorld({
            world: destination,
            structure: placement.file,
            position: placement.position,
            dimension,
            rotation: rotation as 0 | 90 | 180 | 270,
            backup: Boolean(values.world),
            backupDir: values['backup-dir'],
          })
        : await writeStructureToWorld(world!, placement.region!, {
            world: destination,
            position: placement.position,
            dimension,
            rotation: rotation as 0 | 90 | 180 | 270,
            backup: Boolean(values.world),
            backupDir: values['backup-dir'],
            verify: Boolean(values.world) && !values['skip-verify'],
          });
      placedBlocks += result.placedBlocks;
      regionCells += result.regionCells;
      touchedChunks += result.touchedChunks;
      results.push({ source: placement.file ?? 'direct-structure', position: placement.position, ...result });
    }
  }

  const summary = {
    building: loaded?.definition.id ?? null,
    edition,
    mode: values.world ? 'existing-world' : 'new-world',
    dryRun: Boolean(values['dry-run']),
    world: destination,
    folderName,
    levelName,
    spawn: spawnPoint,
    seed,
    origin,
    rotation,
    dimension,
    placements: values['dry-run'] ? placements.length : results.length,
    placedBlocks,
    regionCells,
    touchedChunks,
    durationMs: Date.now() - started,
    gameVerified: false,
  };
  if (values.report && !values['dry-run'])
    await atomicWrite(resolve(values.report), JSON.stringify({ ...summary, results }, null, 2));
  console.log(values.json || values['dry-run'] ? JSON.stringify(summary, null, 2) : destination);
}
