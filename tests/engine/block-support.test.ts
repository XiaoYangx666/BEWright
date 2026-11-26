import { test } from 'node:test';
import assert from 'node:assert/strict';
import { block, Structure } from '../../src/core/structure.js';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { blockSupport, buildingBlockSupport } from '../../src/content/block-support.js';

test('support gates distinguish simple material selection from valid shaped blocks and Java mapping', () => {
  const result = blockSupport(minecraftBlock('oak_stairs', { weirdo_direction: 2, upside_down_bit: true }));
  assert.equal(result.registry.status, 'supported');
  assert.equal(result.materialHelper.status, 'unsupported');
  assert.match(result.materialHelper.detail, /minecraftBlock/);
  assert.equal(result.preview.status, 'supported');
  assert.equal(result.collision.status, 'supported');
  assert.equal(result.bedrock.status, 'supported');
  assert.equal(result.javaMapping.status, 'mapped');
  assert.match(result.javaMapping.detail, /top/);
});
test('invalid complete state and unknown names cannot claim downstream support', () => {
  for (const state of [block('oak_stairs', { weirdo_direction: 7 }), block('not_a_real_block')]) {
    const result = blockSupport(state);
    assert.equal(result.registry.status, 'unsupported');
    assert.equal(result.preview.status, 'unknown');
    assert.equal(result.collision.status, 'unknown');
    assert.equal(result.bedrock.status, 'unsupported');
    assert.equal(result.javaMapping.status, 'unknown');
  }
});
test('a registered chest can encode to Bedrock while its preview is a placeholder', () => {
  const result = blockSupport(minecraftBlock('chest'));
  assert.equal(result.registry.status, 'supported');
  assert.equal(result.bedrock.status, 'supported');
  assert.equal(result.preview.status, 'unsupported');
  assert.ok(result.preview.detail.length > 0);
});

test('harbor glass, flowers, quartz and lily pads expose their separate support gates', () => {
  for (const name of ['white_stained_glass', 'blue_stained_glass', 'red_tulip', 'white_tulip']) {
    const result = blockSupport(minecraftBlock(name));
    assert.equal(result.preview.status, 'supported', name);
    assert.equal(result.bedrock.status, 'supported', name);
  }
  for (const name of ['quartz_block', 'chiseled_quartz_block', 'waterlily']) {
    const result = blockSupport(minecraftBlock(name));
    assert.equal(result.collision.status, 'supported', name);
  }
});
test('building report ignores unused palette entries and keeps state variants, counts and locations', () => {
  const world = new Structure();
  world.intern(block('not_a_real_block'));
  world.set(-1, 3, 2, minecraftBlock('lantern', { hanging: true }));
  world.set(0, 3, 2, minecraftBlock('lantern', { hanging: true }));
  world.set(1, 3, 2, minecraftBlock('lantern', { hanging: false }));
  const result = buildingBlockSupport(world);
  assert.equal(result.length, 2);
  assert.equal(result[0].count, 2);
  assert.deepEqual(result[0].sample, [-1, 3, 2]);
  assert.notEqual(result[0].states.hanging, result[1].states.hanging);
});
