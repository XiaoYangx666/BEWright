import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure, type Box } from '../../src/core/structure.js';
import { minecraftBlock as b } from '../../src/blocks/registry.js';
import { checkTraversal, collisionBoxes, type TraversalTarget, type TraversalZone } from '../../src/authoring/traversal.js';

const stone = b('stone');
const stair = (direction: number) => b('stone_brick_stairs', { weirdo_direction: direction, upside_down_bit: false });
const box = (min: [number, number, number], max: [number, number, number]): Box => ({ min, max });
const zone = (id: string | null, x: number, footY: number, z: number) => ({
  ...(id === null ? {} : { id }),
  box: box([x, footY, z], [x + 1, footY + 1, z + 1]),
  footY,
});
const status = (world: Structure, bounds: Box, start: TraversalZone, target: TraversalTarget) =>
  checkTraversal(world, { bounds, start, targets: [target] }).routes[0]!;

function threeStepFlight(direction = 0, includeLanding = true) {
  const world = new Structure();
  world.set(-2, 0, 0, stone); world.set(-1, 0, 0, stone);
  world.set(0, 0, 0, stair(direction));
  world.set(1, 1, 0, stair(direction));
  world.set(2, 2, 0, stair(direction));
  if (includeLanding) world.set(3, 2, 0, stone);
  return world;
}

test('known-answer stair fixture ascends by walking and the reverse only by jumping', () => {
  const bounds = box([-3, 0, -1], [5, 7, 2]);
  const start = zone(null, -2, 1, 0) as TraversalZone;
  const target = zone('upper', 3, 3, 0) as TraversalTarget;
  const walkOnly = (world: Structure) => checkTraversal(world, { bounds, start, targets: [target], player: { maxStepUp: .6 } }).routes[0]!;

  const forward = walkOnly(threeStepFlight(0));
  assert.equal(forward.status, 'reachable');
  assert.ok(forward.path && forward.path.some(([, y]) => y === 1.5) && forward.path.some(([, y]) => y === 2.5));
  assert.ok((forward.minimumHeadroom ?? 0) >= 1.8);
  // Against the facing every riser is a full block, so walking alone fails...
  assert.equal(walkOnly(threeStepFlight(1)).status, 'unreachable');
  // ...but the default model may jump one block, which opens that reverse side.
  assert.equal(status(threeStepFlight(1), bounds, start, target).status, 'reachable');
});

test('a floor closing the stair head and a missing connection landing are rejected', () => {
  const bounds = box([-3, 0, -1], [7, 7, 2]);
  const start = zone(null, -2, 1, 0) as TraversalZone;
  const target = zone('upper', 3, 3, 0) as TraversalTarget;
  const closed = threeStepFlight();
  closed.set(2, 4, 0, stone); closed.set(3, 4, 0, stone);
  assert.equal(status(closed, bounds, start, target).status, 'unreachable');

  const missing = threeStepFlight(0, false);
  missing.set(4, 2, 0, stone);
  const separatedTarget = zone('upper-across-gap', 4, 3, 0) as TraversalTarget;
  assert.equal(status(missing, bounds, start, separatedTarget).status, 'unreachable');
});

function corridor(withBypass: boolean) {
  const world = new Structure();
  for (let x = 0; x <= 4; x++) world.set(x, 0, 0, stone);
  if (withBypass) for (let x = 0; x <= 4; x++) world.set(x, 0, 1, stone);
  return world;
}

test('solid blockage is unreachable, while an actual alternate connection is found', () => {
  const bounds = box([-1, 0, -1], [6, 5, 3]);
  const start = zone(null, 0, 1, 0) as TraversalZone;
  const target = zone('far-end', 4, 1, 0) as TraversalTarget;
  const blocked = corridor(false);
  blocked.set(2, 1, 0, stone); blocked.set(2, 2, 0, stone);
  assert.equal(status(blocked, bounds, start, target).status, 'unreachable');

  const bypass = corridor(true);
  bypass.set(2, 1, 0, stone); bypass.set(2, 2, 0, stone);
  const route = status(bypass, bounds, start, target);
  assert.equal(route.status, 'reachable');
  assert.ok(route.path?.some(([, , z]) => z > 1), 'reported route must use the modeled bypass');
});

test('unsupported collision in the only bottleneck is unknown but cannot hide a supported bypass', () => {
  const bounds = box([-1, 0, -1], [6, 5, 3]);
  const start = zone(null, 0, 1, 0) as TraversalZone;
  const target = zone('far-end', 4, 1, 0) as TraversalTarget;
  const door = b('wooden_door', {
    door_hinge_bit: false,
    'minecraft:cardinal_direction': 'south',
    open_bit: false,
    upper_block_bit: false,
  });
  const bottleneck = corridor(false); bottleneck.set(2, 1, 0, door);
  assert.equal(status(bottleneck, bounds, start, target).status, 'unknown');

  const bypass = corridor(true); bypass.set(2, 1, 0, door);
  const route = status(bypass, bounds, start, target);
  assert.equal(route.status, 'reachable');
  assert.ok(route.path?.some(([, , z]) => z > 1), 'known success must be a supported route around the unknown cell');
});

test('collision support preserves model semantics independently of preview transparency', () => {
  assert.deepEqual(collisionBoxes(b('water', { liquid_depth: 0 })), { kind: 'supported', boxes: [] });
  for (const state of [b('glass'), b('oak_leaves', { persistent_bit: true, update_bit: false })]) {
    const support = collisionBoxes(state);
    assert.equal(support.kind, 'supported');
    assert.deepEqual(support.kind === 'supported' ? support.boxes : [], [[0, 0, 0, 1, 1, 1]]);
  }
  assert.equal(collisionBoxes(b('wooden_door', {
    door_hinge_bit: false,
    'minecraft:cardinal_direction': 'south',
    open_bit: false,
    upper_block_bit: false,
  })).kind, 'unknown');
});

test('common building blocks resolve to supported collision instead of poisoning routes', () => {
  const supported = [
    b('cobblestone_wall', {
      wall_post_bit: true, wall_connection_type_east: 'tall', wall_connection_type_west: 'short',
      wall_connection_type_north: 'none', wall_connection_type_south: 'none',
    }),
    b('lantern', { hanging: true }),
    b('lantern', { hanging: false }),
    b('flower_pot'),
    b('azalea_leaves', { persistent_bit: true, update_bit: false }),
    b('cherry_leaves', { persistent_bit: true, update_bit: false }),
  ];
  for (const state of supported) {
    const support = collisionBoxes(state);
    assert.equal(support.kind, 'supported', `${state.name} must not be unknown`);
    assert.ok(support.kind === 'supported' && support.boxes.length > 0, `${state.name} needs a collision box`);
  }
  assert.deepEqual(collisionBoxes(b('chain', { pillar_axis: 'y' })), { kind: 'supported', boxes: [] });
});

test('a one-block rise is jumpable while a two-block rise stays unreachable', () => {
  const bounds = box([0, 0, 0], [5, 6, 1]);
  const start = zone(null, 0, 1, 0) as TraversalZone;
  const flat = (steps: number) => {
    const world = new Structure();
    for (let x = 0; x <= 2; x++) world.set(x, 0, 0, stone);
    for (let y = 0; y <= steps; y++) world.set(3, y, 0, stone);
    return world;
  };
  assert.equal(status(flat(1), bounds, start, zone('one', 3, 2, 0) as TraversalTarget).status, 'reachable');
  assert.equal(status(flat(2), bounds, start, zone('two', 3, 3, 0) as TraversalTarget).status, 'unreachable');
});
