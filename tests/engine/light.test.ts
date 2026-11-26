import { test } from 'node:test';
import assert from 'node:assert/strict';
import { block, Structure } from '../../src/core/structure.js';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { LightField, lightEmission, lightOpacity } from '../../src/mesh/light.js';
import { mesh } from '../../src/mesh/mesher.js';
import { chunkOrigin, unpackMeshData } from '../../src/mesh/cache.js';
import { IncrementalPreview, type PreviewSnapshot } from '../../src/preview/incremental.js';

const stone = minecraftBlock('stone'),
  glass = minecraftBlock('glass'),
  glowstone = minecraftBlock('glowstone');

test('registry drives emission and opacity with state-aware exceptions', () => {
  assert.equal(lightEmission(glowstone), 15);
  assert.equal(lightEmission(minecraftBlock('soul_lantern')), 10);
  assert.equal(lightEmission(minecraftBlock('lantern', { hanging: true })), 15);
  assert.equal(lightEmission(minecraftBlock('campfire')), 15);
  assert.equal(lightEmission(minecraftBlock('campfire', { extinguished: true })), 0);
  assert.equal(lightEmission(minecraftBlock('candle')), 0);
  assert.equal(lightEmission(minecraftBlock('candle', { candles: 3, lit: true })), 12);
  assert.equal(lightEmission(minecraftBlock('sea_pickle')), 6);
  assert.equal(lightEmission(minecraftBlock('sea_pickle', { dead_bit: true })), 0);
  assert.equal(lightEmission(block('not_a_real_block')), 0);
  assert.equal(lightOpacity(stone), 15);
  assert.equal(lightOpacity(glass), 0);
  assert.equal(lightOpacity(minecraftBlock('oak_leaves')), 1);
  assert.equal(lightOpacity(block('not_a_real_block')), 0);
});

/** 11³ sealed stone shell with a source at the centre and an optional wall plane at x=8. */
function sealedRoom(wall: 'stone' | 'glass' | null): Structure {
  const world = new Structure();
  for (let x = 0; x <= 10; x++)
    for (let y = 0; y <= 10; y++)
      for (let z = 0; z <= 10; z++)
        if (x === 0 || x === 10 || y === 0 || y === 10 || z === 0 || z === 10) world.set(x, y, z, stone);
  world.set(5, 5, 5, glowstone);
  if (wall)
    for (let y = 1; y <= 9; y++) for (let z = 1; z <= 9; z++) world.set(8, y, z, wall === 'stone' ? stone : glass);
  return world;
}

test('point light falls off through air, passes glass and stops at walls', () => {
  const field = LightField.compute(sealedRoom('stone'));
  assert.equal(field.at(5, 5, 5), 15);
  assert.equal(field.at(7, 5, 5), 13);
  assert.equal(field.at(5, 5, 7), 13);
  assert.equal(field.at(9, 5, 5), 0); // the x=8 wall seals the far half completely
  assert.equal(field.at(6, 6, 6), 12); // diagonal distance is Manhattan, like the game
  const glassField = LightField.compute(sealedRoom('glass'));
  assert.equal(glassField.at(9, 5, 5), 11); // 15 - 4 steps, glass attenuates like air here
});

test('sky light fills open columns, stops at roofs and leaks under them', () => {
  const world = new Structure();
  for (let x = 0; x <= 10; x++)
    for (let z = 0; z <= 10; z++) world.set(x, 0, z, stone); // open ground plane
  for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) world.set(x, 9, z, stone); // 3x3 roof
  const field = LightField.compute(world);
  assert.equal(field.skyAt(5, 10, 5), 15); // open sky above the roof
  assert.equal(field.skyAt(5, 9, 5), 0); // the roof block itself holds no sky light
  assert.equal(field.skyAt(5, 8, 5), 13); // two lateral steps under the roof centre
  assert.equal(field.skyAt(5, 5, 5), 13); // the shadow deepens with distance, like the game
  assert.equal(field.skyAt(8, 8, 8), 15); // any open column is fully lit
  // Separate rebuilt model, mirroring how the live worker regenerates content.
  const opened = new Structure();
  for (let x = 0; x <= 10; x++) for (let z = 0; z <= 10; z++) opened.set(x, 0, z, stone);
  for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) if (!(x === 5 && z === 5)) opened.set(x, 9, z, stone);
  field.applyWorld(opened, [...opened.chunks.keys()]);
  assert.equal(field.skyAt(5, 5, 5), 15); // the skylight column is fully lit
  assert.deepEqual(levels(field), levels(LightField.compute(opened)));
});

