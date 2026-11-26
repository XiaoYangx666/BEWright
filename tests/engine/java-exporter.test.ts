import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { block, Structure } from '../../src/core/structure.js';
import { encodeJavaWorld, JAVA_TARGET } from '../../src/targets/java/world.js';
import { toJavaBlockState } from '../../src/targets/java/blocks.js';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { loadBlockwrightConfig } from '../../src/project/config.js';

test('project config keeps Java and Bedrock save roots independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blockwright-config-'));
  const path = join(dir, 'blockwright.config.json');
  try {
    await writeFile(path, JSON.stringify({
      worldDirectories: { java: 'C:\\java-saves', bedrock: null },
      contentRoots: ['./buildings'],
    }));
    const config = await loadBlockwrightConfig(path);
    assert.equal(config.worldDirectories?.java, 'C:\\java-saves');
    assert.equal(config.worldDirectories?.bedrock, null);
    assert.deepEqual(config.contentRoots, ['./buildings']);
    const resolved = await loadBlockwrightConfig(path, { absolutePaths: true });
    assert.deepEqual(resolved.contentRoots, [join(dir, 'buildings')]);
    assert.deepEqual(await loadBlockwrightConfig(join(dir, 'missing.json')), {});
    await writeFile(path, JSON.stringify({ contentRoots: 'not-an-array' }));
    await assert.rejects(() => loadBlockwrightConfig(path), /contentRoots/);
    await writeFile(path, JSON.stringify({ worldDirectories: { java: '' } }));
    await assert.rejects(() => loadBlockwrightConfig(path), /worldDirectories\.java/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Java conversion maps common Bedrock block states without losing semantics', () => {
  assert.deepEqual(toJavaBlockState(block('oak_stairs', { weirdo_direction: 3, upside_down_bit: true })), {
    name: 'minecraft:oak_stairs', properties: { facing: 'north', shape: 'straight', waterlogged: 'false', half: 'top' },
  });
  assert.deepEqual(toJavaBlockState(block('oak_slab', { 'minecraft:vertical_half': 'bottom' })), {
    name: 'minecraft:oak_slab', properties: { type: 'bottom', waterlogged: 'false' },
  });
  assert.deepEqual(toJavaBlockState(block('cobblestone_wall', {
    wall_post_bit: true,
    wall_connection_type_east: 'short',
    wall_connection_type_west: 'tall',
  })), {
    name: 'minecraft:cobblestone_wall', properties: { up: 'true', east: 'low', west: 'tall', waterlogged: 'false' },
  });
  assert.deepEqual(toJavaBlockState(block('lantern', { hanging: true })), {
    name: 'minecraft:lantern', properties: { hanging: 'true', waterlogged: 'false' },
  });
  assert.deepEqual(toJavaBlockState(block('melon_block')), { name: 'minecraft:melon', properties: {} });
  assert.throws(() => toJavaBlockState(block('stone', { unknown_bedrock_state: 1 })), /does not support/);
});

test('registered bone blocks preserve their axes while omitting only default legacy metadata', () => {
  for (const axis of ['x','y','z']) {
    assert.deepEqual(toJavaBlockState(minecraftBlock('bone_block',{pillar_axis:axis})), {
      name:'minecraft:bone_block',properties:{axis},
    });
  }
  assert.throws(()=>toJavaBlockState(minecraftBlock('bone_block',{deprecated:1})),/does not support/);
  assert.throws(()=>toJavaBlockState(block('stone',{deprecated:0})),/does not support/);
});

test('Java world payload preserves global and negative coordinates', () => {
  const world = new Structure();
  world.set(-1, -64, 16, block('stone'));
  world.set(0, 0, 0, block('water', { liquid_depth: 0 }));
  const payload = JSON.parse(encodeJavaWorld(world, { min: [-16, -64, 0], max: [16, 1, 32] }, { name: 'test', seed: 7 }).toString());
  assert.equal(payload.dataVersion, JAVA_TARGET.dataVersion);
  assert.deepEqual(payload.blocks.map((entry: number[]) => entry.slice(0, 3)), [[-1, -64, 16], [0, 0, 0]]);
  assert.equal(payload.palette[1].properties.level, '0');
});

