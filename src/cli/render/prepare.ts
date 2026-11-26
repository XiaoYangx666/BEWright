import { join } from 'node:path';
import { Components } from '../../core/components.js';
import { assertBox, type Box, type Structure, type Vec3 } from '../../core/structure.js';
import { preparePreview, sliceRegion, type PreviewOptions } from '../../preview/selection.js';
import { meshDiagnostics, type MeshDiagnostic } from '../../mesh/mesher.js';
import { sceneMesher } from '../../mesh/scene.js';
import { chunkOrigin, meshFingerprint, packMeshData } from '../../mesh/cache.js';
import { LightField } from '../../mesh/light.js';
import { materials, previewStyles } from '../../blocks/materials.js';
import { modelSession } from '../../content/model.js';
import { atomicWrite } from '../../project/paths.js';
import {
  resolveBuildingArgs,
  type BuildingArgs,
  type BuildingModel,
  type BuildingView,
} from '../../content/definition.js';
import { findBuilding, type ContentOptions } from '../../content/discover.js';
import { loadBuilding, type LoadedBuilding } from '../../content/load.js';
import type { RenderScene } from './render.js';
import type { PreviewSnapshot } from '../../preview/incremental.js';
import { buildingBlockSupport } from '../../content/block-support.js';
import type { Diagnostic } from '../../authoring/diagnostic-core.js';
import { diagnosticMarkers } from '../../preview/diagnostics.js';

const VIEWS = ['iso', 'top', 'front', 'side'] as const;

export type PreviewRenderOptions = {
  styleName: string;
  noRender: boolean;
  width: number;
  height: number;
  background?: string;
  light: boolean;
  ambient: number;
  exposure: number;
  curve: number;
  day: number;
  findings?: readonly Diagnostic[];
  reportDir?: string;
};

/** One render job: either an ad-hoc selection or a declared view. */
export type PreviewJob = Readonly<{
  artifactName: string;
  camera: (typeof VIEWS)[number];
  build?: (args: BuildingArgs) => BuildingModel;
  region?: Box;
  direction?: Vec3;
  eye?: Vec3;
  target?: Vec3;
  fit?: 'geometry' | 'bounds';
  style?: Readonly<Record<string, string>>;
  title?: string;
}>;

export type PreviewRun = Readonly<{
  name: string;
  camera: string;
  image: string | null;
  occupied: number;
  quads: number;
  chunks: number;
  placeholderCells: number;
  lightMs: number;
}>;

/**
 * Work shared between the jobs of one command. A view that differs from an
 * earlier one only by camera produces byte-identical geometry, so building the
 * model, lighting it and meshing it again would be pure waste — this is what
 * `--all-views` used to do for every declared view.
 */
type SharedPreview = {
  /** One built model per `view.build` source; views without one share a single build. */
  models: ReturnType<typeof modelSession>;
  lights: Map<Structure, LightField | null>;
  /** Meshed geometry keyed by content, so camera-only views reuse one mesh. */
  meshes: Map<string, PreparedMesh>;
};

type PreparedMesh = {
  chunkFiles: string[];
  chunks: Map<string, Uint8Array>;
  quads: number;
  diagnostics: MeshDiagnostic[];
};

/** The job's scene plus the buffers it fetches, ready for one batched render. */
export type PreparedJob = {
  run: PreviewRun;
  /** Null under --no-render, where nothing is drawn. */
  scene: RenderScene | null;
  chunks: Map<string, Uint8Array>;
};

export const createSharedPreview = (loaded: LoadedBuilding, args: BuildingArgs): SharedPreview => ({
  models: modelSession(loaded.definition, args),
  lights: new Map(),
  meshes: new Map(),
});

