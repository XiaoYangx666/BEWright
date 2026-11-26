import test from 'node:test';
import assert from 'node:assert/strict';
import { block, Structure, type Box } from '../../src/core/structure.js';
import { applyBedrockWallConnections, wallConnectionsAt } from '../../src/blocks/connections.js';

const REGION: Box = { min: [-4, 0, -4], max: [20, 12, 20] };

function wallLine(length: number) {
  const world = new Structure();
  for (let x = 0; x < length; x++) {
    world.set(x, 1, 0, block('cobblestone_wall'));
    world.set(x, 0, 0, block('stone'));
  }
  return world;
}

test('straight wall spans connect as short rails and drop the mid-span post', () => {
  const world = wallLine(3);
  assert.equal(applyBedrockWallConnections(world, REGION), 3);
  const end = world.get(0, 1, 0)!.states;
  assert.equal(end.wall_connection_type_east, 'short');
  assert.equal(end.wall_connection_type_west, 'none');
  assert.equal(end.wall_post_bit, true);
  const middle = world.get(1, 1, 0)!.states;
  assert.equal(middle.wall_connection_type_east, 'short');
  assert.equal(middle.wall_connection_type_west, 'short');
  assert.equal(middle.wall_connection_type_north, 'none');
  assert.equal(middle.wall_connection_type_south, 'none');
  assert.equal(middle.wall_post_bit, false);
});

test('corner walls keep the full-height post while both arms connect', () => {
  const world = new Structure();
  for (const [x, z] of [[0, 0], [1, 0], [1, 1]] as const) {
    world.set(x, 1, z, block('cobblestone_wall'));
    world.set(x, 0, z, block('stone'));
  }
  applyBedrockWallConnections(world, REGION);
  const corner = world.get(1, 1, 0)!.states;
  assert.equal(corner.wall_connection_type_west, 'short');
  assert.equal(corner.wall_connection_type_south, 'short');
  assert.equal(corner.wall_connection_type_north, 'none');
  assert.equal(corner.wall_connection_type_east, 'none');
  assert.equal(corner.wall_post_bit, true);
});

test('walls connect to any non-leaf neighbour but never to leaves or air', () => {
  const world = new Structure();
  world.set(0, 1, 0, block('cobblestone_wall'));
  world.set(1, 1, 0, block('stone_bricks'));
  world.set(-1, 1, 0, block('oak_fence'));
  world.set(0, 1, -1, block('oak_leaves'));
  world.set(0, 1, 1, block('air'));
  const connections = wallConnectionsAt(world, 0, 1, 0);
  assert.equal(connections.east, true);
  assert.equal(connections.west, true);
  assert.equal(connections.north, false);
  assert.equal(connections.south, false);
  assert.equal(connections.post, false);
});

test('hard-coded connections are replaced the same way the Java exporter replaces them', () => {
  const world = new Structure();
  world.set(0, 1, 0, block('cobblestone_wall', {
    wall_post_bit: true,
    wall_connection_type_east: 'short',
    wall_connection_type_west: 'short',
  }));
  world.set(0, 0, 0, block('stone'));
  applyBedrockWallConnections(world, REGION);
  const states = world.get(0, 1, 0)!.states;
  assert.equal(states.wall_connection_type_east, 'none');
  assert.equal(states.wall_connection_type_west, 'none');
  assert.equal(states.wall_post_bit, true);
});

test('shared palette entries split per derived state and derivation is idempotent', () => {
  const world = wallLine(3);
  assert.equal(world.getId(0, 1, 0), world.getId(1, 1, 0));
  applyBedrockWallConnections(world, REGION);
  assert.notEqual(world.getId(0, 1, 0), world.getId(1, 1, 0));
  assert.notEqual(world.getId(1, 1, 0), world.getId(2, 1, 0));
  const revision = world.revision;
  assert.equal(applyBedrockWallConnections(world, REGION), 0);
  assert.equal(world.revision, revision);
});

test('already-derived walls outside the region are untouched; region walls derive from global neighbours', () => {
  const world = new Structure();
  for (let z = -1; z <= 1; z++) world.set(0, 1, z, block('cobblestone_wall'));
  const narrow: Box = { min: [0, 0, 0], max: [1, 2, 1] };
  assert.equal(applyBedrockWallConnections(world, narrow), 1);
  const inside = world.get(0, 1, 0)!.states;
  assert.equal(inside.wall_connection_type_north, 'short');
  assert.equal(inside.wall_connection_type_south, 'short');
  assert.equal(inside.wall_post_bit, false);
  assert.deepEqual(world.get(0, 1, -1)!.states, {});
});
