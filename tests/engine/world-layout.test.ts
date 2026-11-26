import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import nbt from 'prismarine-nbt';
import { composeWorldLayout, readWorldLayout } from '../../src/content/world-layout.js';
import { WORLD_ROOT, within } from '../../src/project/paths.js';
import { sidecarBinary } from '../../src/project/sidecar.js';
import { type Vec3 } from '../../src/core/structure.js';

async function fixture(t: TestContext) {
  await mkdir(WORLD_ROOT, { recursive: true });
  const root = await mkdtemp(join(WORLD_ROOT, 'layout-test-'));
  t.after(async () => {
    assert.ok(root !== WORLD_ROOT && within(WORLD_ROOT, root));
    await rm(root, { recursive: true, force: true });
  });
  const buildingDir = join(root, 'sample');
  await mkdir(buildingDir);
  await writeFile(join(buildingDir, 'blockwright.building.json'), JSON.stringify({
    schemaVersion: 1, id: 'sample', name: 'Sample', entry: './building.mjs', editions: ['bedrock', 'java'],
  }));
  await writeFile(join(buildingDir, 'building.mjs'), `
    import { AIR, Structure, minecraftBlock as block, defineBuilding } from 'bewright';
    export default defineBuilding({
      id: 'sample', name: 'Sample', editions: ['bedrock', 'java'],
      bounds: { min: [-2, 3, 4], max: [1, 4, 6] },
      params: { overlay: { type: 'boolean', default: false } },
      build({ overlay }) {
        const model = new Structure();
        if (overlay) {
          model.set(-2, 3, 5, AIR);
          model.set(-2, 3, 4, block('oak_stairs', { weirdo_direction: 0, upside_down_bit: false }));
        } else {
          model.set(-2, 3, 4, block('stone'));
          model.set(-1, 3, 4, block('gold_block'));
          model.set(0, 3, 4, block('emerald_block'));
          model.set(-1, 3, 5, block('diamond_block'));
        }
        return model;
      },
    });
  `);
  const file = join(root, 'tour.json');
  await writeFile(file, JSON.stringify({
    name: 'Tour', spawn: [4, 12, 15], seed: 7,
    placements: [
      { id: 'base', building: './sample', origin: [-1, 12, 15] },
      { id: 'far', building: './sample', origin: [1603, 12, -7] },
      { id: 'overlay', building: './sample', origin: [-1, 12, 15], rotation: 90, params: { overlay: true } },
    ],
  }));
  return { file, root };
}

test('layout composes instances in file order, rotates states, and distinguishes void from explicit air', async (t) => {
  const { file } = await fixture(t);
  const layout = await readWorldLayout(file);
  const model = await composeWorldLayout(layout, { edition: 'bedrock', content: {}, only: ['overlay', 'base'], skipAir: false });
  assert.deepEqual(model.placements.map(({ id, overlaps }) => [id, overlaps]), [['base', 0], ['overlay', 2]]);
  assert.deepEqual(model.bounds, { min: [-1, 12, 15], max: [2, 13, 17] });
  assert.equal(model.world.get(-1, 12, 15)?.name, 'minecraft:air');
  assert.equal(model.world.get(0, 12, 15)?.states.weirdo_direction, 2);
  assert.equal(model.world.get(0, 12, 16)?.name, 'minecraft:diamond_block');
  assert.equal(model.cells, 4);
  assert.equal(model.explicitAir, 1);
  const preserved = await composeWorldLayout(layout, { edition: 'bedrock', content: {}, only: [], skipAir: true });
  assert.equal(preserved.world.get(-1, 12, 15)?.name, 'minecraft:stone');
  assert.equal(preserved.world.get(1603, 12, -7)?.name, 'minecraft:stone');
  assert.equal(preserved.explicitAir, 0);
  await assert.rejects(
    composeWorldLayout(layout, { edition: 'bedrock', content: {}, only: ['missing'], skipAir: false }),
    /Unknown placement id: missing/,
  );
});

const reader = sidecarBinary('blockwright-world-export');
const hasSidecars = [reader, sidecarBinary('blockwright-world'), sidecarBinary('blockwright-world-init')].every(existsSync);

test('layout CLI writes one Bedrock world and overwrites selected cells with one backup per import', { skip: !hasSidecars }, async (t) => {
  const { file, root } = await fixture(t);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [
    '--conditions=bewright-src', '--import', 'tsx', 'src/cli/index.ts', 'import', '--layout', file, '--json', ...args,
  ], { encoding: 'utf8', windowsHide: true }));
  const target = { dir: join(root, 'tour'), args: ['--worlds-dir', root, '--folder', 'tour'] };
  const plan = cli(...target.args, '--dry-run');
  assert.equal(plan.placements[2].overlaps, 2);
  assert.equal(existsSync(target.dir), false);
  const created = cli(...target.args, '--only', 'base', '--only', 'far');
  assert.equal(created.placedBlocks, 8);
  assert.equal(created.touchedChunks, 4);

  const output = join(root, 'sample.mcstructure');
  async function blockAt(world: string, [x, y, z]: Vec3) {
    execFileSync(reader, ['--world', world, '--output', output, '--x', String(x), '--y', String(y), '--z', String(z),
      '--size-x', '1', '--size-y', '1', '--size-z', '1']);
    const { structure } = nbt.simplify(nbt.parseUncompressed(await readFile(output), 'little'));
    return structure.palette.default.block_palette[structure.block_indices[0][0]];
  }

  cli('--world', target.dir, '--only', 'overlay', '--skip-air');
  assert.equal((await blockAt(target.dir, [-1, 12, 15])).name, 'minecraft:stone');
  const update = cli('--world', target.dir, '--only', 'overlay');
  assert.equal(update.placedBlocks, 2);
  assert.equal(update.explicitAir, 1);
  assert.equal((await blockAt(target.dir, [-1, 12, 15])).name, 'minecraft:air');
  assert.equal((await blockAt(target.dir, [0, 12, 15])).states.weirdo_direction, 2);
  assert.equal((await blockAt(target.dir, [0, 12, 16])).name, 'minecraft:diamond_block');
  assert.equal((await blockAt(target.dir, [1603, 12, -7])).name, 'minecraft:stone');
  assert.equal((await blockAt(update.backupPath, [-1, 12, 15])).name, 'minecraft:stone');
  assert.equal((await readdir(root)).filter((name) => name.startsWith('tour.blockwright-backup-')).length, 2);
});