export async function preparePreviewJob(
  loaded: LoadedBuilding,
  args: BuildingArgs,
  job: PreviewJob,
  options: PreviewOptions,
  cli: PreviewRenderOptions,
  shared: SharedPreview,
  capture?: (snapshot: PreviewSnapshot) => void,
): Promise<PreparedJob> {
  // The model is built once per distinct source: every declared view without its
  // own `build` draws the same structure, so it is generated a single time.
  const built = shared.models.generate(job.build);
  const model = built.model;
  const style = { ...previewStyles[cli.styleName as keyof typeof previewStyles], ...job.style };
  const slice = options.slice;

  let world: Structure, region: Box, summary: ReturnType<Structure['inspect']>, sourceRevision: number;
  if (model instanceof Components && (options.focus || options.isolate || options.hide)) {
    const prepared = preparePreview(model, options);
    world = prepared.world;
    region = prepared.region;
    summary = prepared.summary;
    sourceRevision = built.sourceRevision;
  } else {
    world = built.world;
    region = {
      min: [...(job.region ?? loaded.definition.bounds).min],
      max: [...(job.region ?? loaded.definition.bounds).max],
    };
    if (slice) sliceRegion(region, slice);
    assertBox(region);
    summary = world.inspect(region);
    if (!summary.bounds) throw new Error(`Preview "${job.artifactName}" contains no visible blocks`);
    sourceRevision = built.sourceRevision;
  }
  world = shared.models.preview(world, region);
  if (capture) {
    capture({
      palette: world.palette,
      chunks: [...world.chunks],
      region,
      style,
      light: cli.light,
      camera: { camera: job.camera, eye: job.eye, target: job.target, direction: job.direction },
      views: (loaded.definition.views ?? []).map((view) => ({
        name: view.name,
        title: view.title,
        camera: { camera: view.view ?? 'iso', eye: view.eye, target: view.target, direction: view.direction },
        available:
          !job.build && !view.build && (!view.region || JSON.stringify(view.region) === JSON.stringify(region)),
      })),
      support: buildingBlockSupport(world, region),
    });
    return {
      run: {
        name: job.artifactName,
        camera: job.camera,
        image: null,
        occupied: summary.occupied,
        quads: 0,
        chunks: world.chunks.size,
        placeholderCells: 0,
        lightMs: 0,
      },
      // The live server meshes the snapshot itself and streams from memory.
      scene: null,
      chunks: new Map(),
    };
  }

  const lightStarted = performance.now();
  let light: LightField | null;
  if (!cli.light) light = null;
  else if (shared.lights.has(world)) light = shared.lights.get(world)!;
  else shared.lights.set(world, (light = LightField.compute(world)));
  const lightMs = Math.round(performance.now() - lightStarted);

  // Wall derivation rewrites wall states from neighbour *names*, which it never
  // changes and the mesher clips to the region, so a mesh depends only on the
  // content inside its region. Keying on that content makes the camera-only
  // views of one model share a single mesh — and one set of buffers.
  const fingerprint = meshFingerprint(world, region, style, light !== null);
  let meshed = shared.meshes.get(fingerprint);
  if (!meshed) {
    const meshes = new Map(
      [...sceneMesher(world, region, style, light).chunks()].filter(
        (entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null,
      ),
    );
    // A one-shot preview renders in this same process, so the packed chunks go
    // straight to the browser. Nothing else can consume them, so writing them to
    // cache/meshes/previews/ was a disk round trip that only cost time and space.
    const chunkFiles: string[] = [];
    const chunks = new Map<string, Uint8Array>();
    let quads = 0;
    for (const [key, data] of meshes) {
      if (!data.positions.length && !data.translucentPositions.length) continue;
      const prefix = `memory/meshes/${fingerprint}/${key}`;
      chunkFiles.push(prefix);
      chunks.set(prefix, packMeshData(data, chunkOrigin(key)));
      quads += data.quads;
    }
    meshed = { chunkFiles, chunks, quads, diagnostics: meshDiagnostics(meshes.values()) };
    shared.meshes.set(fingerprint, meshed);
  }
  const { chunkFiles, chunks, quads, diagnostics } = meshed;
  const legend = Object.keys(summary.materials).map((material) => {
    const short = material.replace('minecraft:', '');
    return { name: short, color: style[short] ?? materials[short].color };
  });
  const scene: RenderScene = {
    bounds: summary.bounds!,
    chunkFiles,
    view: job.camera,
    fit: job.fit ?? 'geometry',
    title: job.title ?? `${loaded.definition.name} / ${job.artifactName}`,
    diagnostics,
    markers: diagnosticMarkers(cli.findings ?? [], region),
    legend,
    lighting: { ambient: cli.ambient, exposure: cli.exposure, curve: cli.curve, day: cli.day },
    ...(job.direction ? { direction: job.direction } : {}),
    ...(job.eye ? { eye: job.eye } : {}),
    ...(job.target ? { target: job.target } : {}),
  };

  if (cli.reportDir) {
    await atomicWrite(
      join(cli.reportDir, `${job.artifactName}.json`),
      JSON.stringify(
        {
          building: loaded.definition.id,
          args,
          options,
          region,
          summary,
          diagnostics,
          checkDiagnostics: cli.findings ?? [],
          markers: scene.markers,
          sourceRevision,
          camera: job.camera,
        },
        null,
        2,
      ),
    );
  }

  return {
    run: {
      name: job.artifactName,
      camera: job.camera,
      image: null,
      occupied: summary.occupied,
      quads,
      chunks: chunkFiles.length,
      placeholderCells: diagnostics.reduce((total, item) => total + item.count, 0),
      lightMs,
    },
    scene: cli.noRender ? null : scene,
    chunks,
  };
}

export function declaredJob(view: BuildingView): PreviewJob {
  return {
    artifactName: view.name,
    camera: (view.view ?? 'iso') as (typeof VIEWS)[number],
    build: view.build,
    region: view.region,
    direction: view.direction,
    eye: view.eye,
    target: view.target,
    fit: view.fit,
    style: view.style,
    title: view.title,
  };
}

/** Normalized IPC request. It contains data only, never building functions or CLI flags. */
export type SnapshotRequest = {
  id: string;
  content: ContentOptions;
  params: BuildingArgs;
  viewName?: string;
  name: string;
  camera: 'iso' | 'top' | 'front' | 'side';
  options: PreviewOptions;
  cli: PreviewRenderOptions;
};

/** Reloaded in a fresh worker; parameter defaults and view definitions come from current content. */
export async function prepareSnapshot(request: SnapshotRequest): Promise<PreviewSnapshot> {
  const loaded = await loadBuilding(await findBuilding(request.id, request.content));
  const args = resolveBuildingArgs(loaded.definition.params, request.params);
  let job: PreviewJob = { artifactName: request.name, camera: request.camera };
  if (request.viewName) {
    const view = loaded.definition.views?.find((candidate) => candidate.name === request.viewName);
    if (!view) throw new Error(`Unknown view "${request.viewName}"`);
    job = declaredJob(view);
  }
  let snapshot: PreviewSnapshot | undefined;
  await preparePreviewJob(
    loaded,
    args,
    job,
    request.options,
    request.cli,
    createSharedPreview(loaded, args),
    (value) => {
      snapshot = value;
    },
  );
  if (!snapshot) throw new Error('Preview preparation returned no snapshot');
  return snapshot;
}
