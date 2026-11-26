import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { previewStyles } from '../../blocks/materials.js';
import { PROJECT_ROOT, atomicWrite } from '../../project/paths.js';
import { parseParamFlags } from '../../content/definition.js';
import { findBuilding } from '../../content/discover.js';
import { loadBuilding } from '../../content/load.js';
import { buildingOutputDir } from '../../content/output.js';
import { renderScenes } from '../render/render.js';
import {
  createSharedPreview,
  declaredJob,
  preparePreviewJob,
  type PreparedJob,
  type PreviewJob,
  type PreviewRenderOptions,
  type SnapshotRequest,
} from '../render/prepare.js';
import { buildingArgs, CONTENT_OPTION, PARAM_OPTION, contentOptions, csv } from '../args.js';
import type { PreviewOptions } from '../../preview/selection.js';
import type { PreviewSnapshot } from '../../preview/incremental.js';
import { generateModel, runModelCheck } from '../../content/check.js';
import type { Diagnostic } from '../../authoring/diagnostic-core.js';

export const PREVIEW_HELP = `bewright preview <building> [options]

Builds the model, meshes the selected region and renders a headless PNG into
the building's output/previews/ directory.

  --list                  list the building's declared views and exit
  --view-name <name>      use one declared view: its region, camera and style
  --all-views             render every declared view in one run
  --focus <id>            frame one component, keeping nearby context
  --isolate a,b           show only these components
  --hide a,b              hide these components
  --padding N             focus context in blocks (default 3)
  --cut axis:max          keep axis < max
  --slice axis:min:max    keep min <= axis < max
  --view iso|top|front|side   ad-hoc camera when no declared view is used
  --style natural|contrast    preview palette; declared view styles layer on top
  --name <slug>           artifact name (default: preview)
  --param k=v             building parameter override
  --width/--height N      viewport size (default 1280x960)
  --no-render             mesh only, skip the browser
  --out DIR               override the preview directory
  --report                save preview diagnostics and render metrics
  --check                 run current-model checks and highlight findings (static preview)
  --light                 enable block-light propagation (default: off)
  --ambient N             light ambient floor, default 0.18 (needs --light)
  --exposure N            light brightness multiplier, default 1 (needs --light)
  --curve N               light falloff exponent, default 1.45 (needs --light)
  --day N                 sky light day factor, default 1 (0 = night, needs --light)
  --agent                 persistent agent-mode preview: no on-page panel,
                          scriptable /camera and /screenshot endpoints
  --watch                 persistent interactive preview with incremental updates
  --port N                live server port (default 0: choose an available port)
  --watch-path <path>      additionally watch a shared dependency directory (repeatable)
  --json                  print the render metrics`;

const VIEWS = ['iso', 'top', 'front', 'side'] as const;

function parseSlice(cut: string | undefined, slice: string | undefined): PreviewOptions['slice'] {
  if (cut && slice) throw new Error('Choose --cut or --slice');
  if (!cut && !slice) return undefined;
  const parts = (cut ?? slice)!.split(':');
  if (
    !['x', 'y', 'z'].includes(parts[0]) ||
    parts.length !== (cut ? 2 : 3) ||
    parts.slice(1).some((part) => !part.trim() || !Number.isSafeInteger(Number(part)))
  )
    throw new Error('Expected --cut axis:max or --slice axis:min:max with integer limits');
  return { axis: parts[0] as 'x' | 'y' | 'z', min: cut ? undefined : Number(parts[1]), max: Number(parts.at(-1)) };
}

