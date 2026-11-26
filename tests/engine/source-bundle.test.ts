import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { registerContentResolution } from '../../src/cli/resolve-hooks.js';
import { packSourceLayout } from '../../src/content/source-bundle.js';
import { composeWorldLayout, readWorldLayout } from '../../src/content/world-layout.js';
import { WORLD_ROOT, within } from '../../src/project/paths.js';

test('a source bundle preserves layout instances, pulls in shared modules, and rebuilds after moving', async (t) => {
  await mkdir(WORLD_ROOT, { recursive: true });
  const root = await mkdtemp(join(WORLD_ROOT, 'source-bundle-test-'));
  t.after(async () => {
    assert.ok(root !== WORLD_ROOT && within(WORLD_ROOT, root));
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, 'project');
  const buildingRoot = join(project, 'buildings');
  const file = join(project, 'maps', 'tour.json');
  const output = join(root, 'tour.zip');
  const fixture = {
    'package.json': '{"name":"private-authoring-workspace","type":"module"}',
    'maps/tour.json': JSON.stringify({
      name: 'Tour', spawn: [4, 7, 8], seed: 17,
      placements: [
        { id: 'north', building: 'sample', origin: [0, 7, 1], params: { gold: false } },
        { id: 'south', building: '../buildings/sample', origin: [2, 7, 1], rotation: 90, params: { gold: true } },
      ],
    }),
    'buildings/sample/blockwright.building.json': JSON.stringify({
      schemaVersion: 1, id: 'sample', name: 'Sample', entry: './building.ts',
    }),
    'buildings/sample/building.ts': `
      import { Structure, defineBuilding } from 'bewright';
      import { color } from '../../shared/theme.js';
      export default defineBuilding({
        id: 'sample', name: 'Sample',
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        params: { gold: { type: 'boolean', default: false } },
        build({ gold }) {
          const world = new Structure();
          world.set(0, 0, 0, color(Boolean(gold)));
          return world;
        },
      });
    `,
    'buildings/sample/output/preview.png': 'preview',
    'buildings/sample/.env': 'local-only',
    'shared/theme.ts': "export { color } from './colors.js';",
    'shared/colors.ts': "import { minecraftBlock } from 'blockwright/blocks';\nexport const color = (gold: boolean) => minecraftBlock(gold ? 'gold_block' : 'stone');",
    'shared/data/extra.json': '{}',
  };
  for (const [name, value] of Object.entries(fixture)) {
    const path = join(project, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
  const layout = await readWorldLayout(file);
  const content = { roots: [buildingRoot] };
  const report = await packSourceLayout(layout, { root: project, output, include: [join(project, 'shared/data')], content });
  assert.equal(report.buildings, 1);
  assert.equal(report.placements, 2);
  assert.deepEqual(report.externalImports, []);

  const entries = unzipSync(await readFile(output));
  assert.deepEqual(Object.keys(entries).sort(), [
    'README.md',
    'layout.json',
    'source/buildings/sample/blockwright.building.json',
    'source/buildings/sample/building.ts',
    'source/package.json',
    'source/shared/colors.ts',
    'source/shared/data/extra.json',
    'source/shared/theme.ts',
  ]);
  assert.equal(strFromU8(entries['source/buildings/sample/building.ts']!), fixture['buildings/sample/building.ts']);
  assert.deepEqual(JSON.parse(strFromU8(entries['source/package.json']!)), { type: 'module' });

  const extracted = join(root, 'extracted');
  for (const [name, bytes] of Object.entries(entries)) {
    const path = join(extracted, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  const unpacked = await readWorldLayout(join(extracted, 'layout.json'));
  assert.deepEqual(unpacked.spawn, layout.spawn);
  assert.equal(unpacked.seed, layout.seed);
  assert.deepEqual(unpacked.placements.map(({ building, ...instance }) => instance),
    layout.placements.map(({ building, ...instance }) => instance));
  registerContentResolution();
  const model = await composeWorldLayout(unpacked, { edition: 'bedrock', content: {}, only: [], skipAir: false });
  assert.equal(model.world.get(0, 7, 1)?.name, 'minecraft:stone');
  assert.equal(model.world.get(2, 7, 1)?.name, 'minecraft:gold_block');

  await writeFile(join(project, 'shared/theme.ts'), "export { color } from './missing.js';");
  const failed = join(root, 'failed.zip');
  await assert.rejects(
    packSourceLayout(layout, { root: project, output: failed, include: [], content }),
    /imports missing local source \.\/missing\.js/,
  );
  await assert.rejects(readFile(failed), { code: 'ENOENT' });
});
