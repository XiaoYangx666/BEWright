import test from 'node:test';
import assert from 'node:assert/strict';
import nbt from 'prismarine-nbt';
import { read } from 'nbtify';
import { Structure, block, AIR, type Box } from '../../src/core/structure.js';
import {
  DEFAULT_MCSTRUCTURE_FORMAT_VERSION,
  MCSTRUCTURE_FORMAT_VERSIONS,
  blockIndexLayers,
  exportMcstructure,
  parseMcstructureFormatVersion,
} from '../../src/targets/bedrock/mcstructure.js';
import { countMcstructureCells } from '../../src/targets/bedrock/world.js';
import { mesh } from '../../src/mesh/mesher.js';
import { boxes, visualGeometry } from '../../src/blocks/shapes.js';

/** Engine fixture: stone, explicit air, a directional stair and a slab. */
function markersFixture() {
  const s = new Structure();
  s.set(-1, 0, 0, block('stone')); s.set(0, 0, 0, AIR);
  s.set(0, 1, 2, block('oak_stairs', { upside_down_bit: false, weirdo_direction: 2 }));
  s.set(0, 2, 3, block('oak_slab', { 'minecraft:vertical_half': 'top' }));
  return s;
}

test('negative coordinates, chunk boundaries, palette canonicalization and explicit air', () => {
  const s = new Structure();
  for (const x of [-17, -16, -1, 0, 15, 16]) s.set(x, -1, 16, block('stone'));
  assert.equal(s.inspect().occupied, 6);
  for (const x of [-17, -16, -1, 0, 15, 16]) assert.equal(s.get(x, -1, 16)?.name, 'minecraft:stone');
  s.set(0, -1, 16, AIR); assert.equal(s.inspect().occupied, 5); assert.equal(s.inspect().explicitAir, 1);
  s.set(0, -1, 16, null); assert.equal(s.get(0, -1, 16), null);
  assert.equal(s.intern(block('x', { a: 1, b: false })), s.intern(block('x', { b: false, a: 1 })));
  assert.throws(() => s.set(.5, 0, 0, AIR));
  assert.throws(() => s.fill({ min: [0, 0, 0], max: [0, 1, 1] }, AIR));
});

test('a changed boundary cell invalidates only its touching chunk neighbors', () => {
  const s = new Structure();
  const stone = block('stone');
  s.set(15, 0, -16, stone);
  assert.deepEqual([...s.meshVersions.keys()], ['0,0,-1', '1,0,-1', '0,-1,-1', '0,0,-2']);
  const revision = s.revision;
  s.set(15, 0, -16, stone);
  assert.equal(s.revision, revision, 'writing the same state does not invalidate a mesh');
  s.set(16, 0, -16, stone);
  assert.equal(s.meshVersions.get('0,0,-1'), s.revision, 'the adjacent chunk invalidates its neighbor');
});