export async function previewCommand(argv: string[], capture?: (snapshot: PreviewSnapshot) => void) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      content: CONTENT_OPTION,
      param: PARAM_OPTION,
      focus: { type: 'string' },
      isolate: { type: 'string' },
      hide: { type: 'string' },
      padding: { type: 'string' },
      cut: { type: 'string' },
      slice: { type: 'string' },
      view: { type: 'string' },
      'view-name': { type: 'string' },
      'all-views': { type: 'boolean' },
      list: { type: 'boolean' },
      name: { type: 'string', default: 'preview' },
      style: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      background: { type: 'string' },
      'no-render': { type: 'boolean' },
      check: { type: 'boolean' },
      light: { type: 'boolean' },
      agent: { type: 'boolean' },
      ambient: { type: 'string' },
      exposure: { type: 'string' },
      curve: { type: 'string' },
      day: { type: 'string' },
      json: { type: 'boolean' },
      out: { type: 'string' },
      report: { type: 'boolean' },
      watch: { type: 'boolean' },
      port: { type: 'string' },
      'watch-path': { type: 'string', multiple: true },
    },
    strict: true,
  });

  const id = positionals[0];
  if (!id) throw new Error('Usage: bewright preview <building> [--view-name name | --all-views] [--list]');
  // Lighting parameters apply to static renders and seed the watch server.
  const ambient = values.ambient === undefined ? 0.18 : Number(values.ambient);
  const exposure = values.exposure === undefined ? 1 : Number(values.exposure);
  const curve = values.curve === undefined ? 1.45 : Number(values.curve);
  if (!Number.isFinite(ambient) || ambient < 0 || ambient > 0.9)
    throw new Error('--ambient must be a number from 0 to 0.9');
  if (!Number.isFinite(exposure) || exposure < 0.4 || exposure > 2.5)
    throw new Error('--exposure must be a number from 0.4 to 2.5');
  if (!Number.isFinite(curve) || curve < 0.6 || curve > 3) throw new Error('--curve must be a number from 0.6 to 3');
  const day = values.day === undefined ? 1 : Number(values.day);
  if (!Number.isFinite(day) || day < 0 || day > 1) throw new Error('--day must be a number from 0 to 1');
  const styleName = values.style ?? 'natural';
  if (!Object.hasOwn(previewStyles, styleName)) throw new Error(`Unknown preview style: ${styleName}`);
  const camera = (values.view ?? 'iso') as (typeof VIEWS)[number];
  if (!VIEWS.includes(camera)) throw new Error(`--view must be one of ${VIEWS.join(', ')}`);
  const width = values.width === undefined ? 1280 : Number(values.width);
  const height = values.height === undefined ? 960 : Number(values.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16)
    throw new Error('--width/--height must be integers >= 16');

  const options: PreviewOptions = {
    focus: values.focus,
    isolate: csv(values.isolate),
    hide: csv(values.hide),
    padding: values.padding === undefined ? undefined : Number(values.padding),
    slice: parseSlice(values.cut, values.slice),
  };
  const cli: PreviewRenderOptions = {
    styleName,
    noRender: Boolean(values['no-render']),
    width,
    height,
    background: values.background,
    light: values.light === true,
    ambient,
    exposure,
    curve,
    day,
    findings: [] as readonly Diagnostic[],
  };

  // --agent implies the persistent server: it is the watch flow, stripped for scripts.
  const watch = values.watch || values.agent;
  if (watch && values.check)
    throw new Error('--check currently supports static preview; use bewright check for live-model diagnostics');
  if (watch && !capture) {
    if (values.list || values['all-views'] || values['no-render'])
      throw new Error('--watch requires a single view and cannot be combined with --list/--all-views/--no-render');
    if (values.out || values.report) throw new Error('--out and --report require a static preview');
    const port = Number(values.port ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('--port must be an integer from 0 to 65535');
    const discovered = await findBuilding(id, contentOptions(values));
    const { startLivePreview } = await import('../render/live.js');
    await startLivePreview({
      request: {
        id,
        content: contentOptions(values),
        params: parseParamFlags(values.param ?? []),
        viewName: values['view-name'],
        name: values.name!,
        camera,
        options,
        cli,
      } satisfies SnapshotRequest,
      root: discovered.root,
      port,
      watchPaths: values['watch-path'] ?? [],
      background: values.background,
      lighting: { ambient, exposure, curve, day },
      agent: values.agent === true,
    });
    return;
  }
  if (!watch && (values.port !== undefined || values['watch-path']))
    throw new Error('--port/--watch-path require --watch');
  if (!watch && values.agent) throw new Error('--agent requires --watch'); // unreachable; agent implies watch
  const loaded = await loadBuilding(await findBuilding(id, contentOptions(values)));
  const previewDir = values.out ? resolve(values.out) : buildingOutputDir(loaded, 'previews');
  if (values.report) cli.reportDir = previewDir;
  const declared = loaded.definition.views ?? [];

  if (values.list) {
    const listed = declared.map((view) => ({
      name: view.name,
      view: view.view ?? 'iso',
      region: view.region ?? null,
      eye: view.eye ?? null,
      target: view.target ?? null,
      direction: view.direction ?? null,
      fit: view.fit ?? 'geometry',
      style: view.style ? Object.keys(view.style) : [],
    }));
    if (values.json) {
      console.log(JSON.stringify(listed, null, 2));
      return;
    }
    if (!listed.length) {
      console.log(`${id}: no declared views`);
      return;
    }
    for (const view of listed)
      console.log(
        `${view.name.padEnd(20)} ${view.view.padEnd(5)} ${view.eye ? `eye ${JSON.stringify(view.eye)}` : view.direction ? `dir ${JSON.stringify(view.direction)}` : 'auto'}${view.style.length ? `  style: ${view.style.join(',')}` : ''}`,
      );
    return;
  }

  let jobs: PreviewJob[];
  if (values['all-views']) {
    if (!declared.length) throw new Error(`Building "${id}" declares no views`);
    jobs = declared.map(declaredJob);
  } else if (values['view-name']) {
    const view = declared.find((candidate) => candidate.name === values['view-name']);
    if (!view)
      throw new Error(
        `Unknown view "${values['view-name']}". Declared: ${declared.map((candidate) => candidate.name).join(', ') || '(none)'}`,
      );
    jobs = [declaredJob(view)];
  } else {
    const name = values.name!;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('--name must be a lowercase slug');
    jobs = [{ artifactName: name, camera }];
  }

  const args = buildingArgs(loaded, values);
  const shared = createSharedPreview(loaded, args);
  if (values.check) {
    if (jobs.some((job) => job.build && job.build !== loaded.definition.build))
      throw new Error('--check requires views of the main model so findings match the displayed geometry');
    const generated = generateModel(loaded.definition, { args }, () => shared.models.generate());
    cli.findings = (await runModelCheck(loaded, generated)).diagnostics;
  }
  const prepared: PreparedJob[] = [];
  for (const job of jobs) prepared.push(await preparePreviewJob(loaded, args, job, options, cli, shared, capture));
  if (capture) return;

  // One browser pass for every prepared view: launching a renderer per view was
  // most of an --all-views run. Views that share geometry also share buffers, so
  // the page decodes each chunk once and reuses it across scenes.
  const drawable = prepared.filter((job) => job.scene);
  if (drawable.length) {
    await mkdir(previewDir, { recursive: true });
    const chunks = new Map<string, Uint8Array>();
    for (const job of drawable) for (const [key, value] of job.chunks) chunks.set(key, value);
    const results = await renderScenes({
      scenes: Object.fromEntries(drawable.map((job) => [job.run.name, job.scene!])),
      chunks,
      outDir: previewDir,
      width: cli.width,
      height: cli.height,
      background: cli.background,
      viewOverrides: Object.fromEntries(drawable.map((job) => [job.run.name, job.run.camera])),
    });
    const byName = new Map(results.map((result) => [result.name, result]));
    await Promise.all(
      drawable.map(async (job, index) => {
        const result = byName.get(job.run.name);
        if (!result) throw new Error(`Renderer returned no result for ${job.run.name}`);
        if (values.report) {
          await atomicWrite(
            join(previewDir, `${job.run.name}.render.json`),
            JSON.stringify({ building: loaded.definition.id, results: [result] }, null, 2),
          );
        }
        drawable[index] = {
          ...job,
          run: { ...job.run, image: relative(PROJECT_ROOT, result.screenshot).replaceAll('\\', '/') },
        };
        prepared[prepared.indexOf(job)] = drawable[index]!;
      }),
    );
  }

  const runs = prepared.map((job) => job.run);
  if (values.json) {
    console.log(JSON.stringify(jobs.length > 1 ? runs : runs[0], null, 2));
    return;
  }
  for (const run of runs) console.log(run.image ?? `${run.name}：${run.occupied} 格，${run.quads} 个网格面`);
}
