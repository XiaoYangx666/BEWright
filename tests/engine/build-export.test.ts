import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineBuilding } from '../../src/content/definition.js';
import type { LoadedBuilding } from '../../src/content/load.js';
import { runBuild } from '../../src/content/pipeline.js';
import { block, Structure } from '../../src/core/structure.js';
import { buildCommand } from '../../src/cli/commands/build.js';
import { exportCommand } from '../../src/cli/commands/export.js';
import { previewCommand } from '../../src/cli/commands/preview.js';

/** Artifact overrides must stay inside the project, so use a scratch directory under cache/. */
const scratch = (suffix: string) => join('cache', `test-build-export-${suffix}`);
const definition = defineBuilding({
  id: 'export-fixture',
  name: 'Export fixture',
  bounds: { min: [0, 0, 0], max: [2, 2, 2] },
  build() {
    const world = new Structure();
    world.set(0, 0, 0, block('stone'));
    return world;
  },
});
const loaded: LoadedBuilding = {
  definition,
  discovered: {
    id: definition.id,
    name: definition.name,
    root: import.meta.dirname,
    entry: import.meta.filename,
    manifestPath: '',
    editions: ['bedrock'],
    status: 'stable',
    source: 'test',
  },
};

test('build writes no Bedrock structure files unless export is requested', async () => {
  const dir = scratch('plain');
  try {
    const result = await runBuild(loaded, { artifactDir: dir, check: false });
    assert.equal(result.exported, false);
    assert.equal(result.report.exported, false);
    assert.equal(result.structureFile, null);
    const files = await readdir(result.artifactDir);
    assert.equal(files.some((file) => file.endsWith('.mcstructure')), false);
    assert.equal(files.includes('assembly.json'), false);
    assert.ok(files.includes('report.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export: true writes the single-file structure back', async () => {
  const dir = scratch('exported');
  try {
    const result = await runBuild(loaded, { artifactDir: dir, export: true, check: false });
    assert.equal(result.exported, true);
    assert.equal(result.report.exported, true);
    assert.ok(result.structureFile);
    const files = await readdir(result.artifactDir);
    assert.ok(files.includes('export-fixture.mcstructure'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI delivers a structure beside the building without default metadata', async (t) => {
  await mkdir('cache', { recursive: true });
  const root = await mkdtemp(join('cache', 'minimal-delivery-'));
  const id = 'minimal-delivery-fixture';
  const building = './' + root;
  const log = t.mock.method(console, 'log', () => {});
  try {
    await writeFile(join(root, 'blockwright.building.json'), JSON.stringify({
      schemaVersion: 1, id, name: 'Delivery fixture', entry: './building.mjs',
    }));
    await writeFile(join(root, 'building.mjs'), `
import { block, defineBuilding, Structure } from 'bewright';
export default defineBuilding({
  id: '${id}', name: 'Delivery fixture',
  bounds: { min: [0, 0, 0], max: [2, 2, 2] },
  cache: ${JSON.stringify(join(root, 'mesh'))},
  build() { const world = new Structure(); world.set(0, 0, 0, block('stone')); return world; },
});
`);
    const out = join(root, 'output');
    assert.equal(await buildCommand([building]), 0);
    await previewCommand([building, '--no-render']);
    await assert.rejects(() => readdir(out), { code: 'ENOENT' });
    await exportCommand([building, '--edition', 'bedrock']);
    assert.deepEqual(await readdir(join(out, 'bedrock')), [`${id}.mcstructure`]);
    assert.equal(log.mock.calls.length, 3);
    assert.equal(await buildCommand([building, '--report']), 0);
    assert.deepEqual((await readdir(join(out, 'diagnostics'))).sort(), ['manifest.json', 'report.json', 'scenes.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