test('column fill matches ordered single-cell writes across negative chunk boundaries', () => {
  const batched = new Structure(), individual = new Structure();
  const stone = block('stone');
  const steps: { x: number; from: number; to: number; z: number; state: typeof stone | null }[] = [
    { x: 15, from: -18, to: 18, z: -16, state: stone },
    { x: 15, from: -2, to: 2, z: -16, state: AIR },
    { x: 15, from: 14, to: 19, z: -16, state: null },
    { x: -16, from: -17, to: -14, z: 0, state: null },
  ];
  for (const { x, from, to, z, state } of steps) {
    batched.fill({ min: [x, from, z], max: [x + 1, to, z + 1] }, state);
    const id = state ? individual.intern(state) : 0;
    for (let y = from; y < to; y++) individual.setId(x, y, z, id);
  }
  assert.equal(batched.revision, individual.revision);
  assert.equal(batched.ceiling, individual.ceiling);
  assert.deepEqual([...batched.meshVersions], [...individual.meshVersions]);
  assert.deepEqual([...batched.chunks].map(([key, chunk]) => [key, [...chunk.cells]]),
    [...individual.chunks].map(([key, chunk]) => [key, [...chunk.cells]]));
});
test('prefab paste keeps source immutable and preserves holes', () => {
  const a = markersFixture(), b = new Structure(); b.paste(a, [20, 0, 0]);
  assert.equal(b.get(19, 0, 0)?.name, 'minecraft:stone');
  assert.equal(b.get(20, 0, 0)?.name, 'minecraft:air');
  b.set(19, 0, 0, null); assert.equal(a.get(-1, 0, 0)?.name, 'minecraft:stone');
  assert.throws(() => b.paste(b, [1, 0, 0]));
});
test('greedy faces have correct area, remove cross-chunk interior and expose cuts', () => {
  const s = new Structure(); s.fill({ min: [0, 0, 0], max: [32, 16, 16] }, block('stone'));
  const m = mesh(s); assert.equal(m.quads, 10); // each long side spans two chunks; no internal plane
  function area(p: Float32Array) {
    let area = 0;
    for (let i = 0; i < p.length; i += 9) {
      const a = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]], b = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
      area += Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
    }
    return area;
  }
  assert.equal(area(m.positions), 2 * (32 * 16 + 32 * 16 + 16 * 16));
  const cut = mesh(s, { min: [0, 0, 0], max: [16, 16, 16] }); assert.equal(cut.quads, 6); assert.equal(area(cut.positions), 6 * 16 * 16);
});
test('special shapes retain slab half and directional stair volume', () => {
  const low = boxes(block('oak_slab', { 'minecraft:vertical_half': 'bottom' }), () => null);
  const high = boxes(block('oak_slab', { 'minecraft:vertical_half': 'top' }), () => null);
  assert.equal(low[0][4], .5); assert.equal(high[0][1], .5);
  for (const d of [0, 1, 2, 3]) for (const upside of [false, true]) {
    const shape = boxes(block('oak_stairs', { weirdo_direction: d, upside_down_bit: upside }), () => null);
    assert.equal(shape.reduce((v, b) => v + (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]), 0), .75);
  }
  assert.throws(() => mesh((() => { const s = new Structure(); s.set(0, 0, 0, block('blockwright_nonexistent')); return s; })()));
});
test('export independently parses with correct nonsymmetric XYZ indexing, void, air and typed states', async () => {
  const bytes = exportMcstructure(markersFixture(), { min: [-1, 0, 0], max: [1, 3, 4] });
  assert.equal(bytes[0], 10); // unnamed compound, not gzip or a Bedrock level.dat header
  const result = await read(bytes, { endian: 'little', compression: null, bedrockLevel: false, strict: true });
  const root: any = result.data;
  assert.deepEqual(root.size.map(Number), [2, 3, 4]);
  assert.deepEqual(root.structure_world_origin.map(Number), [-1, 0, 0]);
  const [primary, secondary] = root.structure.block_indices, palette = root.structure.palette.default.block_palette;
  assert.equal(primary.length, 24); assert.equal(secondary.length, 24);
  const expected = new Map([[0, 'minecraft:stone'], [12, 'minecraft:air'], [18, 'minecraft:oak_stairs'], [23, 'minecraft:oak_slab']]);
  for (let i = 0; i < 24; i++) {
    assert.equal(Number(secondary[i]), -1);
    if (expected.has(i)) assert.equal(palette[Number(primary[i])].name, expected.get(i)); else assert.equal(Number(primary[i]), -1);
  }
  assert.equal(Number(palette[Number(primary[18])].states.upside_down_bit), 0);
  const typed: any = nbt.parseUncompressed(bytes, 'little');
  const tags = typed.value.structure.value.palette.value.default.value.block_palette.value.value;
  const stair = tags.find((v: any) => v.name.value === 'minecraft:oak_stairs');
  assert.equal(stair.states.value.upside_down_bit.type, 'byte'); assert.equal(stair.states.value.weirdo_direction.type, 'int');
});
test('sparse placement does not allocate its bounding volume; dense export has an explicit budget', () => {
  const s = new Structure(); s.set(-1000000, 0, 0, block('stone')); s.set(1000000, 0, 0, block('stone'));
  assert.equal(s.inspect().cellBytes, 16384);
  assert.throws(() => exportMcstructure(s, { min: [-1000000, 0, 0], max: [1000001, 1, 1] }), /budget/);
});
test('version 2 export stores int-array layers, drops the empty secondary layer and re-reads independently', async () => {
  const world = markersFixture(), region: Box = { min: [-1, 0, 0], max: [1, 3, 4] };
  const v1 = exportMcstructure(world, region, { formatVersion: 1 });
  const v2 = exportMcstructure(world, region, { formatVersion: 2 });
  assert.ok(v2.length < v1.length);

  // nbtify is not the writer: it reads TAG_Int_Array as Int32Array and reports one layer here.
  const root: any = (await read(v2, { endian: 'little', compression: null, bedrockLevel: false, strict: true })).data;
  assert.equal(Number(root.format_version), 2);
  assert.deepEqual(root.size.map(Number), [2, 3, 4]);
  assert.deepEqual(root.structure_world_origin.map(Number), [-1, 0, 0]);
  const layers = root.structure.block_indices;
  assert.equal(layers.length, 1);
  assert.ok(layers[0] instanceof Int32Array);
  assert.equal(layers[0].length, 24);
  const palette = root.structure.palette.default.block_palette;
  const expected = new Map([[0, 'minecraft:stone'], [12, 'minecraft:air'], [18, 'minecraft:oak_stairs'], [23, 'minecraft:oak_slab']]);
  for (let i = 0; i < 24; i++) {
    if (expected.has(i)) assert.equal(palette[Number(layers[0][i])].name, expected.get(i));
    else assert.equal(Number(layers[0][i]), -1);
  }

  // The writer's own parse path and the shared layer reader accept both versions.
  assert.equal(countMcstructureCells(v1), countMcstructureCells(v2));
  assert.equal(countMcstructureCells(v2), 4);
  const tags: any = nbt.parseUncompressed(v2, 'little');
  assert.equal(tags.value.format_version.value, 2);
  assert.equal(tags.value.structure.value.block_indices.value.type, 'intArray');
  assert.deepEqual(blockIndexLayers(tags.value.structure.value.block_indices), [Array.from(layers[0])]);
  const v1Layers = blockIndexLayers((nbt.parseUncompressed(v1, 'little') as any).value.structure.value.block_indices);
  assert.equal(v1Layers.length, 2); assert.deepEqual(v1Layers[0], Array.from(layers[0]));
  assert.ok(v1Layers[1]!.every((id) => id === -1));
});
test('structure format version selection defaults to 1 and rejects anything else', () => {
  assert.equal(parseMcstructureFormatVersion(undefined), 1);
  assert.equal(parseMcstructureFormatVersion('1'), 1);
  assert.equal(parseMcstructureFormatVersion('2'), 2);
  assert.equal(parseMcstructureFormatVersion(2), 2);
  assert.equal(DEFAULT_MCSTRUCTURE_FORMAT_VERSION, 1);
  assert.deepEqual([...MCSTRUCTURE_FORMAT_VERSIONS], [1, 2]);
  assert.throws(() => parseMcstructureFormatVersion('3'), /must be 1 or 2/);
  assert.throws(() => parseMcstructureFormatVersion('v2'), /must be 1 or 2/);
  assert.throws(() => exportMcstructure(markersFixture(), { min: [0, 0, 0], max: [1, 1, 1] }, { formatVersion: 3 as 1 }), /Unsupported structure format version/);
});
test('fence arms use same-height face neighbors and strict states reject misleading geometry', () => {
  const f = block('oak_fence'); assert.equal(boxes(f, () => null).length, 1);
  for (const delta of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const shape = boxes(f, d => d.join() === delta.join() ? block('red_concrete') : null);
    assert.equal(shape.length, 3); assert.equal(Math.max(...shape.map(b => b[4])), 1);
  }
  assert.equal(boxes(f, () => block('oak_slab', { 'minecraft:vertical_half': 'top' })).length, 1);
  assert.throws(() => boxes(block('oak_slab', {}), () => null));
  assert.throws(() => boxes(block('oak_stairs', { weirdo_direction: 0, upside_down_bit: 0 }), () => null));
});
test('stair high halves follow X east / Z south and perpendicular neighbours build corners', () => {
  const expected = [[.5, .5, 0, 1, 1, 1], [0, .5, 0, .5, 1, 1], [0, .5, .5, 1, 1, 1], [0, .5, 0, 1, 1, .5]];
  for (let d = 0; d < 4; d++) assert.deepEqual(boxes(block('oak_stairs', { weirdo_direction: d, upside_down_bit: false }), () => null)[1], expected[d]);
  const neighbour = (delta: [number, number, number]) => delta[0] === 1 ? block('oak_stairs', { weirdo_direction: 2, upside_down_bit: false }) : null;
  const corner = visualGeometry(block('oak_stairs', { weirdo_direction: 0, upside_down_bit: false }), neighbour);
  assert.equal(corner.placeholder, undefined);
  assert.equal(corner.boxes.length, 3);
  assert.deepEqual(corner.boxes[2], [0, .5, .5, .5, 1, 1]);
});
