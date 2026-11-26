import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Structure, type Box } from '../../src/core/structure.js';
import { minecraftBlock as b } from '../../src/blocks/registry.js';
import { ChunkMeshes } from '../../src/mesh/mesher.js';
import { sceneMesher } from '../../src/mesh/scene.js';
import { packMeshData } from '../../src/mesh/cache.js';
import { LightField } from '../../src/mesh/light.js';
import { IncrementalPreview, type PreviewSnapshot } from '../../src/preview/incremental.js';
import { createSharedPreview, preparePreviewJob, type PreviewRenderOptions } from '../../src/cli/render/prepare.js';
import { runBuild } from '../../src/content/pipeline.js';
import type { LoadedBuilding } from '../../src/content/load.js';
import { createProjectContext } from '../../src/project/context.js';

const bounds: Box = { min: [-16, 0, -16], max: [32, 8, 16] };
function fixture() {
  const world = new Structure();
  for (let x = -1; x < 18; x++) world.set(x, 0, 0, b('stone'));
  world.set(15, 1, 0, b('stone_brick_stairs'));
  world.set(16, 1, 0, b('glass'));
  world.set(17, 1, 0, b('water'));
  world.set(0, 1, 0, b('glowstone'));
  world.set(-1, 1, 0, b('piston'));
  return world;
}
function loaded(build = fixture): LoadedBuilding {
  return {
    definition: { id: 'scene-fixture', name: 'Scene fixture', bounds, build },
    discovered: {
      id: 'scene-fixture',
      name: 'Scene fixture',
      root: resolve('.'),
      entry: '',
      manifestPath: '',
      editions: ['bedrock'],
      status: 'stable',
      source: 'fixture',
    },
  };
}
const cli: PreviewRenderOptions = {
  styleName: 'natural',
  noRender: true,
  light: true,
  width: 960,
  height: 720,
  ambient: 0.18,
  exposure: 1,
  curve: 1.45,
  day: 1,
};

test('shared scene computation preserves the previous mesh buffers, including light and placeholders', () => {
  const world = fixture();
  const light = LightField.compute(world);
  const old = new ChunkMeshes(world, bounds, {}, light);
  old.update();
  const shared = sceneMesher(world, bounds, {}, light);
  for (const [key, expected] of old.meshes) {
    assert.deepEqual(shared.chunk(key), expected);
    assert.deepEqual(
      packMeshData(shared.chunk(key)!, world.chunks.get(key)!.origin),
      packMeshData(expected, world.chunks.get(key)!.origin),
    );
  }
  assert.equal(shared.chunk('100,100,100'), null);
});

test('static, batch and incremental previews publish identical packed geometry for the same scene', async () => {
  const building = loaded();
  const shared = createSharedPreview(building, {});
  const job = { artifactName: 'scene-consistency', camera: 'iso' as const };
  const staticScene = await preparePreviewJob(building, {}, job, {}, cli, shared);
  let snapshot!: PreviewSnapshot;
  await preparePreviewJob(building, {}, job, {}, cli, shared, (value) => {
    snapshot = value;
  });
  const live = new IncrementalPreview();
  live.update(snapshot);
  for (const [key, buffer] of live.buffers) {
    const matching = [...staticScene.chunks].find(([prefix]) => prefix.endsWith(`/${key}`));
    assert.ok(matching, `missing static chunk ${key}`);
    assert.deepEqual(buffer.data, matching[1]);
  }
  assert.equal(live.buffers.size, staticScene.chunks.size);
  assert.equal(live.update(snapshot).rebuilt, 0);
  const cache = resolve('cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'scene-consistency-'));
  try {
    const batch = await runBuild(building, { project: createProjectContext(root), check: false });
    for (const key of live.buffers.keys()) {
      const prefix = batch.views[0].chunkFiles.find((prefix) => prefix.endsWith(`.${key}`));
      assert.ok(prefix);
      assert.deepEqual(await readFile(join(root, `${prefix}.bin`)), live.buffers.get(key)!.data);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builds isolate project outputs and generate shared view sources only once', async () => {
  const cache = resolve('cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'project-context-'));
  let mainCalls = 0,
    viewCalls = 0;
  const build = () => {
    mainCalls++;
    return fixture();
  };
  const viewBuild = () => {
    viewCalls++;
    return fixture();
  };
  const building = loaded(build);
  const definition = {
    ...building.definition,
    views: [
      { name: 'main', build },
      { name: 'view-a', build: viewBuild },
      { name: 'view-b', build: viewBuild },
    ],
  };
  try {
    const a = createProjectContext(join(root, 'a'));
    const b = createProjectContext(join(root, 'b'));
    const first = await runBuild({ ...building, definition }, { project: a, check: false });
    assert.equal(mainCalls, 1);
    assert.equal(viewCalls, 1);
    assert.equal(first.views[2].meshSource, 'reused');
    const second = await runBuild({ ...building, definition }, { project: b, check: false });
    assert.notEqual(first.cacheDir, second.cacheDir);
    for (const result of [first, second]) {
      const manifest = JSON.parse(await readFile(join(result.artifactDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.source.package, 'bewright');
      assert.ok(manifest.files.every((file: { path: string }) => !file.path.startsWith('..')));
    }
    await assert.rejects(() => runBuild(building, { project: a, artifactDir: '../escape' }), /inside the project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