test('Java connection blocks get neighbour-derived fence/wall/bar states', () => {
  const world = new Structure();
  // A fence line along +Z: each fence connects north/south to the next.
  world.set(0, 1, 0, block('oak_fence'));
  world.set(0, 1, 1, block('oak_fence'));
  world.set(0, 1, 2, block('oak_fence'));
  // Solid ground below anchors the posts.
  for (let z = 0; z < 3; z++) world.set(0, 0, z, block('stone'));
  // An isolated fence above a non-solid cell becomes a standalone post.
  world.set(5, 3, 5, block('oak_fence'));
  world.set(5, 2, 5, block('air'));
  // A wall line connecting east/west, on solid ground.
  world.set(10, 1, 10, block('cobblestone_wall'));
  world.set(11, 1, 10, block('cobblestone_wall'));
  world.set(12, 1, 10, block('cobblestone_wall'));
  world.set(10, 0, 10, block('stone'));
  world.set(11, 0, 10, block('stone'));
  world.set(12, 0, 10, block('stone'));
  const payload = JSON.parse(encodeJavaWorld(world, { min: [0, 0, 0], max: [13, 4, 13] }, { name: 'connect', seed: 1 }).toString());
  const states = new Map<string, Record<string, string>>();
  for (const [i, p] of payload.palette.entries()) states.set(i, p.properties);
  const at = (x: number, y: number, z: number) => {
    const entry = payload.blocks.find((b: number[]) => b[0] === x && b[1] === y && b[2] === z);
    return entry ? states.get(entry[3]) : null;
  };
  // Middle fence of the line connects both north and south.
  assert.equal(at(0, 1, 1)?.north, 'true');
  assert.equal(at(0, 1, 1)?.south, 'true');
  assert.equal(at(0, 1, 1)?.up, 'true');
  // End fences connect on only one side (toward the rest of the line, +Z).
  assert.equal(at(0, 1, 0)?.north, 'false');
  assert.equal(at(0, 1, 0)?.south, 'true');
  // Isolated fence above air: no horizontal connection, standalone post.
  assert.equal(at(5, 3, 5)?.north, 'false');
  assert.equal(at(5, 3, 5)?.east, 'false');
  assert.equal(at(5, 3, 5)?.up, 'true');
  // Wall line: east/west connect as low, north/south stay none.
  assert.equal(at(10, 1, 10)?.east, 'low');
  assert.equal(at(10, 1, 10)?.west, 'none');
  assert.equal(at(10, 1, 10)?.north, 'none');
  // Middle wall of a straight line connects both ways and is a low connector.
  assert.equal(at(11, 1, 10)?.east, 'low');
  assert.equal(at(11, 1, 10)?.west, 'low');
  assert.equal(at(11, 1, 10)?.up, 'false');
  // End walls (one connection) stay posts.
  assert.equal(at(10, 1, 10)?.up, 'true');
  assert.equal(at(12, 1, 10)?.west, 'low');
  assert.equal(at(12, 1, 10)?.up, 'true');
});

test('wall connects to any non-leaf block and up reflects the connection count', () => {
  const world = new Structure();
  // A wall with stone_bricks to its east and a wall to its west (the water-town
  // rail at 48,11,4): both count as connections -> 2 -> up:false.
  world.set(0, 1, 0, block('cobblestone_wall'));
  world.set(1, 1, 0, block('stone_bricks'));
  world.set(-1, 1, 0, block('cobblestone_wall'));
  for (let x = -1; x <= 1; x++) world.set(x, 0, 0, block('stone'));
  const payload = JSON.parse(encodeJavaWorld(world, { min: [-1, 0, 0], max: [2, 2, 1] }, { name: 'connect', seed: 1 }).toString());
  const states = new Map<string, Record<string, string>>();
  for (const [i, p] of payload.palette.entries()) states.set(i, p.properties);
  const at = (x: number) => {
    const entry = payload.blocks.find((b: number[]) => b[0] === x && b[1] === 1 && b[2] === 0);
    return entry ? states.get(entry[3]) : null;
  };
  // Middle wall: east connects to stone_bricks, west to a wall -> 2 connections.
  assert.equal(at(0)?.east, 'low');
  assert.equal(at(0)?.west, 'low');
  assert.equal(at(0)?.up, 'false');
  // End wall: only east connects -> 1 connection, stays a post.
  assert.equal(at(-1)?.east, 'low');
  assert.equal(at(-1)?.west, 'none');
  assert.equal(at(-1)?.up, 'true');
});

test('wall up stays true for an isolated post despite hard-coded east/west:short', () => {
  const world = new Structure();
  // A single bridge-railing post: the scene hard-codes east/west:short, but with
  // no real neighbours it must remain a post (up:true) with no extensions.
  world.set(0, 1, 0, block('cobblestone_wall', {
    wall_post_bit: true,
    wall_connection_type_east: 'short', wall_connection_type_west: 'short',
  }));
  world.set(0, 0, 0, block('stone'));
  const payload = JSON.parse(encodeJavaWorld(world, { min: [0, 0, 0], max: [1, 2, 1] }, { name: 'post', seed: 1 }).toString());
  const entry = payload.blocks.find((b: number[]) => b[0] === 0 && b[1] === 1 && b[2] === 0);
  assert.ok(entry, 'wall present');
  assert.equal(payload.palette[entry[3]].properties.up, 'true');
  // No neighbours -> no extensions, regardless of the hard-coded east/west:short.
  assert.equal(payload.palette[entry[3]].properties.east, 'none');
  assert.equal(payload.palette[entry[3]].properties.west, 'none');
});