function levels(field: LightField): number[] {
  const out: number[] = [];
  for (let x = 0; x <= 10; x++)
    for (let y = 0; y <= 10; y++)
      for (let z = 0; z <= 10; z++) out.push(field.at(x, y, z), field.skyAt(x, y, z));
  return out;
}

test('incremental repair matches a full recompute through mixed edits', () => {
  const edits: ((world: Structure) => void)[] = [
    (world) => world.set(2, 2, 2, glowstone), // add a source in the dark half
    (world) => world.set(5, 5, 5, null), // remove the original source
    (world) => {
      for (let y = 1; y <= 9; y++) for (let z = 1; z <= 9; z++) world.set(3, y, z, stone); // wall the lit half
    },
    (world) => {
      for (let y = 1; y <= 9; y++) for (let z = 1; z <= 9; z++) world.set(3, y, z, null); // open it again
    },
    (world) => world.set(9, 5, 5, glowstone), // source in the sealed half
    (world) => world.set(9, 5, 5, stone), // source removed and cell made opaque at once
    (world) => world.set(8, 5, 5, null), // punch a doorway through the wall
    (world) => world.set(8, 5, 5, glass), // glaze the doorway
  ];
  // Separate world objects per step, mirroring how IncrementalPreview rebuilds
  // the model: the field diffs the previous model against the new one.
  const field = LightField.compute(sealedRoom('stone'));
  for (let step = 0; step < edits.length; step++) {
    const current = sealedRoom('stone');
    for (let j = 0; j <= step; j++) edits[j](current);
    field.applyWorld(current, [...current.chunks.keys()]);
    assert.deepEqual(levels(field), levels(LightField.compute(current)));
  }
});

test('a rebuilt model with emission-only edits retains the sky field', () => {
  const before = sealedRoom('stone');
  before.set(2, 2, 2, minecraftBlock('candle'));
  const field = LightField.compute(before);
  const sky = (field as unknown as { sky: Map<string, Uint8Array> }).sky;
  const after = sealedRoom('stone');
  after.set(2, 2, 2, minecraftBlock('candle', { lit: true }));
  field.applyWorld(after, [...after.chunks.keys()]);
  assert.equal((field as unknown as { sky: Map<string, Uint8Array> }).sky, sky);
  assert.deepEqual(levels(field), levels(LightField.compute(after)));
});

test('restored lighting repairs a later model exactly like a cold field', () => {
  const before = sealedRoom('stone');
  const saved = LightField.compute(before).snapshot();
  const after = sealedRoom('stone');
  after.set(2, 2, 2, glowstone);
  after.set(8, 5, 5, null);
  const restored = LightField.fromSnapshot(after, saved);
  restored.applyWorld(after, [...after.chunks.keys()]);
  assert.deepEqual(levels(restored), levels(LightField.compute(after)));
});

test('local sky repair matches full sky across a multi-chunk roof', () => {
  const make = (opened: boolean) => {
    const world = new Structure();
    for (let x = 0; x < 96; x++) for (let z = 0; z < 16; z++) world.set(x, 0, z, stone);
    for (let x = 44; x <= 46; x++) for (let z = 6; z <= 8; z++)
      if (!opened || x !== 45 || z !== 7) world.set(x, 10, z, stone);
    return world;
  };
  const before = make(false);
  const after = make(true);
  const restored = LightField.fromSnapshot(after, LightField.compute(before).snapshot());
  restored.applyWorld(after, ['2,0,0']);
  const actual = new Map(restored.snapshot().sky);
  const expected = new Map(LightField.compute(after).snapshot().sky);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), 'sky chunk keys');
  for (const [key, grid] of expected)
    assert.ok(Buffer.from(actual.get(key)!).equals(Buffer.from(grid)), `sky differs in chunk ${key}`);
});

test('an added air-only chunk extends the sky field', () => {
  const before = new Structure();
  before.set(0, 0, 0, stone);
  const field = LightField.compute(before);
  const after = new Structure();
  after.set(0, 0, 0, stone);
  after.set(32, 0, 0, minecraftBlock('air'));
  field.applyWorld(after, [...after.chunks.keys()]);
  assert.equal(field.skyAt(32, 0, 0), LightField.compute(after).skyAt(32, 0, 0));
});

function snapshot(world: Structure): PreviewSnapshot {
  return {
    palette: world.palette,
    chunks: [...world.chunks],
    region: { min: [-32, -16, -16], max: [128, 32, 32] },
    style: {},
    light: true,
    camera: { camera: 'iso' },
  };
}

