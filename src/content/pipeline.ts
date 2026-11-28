import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Structure, type Box } from '../core/structure.js';
import type { Components } from '../core/components.js';
import { meshDiagnostics, type MeshData, type MeshDiagnostic } from '../mesh/mesher.js';
import { sceneMesher } from '../mesh/scene.js';
import { LightField } from '../mesh/light.js';
import { lightWorldHash, readLightCache, writeLightCache } from '../mesh/light-cache.js';
import {
  MESH_CACHE_VERSION,
  cachedViewUsable,
  chunkOrigin,
  meshChunkPrefix,
  meshFingerprint,
  meshConfigFingerprint,
  meshWorldSignature,
  pruneMeshCache,
  readMeshCacheDir,
  writeMeshCacheIndex,
  writePackedMeshes,
  type CachedView,
  type MeshCacheIndex,
} from '../mesh/cache.js';
import {
  DEFAULT_MCSTRUCTURE_FORMAT_VERSION,
  exportMcstructure,
  type McstructureFormatVersion,
} from '../targets/bedrock/mcstructure.js';
import { modelSession } from './model.js';
import { TARGET } from '../blocks/target.js';
import { atomicWrite, manifest, within } from '../project/paths.js';
import { DEFAULT_PROJECT, type ProjectContext } from '../project/context.js';
import { mergeDiagnostics, countSeverities, type Diagnostic } from '../authoring/diagnostics.js';
import { fromMeshDiagnostics } from '../authoring/diagnostic-adapters.js';
import { generateModel, runModelCheck, type GeneratedModel, type ModelCheckSummary } from './check.js';
import {
  resolveTilePlan,
  resolveBuildingArgs,
  type BuildingArgs,
  type BuildingDefinition,
  type BuildingView,
  type ResolvedTilePlan,
} from './definition.js';
import type { LoadedBuilding } from './load.js';
import { buildingOutputDir } from './output.js';

/** mcstructure export budget; larger structures must be delivered as tiles. */
export const EXPORT_VOLUME_BUDGET = 2_000_000;

/**
 * Cut a region into export shards. Shard size is an artifact-file concern only:
 * nothing here decides where or how anything is placed in a world.
 *
 * Shards always cover the region completely: the last row and column are
 * clamped to the region edge, so a non-zero origin, negative coordinates and an
 * edge shard all keep their exact cells.
 */
export function structureTileRegions(region: Box, shard: number): Box[] {
  if (!Number.isSafeInteger(shard) || shard < 1)
    throw new Error(`Tile shard size must be a positive integer: ${shard}`);
  const regions: Box[] = [];
  for (let x = region.min[0]; x < region.max[0]; x += shard)
    for (let z = region.min[2]; z < region.max[2]; z += shard)
      regions.push({
        min: [x, region.min[1], z],
        max: [Math.min(x + shard, region.max[0]), region.max[1], Math.min(z + shard, region.max[2])],
      });
  return regions;
}

/**
 * World placements for a resolved plan: the placement region cut into write
 * batches, each with the world position of its own minimum corner.
 *
 * `baseOrigin` is where the placement region's **minimum corner** lands in the
 * world (the caller's `--origin`, defaulting to the plan's own origin). The
 * mapping is derived from the placement region, so the export shard size cannot
 * shift a placement, and a negative or non-zero origin lands exactly where the
 * declared region says it should — the same arithmetic the pre-split code used.
 */
export function placementBatches(
  plan: ResolvedTilePlan,
  baseOrigin: readonly [number, number, number] = plan.placement.origin,
): { region: Box; position: [number, number, number] }[] {
  const { region, batchSize } = plan.placement;
  const batches = batchSize && batchSize > 0 ? structureTileRegions(region, batchSize) : [region];
  return batches.map((batch) => ({
    region: batch,
    position: [
      baseOrigin[0] + batch.min[0] - region.min[0],
      baseOrigin[1],
      baseOrigin[2] + batch.min[2] - region.min[2],
    ],
  }));
}

