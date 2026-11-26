import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure, type Box } from '../../src/core/structure.js';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { applyBedrockWallConnections } from '../../src/blocks/connections.js';
import { meshFingerprint } from '../../src/mesh/cache.js';

/**
 * `bewright preview --all-views` meshes, lights and renders every declared view. Views
 * that differ only by camera must collapse onto one mesh, and a view with its
 * own region must not. The fingerprint is what decides that, so pin the grouping
 * rather than the timing.
 */

const stone = minecraftBlock('stone');
const wall = minecraftBlock('cobblestone_wall');

/** Two rooms joined by a wall, wide enough to give each view its own region. */
function fixture(region: Box, withExtraWall: boolean) {
  const world = new Structure();
  for (let x = region.min[0]; x < region.max[0]; x++)
    for (let z = region.min[2]; z < region.max[2]; z++) world.set(x, 0, z, stone);
  // Walls live on chunk boundaries so wall derivation reads cross-chunk neighbours.
  for (let z = region.min[2]; z < region.max[2]; z++) world.set(16, 1, z, wall);
  if (withExtraWall) for (let x = region.min[0]; x < region.max[0]; x++) world.set(x, 1, 16, wall);
  applyBedrockWallConnections(world, region);
  return world;
}

const bounds: Box = { min: [0, 0, 0], max: [48, 8, 48] };
const leftRoom: Box = { min: [0, 0, 0], max: [24, 8, 24] };
const rightRoom: Box = { min: [24, 0, 24], max: [48, 8, 48] };

test('camera-only views share one mesh and a different region does not', () => {
  const world = fixture(bounds, false);
  const overview = meshFingerprint(world, bounds, {}, false);
  // Same world, same region, same style and lighting: only the camera differs.
  assert.equal(meshFingerprint(world, bounds, {}, false), overview);
  assert.notEqual(meshFingerprint(world, leftRoom, {}, false), overview, 'a region crop is a different mesh');
  assert.notEqual(meshFingerprint(world, rightRoom, {}, false), overview);
  assert.notEqual(meshFingerprint(world, leftRoom, {}, false), meshFingerprint(world, rightRoom, {}, false));
  // Lighting and style both change the buffers, so both must split the cache.
  assert.notEqual(meshFingerprint(world, bounds, {}, true), overview);
  assert.notEqual(meshFingerprint(world, bounds, { stone: '#123456' }, false), overview);
});

test('the fingerprint covers the whole model, so it is conservative but never wrong', () => {
  // Lighting samples the entire structure, not just the meshed region, so the
  // hash must cover every chunk. An edit anywhere therefore splits the cache even
  // when the view would not have drawn it: that costs a redundant mesh, whereas
  // hashing only the region could reuse a mesh lit by a stale field.
  const plain = fixture(bounds, false);
  const extra = fixture(bounds, true);
  assert.notEqual(meshFingerprint(plain, bounds, {}, false), meshFingerprint(extra, bounds, {}, false));
  assert.notEqual(
    meshFingerprint(plain, leftRoom, {}, false),
    meshFingerprint(extra, leftRoom, {}, false),
    'a change outside the region still moves the hash',
  );
});