function equivalent(incremental: IncrementalPreview, input: PreviewSnapshot) {
  const cold = new IncrementalPreview();
  cold.update(input);
  assert.deepEqual([...incremental.buffers.keys()].sort(), [...cold.buffers.keys()].sort());
  for (const [key, entry] of cold.buffers) assert.deepEqual(incremental.buffers.get(key)!.data, entry.data, key);
}

test('live incremental updates match cold meshing when light-relevant blocks change', () => {
  const world = new Structure();
  world.set(15, 0, 0, stone); // wall spanning the 15/16 chunk boundary
  world.set(16, 0, 0, stone);
  const cache = new IncrementalPreview();
  cache.update(snapshot(world));
  world.set(15, 0, 1, glowstone); // new source right at the boundary
  const metrics = cache.update(snapshot(world));
  assert.ok(metrics.lightChunks > 0, 'light repair must report affected chunks');
  equivalent(cache, snapshot(world));
  world.set(15, 0, 1, null); // remove the source again
  cache.update(snapshot(world));
  equivalent(cache, snapshot(world));
  world.set(18, 0, 0, glowstone); // source one chunk over
  world.set(12, 0, 0, stone);
  cache.update(snapshot(world));
  equivalent(cache, snapshot(world));
});

test('mesher emits block and sky light per vertex, full-bright emitters and flat values without a field', () => {
  const world = new Structure();
  for (let x = 0; x <= 4; x++)
    for (let y = 0; y <= 4; y++)
      for (let z = 0; z <= 4; z++)
        if (x === 0 || x === 4 || y === 0 || y === 4 || z === 0 || z === 4) world.set(x, y, z, stone);
  world.set(2, 2, 2, glowstone);
  const lit = mesh(world, undefined, undefined, {}, LightField.compute(world));
  assert.equal(lit.lights.length, lit.positions.length / 3);
  assert.equal(lit.skies.length, lit.positions.length / 3);
  assert.equal(lit.translucentLights.length, lit.translucentPositions.length / 3);
  assert.equal(lit.translucentSkies.length, lit.translucentPositions.length / 3);
  assert.ok(lit.lights.every((value) => value >= 0 && value <= 1));
  assert.ok(lit.skies.every((value) => value >= 0 && value <= 1));
  assert.equal(Math.max(...lit.lights), 1); // emitter faces stay full-bright in a sealed room
  assert.equal(Math.min(...lit.lights), 0); // the sealed exterior reads the void beyond the shell
  const flat = mesh(world, undefined, undefined, {}, null);
  assert.ok(flat.lights.every((value) => value === 1));
  assert.ok(flat.skies.every((value) => value === 1));
});

test('box geometry samples light with fractional face coordinates', () => {
  // Regression: half slabs and stairs have boxes whose face planes and
  // perpendicular corners sit at half-block positions; a fractional voxel
  // index used to read as undefined and rendered every non-cube block black.
  const world = new Structure();
  world.set(5, 1, 5, minecraftBlock('smooth_stone_slab'));
  world.set(8, 1, 8, minecraftBlock('oak_stairs'));
  const field = LightField.compute(world);
  const m = mesh(world, undefined, undefined, {}, field);
  assert.equal(m.skies.length, m.positions.length / 3);
  assert.ok(m.skies.every((value) => value === 1), 'open-sky box faces must read full sky light');
  assert.ok(m.lights.every((value) => value === 0), 'no sources means zero block light, not black markers');
});

test('chunk buffers carry nine arrays with block and sky values per vertex', () => {
  const world = new Structure();
  world.set(0, 0, 0, glowstone);
  const cache = new IncrementalPreview();
  cache.update(snapshot(world));
  const [key, entry] = [...cache.buffers][0]!;
  const arrays = unpackMeshData(entry.data, chunkOrigin(key));
  const { positions, colors, lights, skies, translucentPositions, translucentLights, translucentSkies, translucentAlphas } =
    arrays;
  assert.ok(positions.length > 0, 'a lone source must still produce geometry');
  assert.equal(positions.length / 3, colors.length / 3, 'one colour per vertex');
  assert.equal(positions.length / 3, lights.length, 'one block-light value per vertex');
  assert.equal(positions.length / 3, skies.length, 'one sky-light value per vertex');
  assert.equal(translucentPositions.length / 3, translucentLights.length);
  assert.equal(translucentPositions.length / 3, translucentSkies.length);
  assert.equal(translucentPositions.length / 3, translucentAlphas.length);
  assert.ok(lights.every((value) => value > 0 && value <= 1));
  assert.ok(skies.every((value) => value > 0 && value <= 1));
});
