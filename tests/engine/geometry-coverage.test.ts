import test from 'node:test';
import assert from 'node:assert/strict';
import { materials } from '../../src/blocks/materials.js';
import { visualGeometry } from '../../src/blocks/shapes.js';
import { minecraftBlock } from '../../src/blocks/registry.js';

/** Every state of these families must resolve to real geometry, not a marker. */
const FAMILIES: readonly { label: string; name: string; states?: Record<string, string | number | boolean> }[] = [
  { label: 'leaves', name: 'acacia_leaves' },
  {
    label: 'wall', name: 'andesite_wall',
    states: { wall_post_bit: true, wall_connection_type_east: 'tall', wall_connection_type_west: 'short', wall_connection_type_north: 'none', wall_connection_type_south: 'none' },
  },
  { label: 'doubleSlab', name: 'acacia_double_slab' },
  { label: 'namedDoubleSlab', name: 'double_cut_copper_slab' },
  { label: 'trapdoor', name: 'acacia_trapdoor' },
  { label: 'door', name: 'acacia_door' },
  { label: 'doorUpper', name: 'acacia_door', states: { upper_block_bit: true } },
  { label: 'doorOpen', name: 'acacia_door', states: { open_bit: true, door_hinge_bit: true } },
  { label: 'fenceGate', name: 'acacia_fence_gate' },
  { label: 'button', name: 'acacia_button' },
  { label: 'pressurePlate', name: 'acacia_pressure_plate' },
  { label: 'sapling', name: 'acacia_sapling' },
  { label: 'candle', name: 'black_candle' },
  { label: 'standingSign', name: 'acacia_standing_sign' },
  { label: 'wallSign', name: 'acacia_wall_sign' },
  { label: 'hangingSign', name: 'acacia_hanging_sign' },
];

test('common fitting families resolve to unit-cube geometry without markers', () => {
  for (const { label, name, states } of FAMILIES) {
    const geometry = visualGeometry(minecraftBlock(name, states), () => null);
    assert.equal(geometry.placeholder, undefined, `${label} (${name}) must be modeled`);
    assert.ok(geometry.boxes.length > 0, `${label} (${name}) needs boxes`);
    for (const box of geometry.boxes)
      assert.ok(box.every(value => value >= 0 && value <= 1), `${label} (${name}) box outside the unit cube: ${box}`);
  }
});

test('cube-like blocks with mixed collision data render as cubes', () => {
  for (const name of ['bone_block', 'chiseled_quartz_block', 'bedrock']) {
    assert.equal(materials[name].geometry, 'cube', name);
    assert.deepEqual(visualGeometry(minecraftBlock(name), () => null).boxes, [[0, 0, 0, 1, 1, 1]]);
  }
});

test('falling water fills its cell while shallow water retains its level', () => {
  const boxes = (depth: number) => visualGeometry(minecraftBlock('water', { liquid_depth: depth }), () => null).boxes;
  assert.deepEqual(boxes(0), [[0, 0, 0, 1, 1, 1]]);
  assert.deepEqual(boxes(7), [[0, 0, 0, 1, 0.34375, 1]]);
  assert.deepEqual(boxes(8), [[0, 0, 0, 1, 1, 1]]);
});

test('geometry coverage stays above the recorded floor', () => {
  const modeled = Object.entries(materials).filter(([name]) => {
    try { return visualGeometry(minecraftBlock(name), () => null).placeholder === undefined; }
    catch { return false; }
  }).length;
  assert.ok(modeled >= 900, `model coverage regressed to ${modeled}/1253`);
});
