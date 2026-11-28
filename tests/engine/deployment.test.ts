import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { Structure } from '../../src/core/structure.js';
import { WORLD_ROOT } from '../../src/project/paths.js';
import { sidecarBinary } from '../../src/project/sidecar.js';
import { readWorldBlocks } from '../../src/targets/bedrock/readback.js';
import { writeStructureToWorld } from '../../src/targets/bedrock/world.js';

const binaries = ['blockwright-world', 'blockwright-world-init', 'blockwright-world-export'];
const hasSidecars = binaries.every((name) => existsSync(sidecarBinary(name)));
const cliPath = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

test('deployment preserves live edits and priority of unselected placements', { skip: !hasSidecars }, async (t) => {
  await mkdir(WORLD_ROOT, { recursive: true });
  const root = await mkdtemp(join(WORLD_ROOT, 'deployment-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = join(root, 'worlds', 'bedrock', 'tour');
  const run = (args: string[], status = 0) => {
    const result = spawnSync(
      process.execPath,
      ['--conditions=bewright-src', '--import', import.meta.resolve('tsx'), cliPath, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, BLOCKWRIGHT_BIN_DIR: dirname(sidecarBinary('blockwright-world')) },
      },
    );
    assert.equal(result.status, status, result.error?.message ?? result.stderr ?? result.stdout);
    return result.stdout;
  };
  const building = join(root, 'sample');
  await mkdir(building);
  await writeFile(
    join(building, 'blockwright.building.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'sample',
      name: 'Sample',
      entry: './building.mjs',
    }),
  );
  const source = (changed: boolean, removeOverlay = false) =>
    writeFile(
      join(building, 'building.mjs'),
      `
    import { AIR, defineBuilding, minecraftBlock as block, Structure } from 'bewright';
    export default defineBuilding({
      id: 'sample', name: 'Sample', bounds: { min: [0,0,0], max: [4,1,1] },
      params: { overlay: { type: 'boolean', default: false } },
      build({ overlay }) {
        const world = new Structure(false);
        if (overlay) {
          if (!${removeOverlay}) world.set(0,0,0,block('diamond_block'));
        } else {
          world.set(0,0,0,block('${changed ? 'red_wool' : 'stone'}'));
          world.set(1,0,0,block('${changed ? 'emerald_block' : 'gold_block'}'));
          world.set(2,0,0,${changed ? "block('white_concrete')" : 'AIR'});
          world.set(3,0,0,block('oak_stairs', { weirdo_direction: ${changed ? 1 : 0} }));
        }
        return world;
      },
    });
  `,
    );
  await source(false);
  const region = { min: [32, -55, 32] as [number, number, number], max: [36, -54, 33] as [number, number, number] };
  await writeFile(
    join(root, 'layout.json'),
    JSON.stringify({
      name: 'Tour',
      spawn: region.min,
      placements: [
        { id: 'base', building: './sample', origin: region.min },
        { id: 'overlay', building: './sample', origin: region.min, params: { overlay: true } },
      ],
    }),
  );
  run(['import', '--layout', 'layout.json', '--local', '--folder', 'tour']);
  run(['target', 'add', 'dev', '--layout', 'layout.json', '--world', world]);
  run(['deploy', '--adopt']);

  const edit = new Structure(false);
  edit.set(34, -55, 32, minecraftBlock('light_blue_stained_glass'));
  await writeStructureToWorld(edit, region, { world, position: region.min, backup: false, skipEmptyChunks: true });
  await source(true);
  const stopped = JSON.parse(run(['deploy', '--only', 'base', '--json'], 1));
  assert.equal(stopped.counts.conflicts, 1);
  assert.deepEqual(stopped.conflicts[0].local, [2, 0, 0]);
  assert.equal((await readWorldBlocks(world, [region])).get(33, -55, 32)?.name, 'minecraft:gold_block');

  const applied = JSON.parse(run(['deploy', '--only', 'base', '--on-conflict', 'keep-world', '--json']));
  assert.equal(applied.applied.checkedBlocks, 2);
  assert.equal(applied.applied.verification.matched, 2);
  assert.deepEqual(
    await readFile(join(applied.applied.backupPath, 'level.dat')),
    await readFile(join(world, 'level.dat')),
  );
  let live = await readWorldBlocks(world, [region]);
  assert.equal(live.get(32, -55, 32)?.name, 'minecraft:diamond_block');
  assert.equal(live.get(33, -55, 32)?.name, 'minecraft:emerald_block');
  assert.equal(live.get(34, -55, 32)?.name, 'minecraft:light_blue_stained_glass');
  assert.equal(live.get(35, -55, 32)?.states.weirdo_direction, 1);
  assert.equal(JSON.parse(run(['deploy', '--json'])).applied.placedBlocks, 0);

  await source(true, true);
  run(['deploy', '--only', 'overlay']);
  live = await readWorldBlocks(world, [region]);
  assert.equal(live.get(32, -55, 32)?.name, 'minecraft:red_wool');
  assert.equal(live.get(34, -55, 32)?.name, 'minecraft:light_blue_stained_glass');
});