export type BuildRequest = Readonly<{
  /** Explicit output root for library callers. CLI uses DEFAULT_PROJECT. */
  project?: ProjectContext;
  args?: BuildingArgs;
  /** Artifact directory override; relative paths resolve against the project root. */
  artifactDir?: string;
  /** Use the building's own output directory when no explicit override was supplied. */
  buildingOutput?: boolean;
  /** Explicit destination for a single-file Bedrock export. */
  structurePath?: string;
  /** Write scenes.json, report.json and manifest.json. On by default for library callers. */
  writeMetadata?: boolean;
  /** Mesh cache directory override; relative paths resolve against the project root. */
  cacheDir?: string;
  /** Run the building's own check(); on by default. */
  check?: boolean;
  /** Write Bedrock structure files (.mcstructure / tiles / assembly.json); off by default. */
  export?: boolean;
  /** `.mcstructure` layout version to write; 1 (broadest client support) by default. */
  structureVersion?: McstructureFormatVersion;
  /** Override the definition's tile plan. */
  tiles?: boolean;
}>;

export type BuiltView = Readonly<{
  name: string;
  region: Box;
  bounds: Box;
  chunkFiles: readonly string[];
  quads: number;
  diagnostics: readonly MeshDiagnostic[];
  /** `reused` means an identical mesh was already built for an earlier view. */
  meshSource: 'built' | 'partial' | 'reused' | 'cached';
  meshMs: number;
  cacheMs: number;
}>;

export type BuildResult = Readonly<{
  definition: BuildingDefinition;
  world: Structure;
  components: Components | null;
  args: BuildingArgs;
  inspect: ReturnType<Structure['inspect']>;
  views: readonly BuiltView[];
  artifactDir: string;
  cacheDir: string;
  exported: boolean;
  structureFile: string | null;
  files: readonly string[];
  /** Unified diagnostics for the generated model (model stage + preview mesh stage). */
  diagnostics: readonly Diagnostic[];
  /** The building's own check, as run inside this build. */
  check: ModelCheckSummary;
  report: Record<string, unknown>;
}>;

const toPosix = (path: string) => path.replaceAll('\\', '/');

function outputDir(project: ProjectContext, override: string | undefined, fallback: string) {
  const resolved = resolve(project.root, override ?? fallback);
  if (!within(project.root, resolved)) throw new Error(`Output directory must stay inside the project: ${resolved}`);
  return resolved;
}

function defaultViews(definition: BuildingDefinition): readonly BuildingView[] {
  return definition.views?.length ? definition.views : [{ name: definition.id, view: 'iso' }];
}

/**
 * The single generation pipeline shared by every building:
 * generate -> per-view meshing -> optional Bedrock export (structure files are
 * opt-in) -> the building's own check -> scenes/report/manifest artifacts.
 *
 * Generation and checking go through `content/check.ts`, so `bewright build` and
 * `bewright check` inspect the very model this run produced — never a second build.
 */
