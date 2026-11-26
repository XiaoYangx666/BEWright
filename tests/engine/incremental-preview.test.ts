import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Structure, block } from '../../src/core/structure.js';
import { IncrementalPreview, type PreviewSnapshot } from '../../src/preview/incremental.js';

const stone = block('stone'),
  glass = block('glass');
function snapshot(world: Structure): PreviewSnapshot {
  return {
    palette: world.palette,
    chunks: [...world.chunks],
    region: { min: [-32, -16, -16], max: [128, 32, 32] },
    style: {},
    camera: { camera: 'iso' },
  };
}
function equivalent(incremental: IncrementalPreview, input: PreviewSnapshot) {
  const cold = new IncrementalPreview();
  cold.update(input);
  assert.deepEqual([...incremental.buffers.keys()].sort(), [...cold.buffers.keys()].sort());
  for (const [key, entry] of cold.buffers) assert.deepEqual(incremental.buffers.get(key)!.data, entry.data, key);
}
test('local edits reuse distant buffers and match full meshing, including chunk-boundary faces', () => {
  const world = new Structure();
  world.set(15, 0, 0, stone);
  world.set(16, 0, 0, stone);
  world.set(96, 0, 0, glass);
  const cache = new IncrementalPreview();
  cache.update(snapshot(world));
  const distant = cache.buffers.get('6,0,0');
  world.set(15, 0, 0, glass);
  assert.equal(cache.update(snapshot(world)).rebuilt, 2);
  assert.equal(cache.buffers.get('6,0,0'), distant);
  equivalent(cache, snapshot(world));
  world.chunks.delete('0,0,0');
  cache.update(snapshot(world));
  assert.ok(!cache.buffers.has('0,0,0'));
  equivalent(cache, snapshot(world));
});
test('semantic palette reorder does not remesh; styles and regions invalidate cached meshes', () => {
  const first = new Structure();
  first.set(-1, 0, 0, stone);
  first.set(96, 0, 0, glass);
  const cache = new IncrementalPreview();
  cache.update(snapshot(first));
  const second = new Structure();
  second.intern(glass);
  second.set(-1, 0, 0, stone);
  second.set(96, 0, 0, glass);
  assert.equal(cache.update(snapshot(second)).rebuilt, 0);
  const styled = { ...snapshot(second), style: { stone: '#ff0000' } };
  assert.equal(cache.update(styled).rebuilt, 2);
  equivalent(cache, styled);
  const clipped = {
    ...styled,
    region: { min: [0, 0, 0] as [number, number, number], max: [110, 16, 16] as [number, number, number] },
  };
  cache.update(clipped);
  equivalent(cache, clipped);
});
test('failed meshing preserves last published revision and buffers', () => {
  const world = new Structure();
  world.set(0, 0, 0, stone);
  const cache = new IncrementalPreview();
  cache.update(snapshot(world));
  const before = cache.buffers,
    revision = cache.revision;
  assert.throws(() => cache.update({ ...snapshot(world), style: { stone: 'invalid' } }));
  assert.equal(cache.buffers, before);
  assert.equal(cache.revision, revision);
});

test('changing preview bounds discards meshes from removed model chunks', () => {
  const original = new Structure();
  original.set(0, 0, 0, stone);
  original.set(0, 64, 0, stone);
  const cache = new IncrementalPreview();
  cache.update({ ...snapshot(original), region: { min: [0, 0, 0], max: [64, 80, 64] } });
  assert.ok(cache.buffers.has('0,4,0'));

  const revised = new Structure();
  revised.set(0, 0, 0, stone);
  revised.set(96, 0, 0, glass);
  const input = { ...snapshot(revised), region: { min: [0, 0, 0], max: [128, 32, 128] } } satisfies PreviewSnapshot;
  cache.update(input);
  equivalent(cache, input);
});
