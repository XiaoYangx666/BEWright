import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Structure, AIR, block } from '../../src/core/structure.js';
import { cachedStructureStage } from '../../src/content/generation-cache.js';

test('a generation stage reuses intact snapshots and rebuilds after source edits or corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'blockwright-generation-source-'));
  mkdirSync('cache', { recursive: true });
  const sourceFile = join(root, 'recipe.txt');
  const laterStageFile = join(root, 'later-stage.txt');
  const cacheDir = mkdtempSync(join('cache', 'test-generation-stage-'));
  let builds = 0;
  const build = () => {
    builds++;
    const world = new Structure();
    world.fill({ min: [-1, -17, 15], max: [0, 18, 16] }, block('stone'));
    world.set(-1, 0, 15, AIR);
    return world;
  };
  const request = { key: 'fixture', sources: [sourceFile], inputs: { seed: 1 }, cacheDir, build };
  try {
    writeFileSync(sourceFile, 'first');
    const cold = cachedStructureStage(request);
    assert.equal(cold.source, 'built');
    const warm = cachedStructureStage(request);
    assert.equal(warm.source, 'cached');
    assert.equal(builds, 1);
    assert.deepEqual(warm.world.inspect(), cold.world.inspect());
    assert.deepEqual([...warm.world.meshVersions], [...cold.world.meshVersions]);
    assert.equal(warm.world.get(-1, 0, 15)?.name, 'minecraft:air');
    warm.world.set(-1, 0, 15, block('dirt'));
    assert.equal(cold.world.get(-1, 0, 15)?.name, 'minecraft:air', 'loaded stages are independent');

    writeFileSync(laterStageFile, 'a changed later stage');
    assert.equal(cachedStructureStage(request).source, 'cached', 'unrelated stages keep their cache');

    assert.equal(cachedStructureStage({ ...request, inputs: { seed: 2 } }).source, 'built');
    assert.equal(builds, 2);

    writeFileSync(sourceFile, 'changed');
    assert.equal(cachedStructureStage(request).source, 'built');
    assert.equal(builds, 3);
    writeFileSync(join(cacheDir, 'fixture.bin'), Buffer.from('corrupt cache'));
    assert.equal(cachedStructureStage(request).source, 'built');
    assert.equal(builds, 4);
    assert.ok(readFileSync(join(cacheDir, 'fixture.bin')).length > 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