export async function runBuild(loaded: LoadedBuilding, request: BuildRequest = {}): Promise<BuildResult> {
  const { definition } = loaded;
  const project = request.project ?? DEFAULT_PROJECT;
  const managedOutput = request.buildingOutput === true && request.artifactDir === undefined;
  const artifactDir = managedOutput
    ? await buildingOutputDir(loaded, request.export ? 'bedrock' : 'diagnostics', project)
    : outputDir(project, request.artifactDir ?? definition.artifacts, join(project.artifacts, definition.id));
  const cacheDir = outputDir(
    project,
    request.cacheDir ?? definition.cache,
    join(project.cache, 'meshes', definition.id),
  );
  const runCheck = request.check !== false;
  const writeMetadata = request.writeMetadata !== false;
  const started = Date.now();

  await mkdir(cacheDir, { recursive: true });

  const resolvedArgs = request.args ?? resolveBuildingArgs(definition.params);
  const viewModels = modelSession(definition, resolvedArgs);
  const generated: GeneratedModel = generateModel(
    definition,
    {
      args: resolvedArgs,
      check: runCheck,
    },
    () => {
      const source = viewModels.generate();
      // An explicitly shared main builder still runs once. Prepare its alternate
      // regions before the authoritative model's full-bounds derivation.
      for (const view of defaultViews(definition))
        if (view.build === definition.build) viewModels.preview(source.world, view.region ?? definition.bounds);
      return source;
    },
  );
  const { world, components, args, inspect, bounds } = generated;
  const generateMs = generated.generateMs;
  let light: LightField | undefined;
  let lightMs = 0;
  let lightCacheMs = 0;
  let lightSource: 'computed' | 'restored' | 'unused' = 'unused';
  let t = performance.now();
  const cached = await readMeshCacheDir(cacheDir);
  const cacheIndex: MeshCacheIndex = { version: MESH_CACHE_VERSION, views: {} };
  const worldSignature = meshWorldSignature(world);
  cacheIndex.world = worldSignature;
  const oldWorld = cached.index.world;
  const changed = oldWorld
    ? new Set(
        [...new Set([...Object.keys(oldWorld.chunks), ...Object.keys(worldSignature.chunks)])].filter(
          (key) => oldWorld.chunks[key] !== worldSignature.chunks[key],
        ),
      )
    : undefined;
  // Sky light can travel down the entire column; block light travels at most
  // 15 blocks horizontally. Include the adjacent X/Z chunk columns and all Y.
  const dirtyColumns = new Set<string>();
  if (changed)
    for (const key of changed) {
      const [cx, , cz] = key.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) dirtyColumns.add(`${cx + dx},${cz + dz}`);
    }
  if (oldWorld && cached.index.light && changed?.size === 0 && cached.index.light.world === lightWorldHash(oldWorld))
    cacheIndex.light = cached.index.light;
  const mainLight = async () => {
    if (light) return light;
    if (oldWorld && cached.index.light && changed) {
      const restored = await readLightCache(cacheDir, cached.index.light, world, lightWorldHash(oldWorld));
      if (restored) {
        restored.applyWorld(world, changed);
        light = restored;
        lightSource = 'restored';
        return light;
      }
    }
    light = LightField.compute(world);
    lightSource = 'computed';
    return light;
  };
  const scenes: Record<string, unknown> = {};
  const builtViews: BuiltView[] = [];
  const meshDiagnosticsByView: { view: string; diagnostics: readonly MeshDiagnostic[] }[] = [];
  /** Fingerprint -> mesh already produced in this run; identical views share it. */
  const produced = new Map<string, CachedView>();

  t = performance.now();
  for (const view of defaultViews(definition)) {
    const region = view.region ?? bounds;
    const targetWorld = view.build ? viewModels.preview(viewModels.generate(view.build).world, region) : world;
    // Views that differ only by camera (a common case) fingerprint identically:
    // they reuse both the mesh data and its packed files instead of remeshing.
    // The preview always uses lighting, but a cached mesh already contains it.
    // Fingerprinting must precede light computation so a cache hit skips the
    // full-world light pass entirely.
    const fingerprint = meshFingerprint(targetWorld, region, view.style ?? {}, true);
    const config = meshConfigFingerprint(region, view.style ?? {}, true);
    let entry = produced.get(fingerprint);
    let meshSource: BuiltView['meshSource'] = 'reused';
    let meshMs = 0;
    let cacheMs = 0;

    if (entry === undefined) {
      const onDisk = cached.index.views[fingerprint];
      if (cachedViewUsable(onDisk, cached.files)) {
        entry = onDisk;
        meshSource = 'cached';
      } else {
        const previous =
          !view.build && changed && changed.size > 0
            ? Object.values(cached.index.views).find(
                (candidate) =>
                  candidate.config === config && candidate.parts && cachedViewUsable(candidate, cached.files),
              )
            : undefined;
        const lightStarted = performance.now();
        const viewLight = view.build ? LightField.compute(targetWorld) : await mainLight();
        lightMs += performance.now() - lightStarted;
        const meshStarted = performance.now();
        const mesher = sceneMesher(targetWorld, region, view.style ?? {}, viewLight);
        meshSource = previous ? 'partial' : 'built';
        const prefix = `m${fingerprint}`;
        const chunks: string[] = [];
        const pending: { baseName: string; data: MeshData; origin: number[] }[] = [];
        let quads = 0;
        const parts: NonNullable<CachedView['parts']> = {};
        const keys = [...targetWorld.chunks].filter(([, chunk]) =>
          chunk.origin.every((v, i) => v < region.max[i] && v + 16 > region.min[i]),
        );
        for (const [key] of keys) {
          const [cx, , cz] = key.split(',').map(Number);
          const oldPart = previous?.parts?.[key];
          if (oldPart && !dirtyColumns.has(`${cx},${cz}`)) {
            chunks.push(key);
            parts[key] = oldPart;
            quads += oldPart.quads;
            continue;
          }
          const data = mesher.chunk(key);
          if (!data || (!data.positions.length && !data.translucentPositions.length)) continue;
          chunks.push(key);
          quads += data.quads;
          parts[key] = { prefix, quads: data.quads, diagnostics: data.diagnostics };
          pending.push({ baseName: `${prefix}.${key}`, data, origin: chunkOrigin(key) });
        }
        meshMs = performance.now() - meshStarted;
        const cacheStarted = performance.now();
        const bytes = await writePackedMeshes(cacheDir, pending);
        cacheMs = performance.now() - cacheStarted;
        entry = { prefix, chunks, quads, bytes, config, parts, diagnostics: meshDiagnostics(Object.values(parts)) };
      }
      produced.set(fingerprint, entry);
    }

    const viewDiagnostics = entry.diagnostics;
    meshDiagnosticsByView.push({ view: view.name, diagnostics: viewDiagnostics });
    const chunkFiles = entry.chunks.map((key) =>
      meshChunkPrefix(project.root, cacheDir, entry.parts?.[key]?.prefix ?? entry.prefix, key),
    );
    cacheIndex.views[fingerprint] = entry;
    builtViews.push({
      name: view.name,
      region,
      bounds: region,
      chunkFiles,
      quads: entry.quads,
      diagnostics: viewDiagnostics,
      meshSource,
      meshMs,
      cacheMs,
    });
    scenes[view.name] = {
      bounds: region,
      chunkFiles,
      quads: entry.quads,
      view: view.view ?? 'iso',
      fit: view.fit ?? 'geometry',
      title: view.title ?? `${definition.name} / ${view.name}`,
      diagnostics: viewDiagnostics,
      ...(view.direction ? { direction: view.direction } : {}),
      ...(view.eye ? { eye: view.eye } : {}),
      ...(view.target ? { target: view.target } : {}),
    };
  }
  const meshMs = performance.now() - t - lightMs;
  if (light) {
    const lightCacheStarted = performance.now();
    cacheIndex.light = await writeLightCache(cacheDir, light, lightWorldHash(worldSignature));
    lightCacheMs = performance.now() - lightCacheStarted;
  }
  await writeMeshCacheIndex(cacheDir, cacheIndex);
  await pruneMeshCache(cacheDir, cached.files, cacheIndex);

  const volume = (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]) * (bounds.max[2] - bounds.min[2]);
  const resolvedTiles = request.tiles === false ? null : resolveTilePlan(definition.tiles, bounds);
  const files: string[] = [];
  if (writeMetadata) {
    const sceneFile = join(artifactDir, 'scenes.json');
    await atomicWrite(sceneFile, JSON.stringify(scenes, null, 2));
    files.push(sceneFile);
  }

  t = performance.now();
  let structureFile: string | null = null;
  const exportRequested = request.export === true;
  const structureVersion = request.structureVersion ?? DEFAULT_MCSTRUCTURE_FORMAT_VERSION;
  if (exportRequested) {
    if (volume <= EXPORT_VOLUME_BUDGET) {
      const bytes = exportMcstructure(world, bounds, { formatVersion: structureVersion });
      structureFile = request.structurePath ?? join(artifactDir, `${definition.id}.mcstructure`);
      await atomicWrite(structureFile, bytes);
      files.push(structureFile);
    } else if (request.structurePath) {
      throw new Error(`Building "${definition.id}" exceeds the single-file budget. Export without --output to write tiles.`);
    } else if (!resolvedTiles) {
      throw new Error(
        `Structure volume ${volume} exceeds the ${EXPORT_VOLUME_BUDGET} budget; declare a tile plan for ${definition.id}`,
      );
    }
  }

  const tiles: { file: string; offset: number[]; size: number[] }[] = [];
  if (exportRequested && resolvedTiles && !request.structurePath && (!managedOutput || !structureFile)) {
    const { region, shard } = resolvedTiles.export;
    const { origin } = resolvedTiles.placement;
    const size = region.max.map((value, axis) => value - region.min[axis]);
    for (const shardRegion of structureTileRegions(region, shard)) {
      const file = `tile-${shardRegion.min[0] - region.min[0]}-${shardRegion.min[2] - region.min[2]}.mcstructure`;
      const bytes = exportMcstructure(world, shardRegion, { formatVersion: structureVersion });
      const path = join(artifactDir, file);
      await atomicWrite(path, bytes);
      files.push(path);
      tiles.push({
        file,
        offset: [shardRegion.min[0] - origin[0], 0, shardRegion.min[2] - origin[2]],
        size: shardRegion.max.map((value, axis) => value - shardRegion.min[axis]),
      });
    }
    const assemblyFile = join(artifactDir, 'assembly.json');
    await atomicWrite(
      assemblyFile,
      JSON.stringify(
        {
          target: TARGET,
          fullRegion: region,
          origin,
          tiles,
          size,
          // The three stages are recorded separately so a reader of the artifact
          // cannot mistake an export shard size for a world placement decision.
          exportShard: shard,
          structureFormatVersion: structureVersion,
          placement: resolvedTiles.placement,
          gameVerified: false,
        },
        null,
        2,
      ),
    );
    files.push(assemblyFile);
  }
  const exportMs = performance.now() - t;

  // The check runs on `generated`, the same model that was just meshed and
  // exported — `build` and `check` share one execution mechanism.
  const check = await runModelCheck(loaded, generated, {
    ...(request.args ? { args: request.args } : {}),
    check: runCheck,
  });
  const checkMs = check.executed ? check.ms : 0;

  // Unified diagnostic stream: model-stage findings first, then preview mesh
  // warnings. Mesh verdicts can never replace model verdicts (nor the reverse).
  const diagnostics: Diagnostic[] = mergeDiagnostics([
    ...check.diagnostics,
    ...meshDiagnosticsByView.flatMap((entry) => fromMeshDiagnostics(entry.diagnostics, entry.view)),
  ]);
  const meshDiagnosticsFlat = meshDiagnosticsByView.flatMap((entry) => entry.diagnostics);
  const modelDiagnosticList = mergeDiagnostics(generated.diagnostics);
  const previewDiagnosticList = mergeDiagnostics(
    meshDiagnosticsByView.flatMap((entry) => fromMeshDiagnostics(entry.diagnostics, entry.view)),
  );

  // `meshMs` is the whole view pass; the split below is what actually profiles a
  // slow build, because cache I/O has historically dominated pure meshing.
  const meshOnlyMs = builtViews.reduce((total, view) => total + view.meshMs, 0);
  const cacheMs = builtViews.reduce((total, view) => total + view.cacheMs, 0);
  const report = {
    id: definition.id,
    name: definition.name,
    target: TARGET,
    args,
    generateMs,
    lightMs,
    lightCacheMs,
    lightSource,
    meshMs,
    meshOnlyMs,
    cacheMs,
    exportMs,
    checkMs,
    totalMs: Date.now() - started,
    ...inspect,
    bounds,
    componentCellBytes: components?.snapshotCellBytes ?? 0,
    components: components?.list(),
    views: builtViews.map((view) => ({
      name: view.name,
      chunks: view.chunkFiles.length,
      quads: view.quads,
      meshSource: view.meshSource,
      meshMs: Math.round(view.meshMs),
      cacheMs: Math.round(view.cacheMs),
    })),
    /** Legacy shape kept for readers of older reports. */
    diagnostics: meshDiagnosticsFlat,
    modelDiagnostics: modelDiagnosticList,
    buildingDiagnostics: mergeDiagnostics(check.diagnostics.filter((d) => !generated.diagnostics.includes(d))),
    previewDiagnostics: previewDiagnosticList,
    diagnosticCounts: countSeverities(diagnostics),
    diagnosticsUnified: diagnostics,
    check: {
      status: check.status,
      executed: check.executed,
      severity: check.severity,
      rule: check.rule,
      message: check.message,
      counts: check.counts,
      diagnostics: check.diagnostics,
      ms: Math.round(check.ms),
    },
    exported: exportRequested,
    structureFormatVersion: exportRequested ? structureVersion : null,
    gameVerified: false,
  };
  if (writeMetadata) {
    const reportFile = join(artifactDir, 'report.json');
    await atomicWrite(reportFile, JSON.stringify(report, null, 2));
    files.push(reportFile);

    await atomicWrite(
      join(artifactDir, 'manifest.json'),
      JSON.stringify(
        await manifest(
          definition.id,
          { args, target: TARGET },
          files,
          {
            exported: exportRequested,
            structureFormatVersion: exportRequested ? structureVersion : null,
            check: check.status,
            diagnostics: countSeverities(diagnostics),
            gameVerified: false,
          },
          project,
        ),
        null,
        2,
      ),
    );
  }

  return {
    definition,
    world,
    components,
    args,
    inspect,
    views: builtViews,
    artifactDir,
    cacheDir,
    exported: exportRequested,
    structureFile,
    files,
    diagnostics,
    check,
    report,
  };
}

export function describeBuilding(loaded: LoadedBuilding, project: ProjectContext = DEFAULT_PROJECT) {
  const { definition, discovered } = loaded;
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    root: toPosix(relative(project.root, discovered.root)),
    source: discovered.source,
    editions: definition.editions ?? ['bedrock'],
    bounds: definition.bounds,
    spawn: definition.spawn,
    tiles: resolveTilePlan(definition.tiles, definition.bounds),
    params: definition.params ?? {},
    views: defaultViews(definition).map((view) => view.name),
  };
}
