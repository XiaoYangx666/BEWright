import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Structure, type Box } from '../../src/core/structure.js';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { mesh } from '../../src/mesh/mesher.js';
import { defineBuilding, type BuildingDefinition } from '../../src/content/definition.js';
import { runBuild } from '../../src/content/pipeline.js';
import { LIGHT_CACHE_FILE } from '../../src/mesh/light-cache.js';
import type { DiscoveredBuilding } from '../../src/content/discover.js';
import {
  MESH_BUFFERS,
  MESH_CACHE_VERSION,
  MESH_INDEX_FILE,
  cachedViewUsable,
  chunkOrigin,
  meshChunkDecoderSource,
  meshFingerprint,
  packMeshData,
  readMeshCacheDir,
  unpackMeshData,
} from '../../src/mesh/cache.js';

/** Scratch directories must stay inside the project; cache/ is regenerable. */
const scratch = (suffix: string) => join('cache', `test-mesh-cache-${suffix}`);

const stone = minecraftBlock('stone');
const origin = [0, 0, 0];

function sampleWorld() {
  const world = new Structure();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) world.set(x, 0, z, stone);
  return world;
}

/** Slabs, stairs, glass and light sources: fractional boxes, translucency, emission. */
function detailedWorld() {
  const world = new Structure();
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++) {
      world.set(x, 0, z, minecraftBlock('oak_slab', { 'minecraft:vertical_half': 'bottom' }));
      if (x % 3 === 0) world.set(x, 1, z, minecraftBlock('oak_stairs', { weirdo_direction: (x / 3) % 4 }));
      if (x % 5 === 0) world.set(x, 2, z, minecraftBlock('glass'));
      if (x === 7 && z === 7) world.set(x, 3, z, minecraftBlock('glowstone'));
      if (x === 8 && z === 8) world.set(x, 1, z, minecraftBlock('oak_leaves'));
    }
  return world;
}

test('the packed chunk format round-trips every buffer exactly', () => {
  const data = mesh(sampleWorld(), undefined, '0,0,0');
  const restored = unpackMeshData(packMeshData(data, origin), origin);
  assert.deepEqual(Object.keys(restored), [...MESH_BUFFERS]);
  for (const name of MESH_BUFFERS) {
    assert.deepEqual([...restored[name]], [...data[name]], `${name} must survive packing`);
    // A copy, not a view: the caller keeps these past the source buffer.
    assert.notEqual(restored[name].buffer, data[name].buffer);
  }
  assert.equal(restored.positions.length / 3, data.quads * 6, 'six vertices per quad');
});

test('fractional boxes, translucency and lighting all survive packing exactly', () => {
  // The compact form quantises positions, tables colours and packs light into one
  // byte. Anything less than bit-exact here would show up as shifted geometry,
  // recoloured faces or wrong shading, so compare every value.
  const data = mesh(detailedWorld(), undefined, '0,0,0');
  assert.ok(data.translucentPositions.length, 'fixture must produce translucent geometry');
  assert.ok(data.quads > 0);
  const packed = packMeshData(data, origin);
  const restored = unpackMeshData(packed, origin);
  for (const name of MESH_BUFFERS) assert.deepEqual([...restored[name]], [...data[name]], name);
  // The compact form must actually be smaller than the buffers it encodes.
  const raw = MESH_BUFFERS.reduce((total, name) => total + data[name].byteLength, 0);
  assert.ok(packed.length < raw, `packed ${packed.length} should beat raw ${raw}`);
});

test('positions are stored chunk-local, so the file does not grow with world position', () => {
  const world = new Structure();
  for (let x = 0; x < 32; x++) for (let z = 0; z < 16; z++) world.set(x, 0, z, stone);
  const near = mesh(world, undefined, '0,0,0');
  const far = mesh(world, undefined, '1,0,0');
  assert.deepEqual([...unpackMeshData(packMeshData(near, chunkOrigin('0,0,0')), chunkOrigin('0,0,0')).positions], [
    ...near.positions,
  ]);
  assert.deepEqual([...unpackMeshData(packMeshData(far, chunkOrigin('1,0,0')), chunkOrigin('1,0,0')).positions], [
    ...far.positions,
  ]);
  // Both chunks hold the same slab, so the chunk a world position lands in does
  // not change the file's size: positions are stored relative to their chunk.
  assert.equal(packMeshData(near, chunkOrigin('0,0,0')).length, packMeshData(far, chunkOrigin('1,0,0')).length);
  // The origin is part of the contract: a mismatched one cannot silently decode.
  const shifted = unpackMeshData(packMeshData(far, chunkOrigin('1,0,0')), chunkOrigin('0,0,0'));
  assert.notDeepEqual([...shifted.positions].slice(0, 3), [...far.positions].slice(0, 3));
});

test('the browser reader agrees with the node reader on real chunks', () => {
  // Two implementations of one format is one too many, so pin them together.
  const decode = new Function(`${meshChunkDecoderSource()}; return { decodeMeshChunk, chunkOriginFor };`)() as {
    decodeMeshChunk: (bytes: Uint8Array, origin: number[]) => Record<string, Float32Array>;
    chunkOriginFor: (prefix: string) => number[];
  };
  const world = new Structure();
  for (let x = 0; x < 32; x++)
    for (let z = 0; z < 16; z++) {
      world.set(x, 0, z, stone);
      if (x % 4 === 0) world.set(x, 1, z, minecraftBlock('oak_stairs', { weirdo_direction: 1 }));
      if (x === 9) world.set(x, 1, z, minecraftBlock('glass'));
    }
  for (const key of ['0,0,0', '1,0,0']) {
    const data = mesh(world, undefined, key);
    const packed = packMeshData(data, chunkOrigin(key));
    const prefix = `m0123456789abcdef.${key}`;
    assert.deepEqual(decode.chunkOriginFor(prefix), chunkOrigin(key));
    const browser = decode.decodeMeshChunk(new Uint8Array(packed), decode.chunkOriginFor(prefix));
    const node = unpackMeshData(packed, chunkOrigin(key));
    for (const name of MESH_BUFFERS) assert.deepEqual([...browser[name]], [...node[name]], `${name} differs`);
  }
  assert.equal(decode.decodeMeshChunk(new Uint8Array(8), origin), null, 'foreign bytes are not a chunk');
});

test('the packed header is self-describing and rejects foreign or stale files', () => {
  const packed = packMeshData(mesh(sampleWorld(), undefined, '0,0,0'), origin);
  assert.equal(packed.readUInt32LE(0), 0xb10d1e56);
  assert.equal(packed.readUInt32LE(4), MESH_CACHE_VERSION);
  assert.equal(packed.readUInt32LE(32), packed.length, 'the header records its own length');
  assert.throws(() => unpackMeshData(Buffer.alloc(64), origin), /Not a blockwright mesh chunk/);
  const stale = Buffer.from(packed);
  stale.writeUInt32LE(MESH_CACHE_VERSION + 1, 4);
  assert.throws(() => unpackMeshData(stale, origin), /version mismatch/);
  assert.throws(() => unpackMeshData(packed.subarray(0, packed.length - 8), origin), /Truncated mesh chunk/);
  assert.throws(() => unpackMeshData(packed, []), /chunk origin is required/);
  assert.throws(() => packMeshData(mesh(sampleWorld(), undefined, '0,0,0'), []), /chunk origin is required/);
});

test('the fingerprint tracks content, region, style and lighting but not chunk order', () => {
  const region: Box = { min: [0, 0, 0], max: [16, 16, 16] };
  const world = sampleWorld();
  const base = meshFingerprint(world, region, {}, true);
  assert.equal(meshFingerprint(sampleWorld(), region, {}, true), base, 'identical content fingerprints equally');

  const other = sampleWorld();
  other.set(3, 2, 4, stone);
  assert.notEqual(meshFingerprint(other, region, {}, true), base, 'new content must miss the cache');
  assert.notEqual(meshFingerprint(world, { min: [0, 0, 0], max: [16, 16, 32] }, {}, true), base);
  assert.notEqual(meshFingerprint(world, region, { stone: '#123456' }, true), base);
  assert.notEqual(meshFingerprint(world, region, {}, false), base);

  // Rebuilding the same cells in a different insertion order must still hit.
  const rebuilt = new Structure();
  for (let x = 15; x >= 0; x--) for (let z = 15; z >= 0; z--) rebuilt.set(x, 0, z, stone);
  assert.equal(meshFingerprint(rebuilt, region, {}, true), base);
});

test('a cached view is usable only while every packed chunk is present', async () => {
  const dir = scratch('usable');
  await rm(dir, { recursive: true, force: true });
  const data = packMeshData(mesh(sampleWorld(), undefined, '0,0,0'), origin);
  try {
    await mkdir(dir, { recursive: true });
    const view = { prefix: 'm0123456789abcdef', chunks: ['0,0,0'], quads: 96, bytes: data.length, diagnostics: [] };
    await writeFile(join(dir, `${view.prefix}.0,0,0.bin`), data);
    const present = (await readMeshCacheDir(dir)).files;
    assert.equal(cachedViewUsable(view, present), true);
    assert.equal(cachedViewUsable({ ...view, chunks: ['0,0,0', '1,0,0'] }, present), false, 'a missing chunk is a miss');
    assert.equal(cachedViewUsable(undefined, present), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing or stale index is a cache miss rather than a failure', async () => {
  const dir = scratch('index');
  try {
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual((await readMeshCacheDir(dir)).index.views, {}, 'an absent directory is empty');

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MESH_INDEX_FILE), '{ not json');
    assert.deepEqual((await readMeshCacheDir(dir)).index.views, {}, 'corrupt JSON is not fatal');

    await writeFile(join(dir, MESH_INDEX_FILE), JSON.stringify({ version: MESH_CACHE_VERSION + 1, views: { a: 1 } }));
    assert.deepEqual((await readMeshCacheDir(dir)).index.views, {}, 'a stale version is not fatal');

    await writeFile(join(dir, MESH_INDEX_FILE), JSON.stringify({ version: MESH_CACHE_VERSION, views: {} }));
    assert.deepEqual((await readMeshCacheDir(dir)).index, { version: MESH_CACHE_VERSION, views: {} });
    assert.ok((await readdir(dir)).includes(MESH_INDEX_FILE));
    assert.equal(JSON.parse(await readFile(join(dir, MESH_INDEX_FILE), 'utf8')).version, MESH_CACHE_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A two-chunk slab with four views: three camera-only, one region-limited. */
function testBuilding(extraBlock: boolean): BuildingDefinition {
  const bounds: Box = { min: [0, 0, 0], max: [32, 8, 16] };
  return defineBuilding({
    id: 'mesh-cache-fixture',
    name: 'Mesh cache fixture',
    bounds,
    build: () => {
      const world = new Structure();
      for (let x = 0; x < 32; x++) for (let z = 0; z < 16; z++) world.set(x, 0, z, stone);
      if (extraBlock) world.set(5, 1, 5, minecraftBlock('glowstone'));
      return world;
    },
    views: [
      { name: 'full-a', eye: [40, 20, 40], target: [16, 0, 8] },
      { name: 'full-b', eye: [40, 30, 40], target: [16, 0, 8] },
      { name: 'full-c', eye: [40, 40, 40], target: [16, 0, 8] },
      { name: 'half', region: { min: [0, 0, 0], max: [16, 8, 16] } },
    ],
  });
}

async function buildFixture(definition: BuildingDefinition, suffix: string) {
  const loaded = {
    discovered: { id: definition.id, name: definition.name } as DiscoveredBuilding,
    definition,
  };
  return runBuild(loaded, {
    artifactDir: scratch(`fixture-artifacts-${suffix}`),
    cacheDir: scratch(`fixture-meshes-${suffix}`),
    check: false,
  });
}

const meshOnly = (result: { report: Record<string, unknown> }) => Number(result.report.meshOnlyMs);
const cacheWritten = (result: { report: Record<string, unknown> }) => Number(result.report.cacheMs);

test('views that differ only by camera mesh once and share their chunk files', async () => {
  const definition = testBuilding(false);
  const cacheDir = scratch('fixture-meshes-dedup');
  try {
    const result = await buildFixture(definition, 'dedup');
    const sources = result.views.map((view) => view.meshSource);
    assert.deepEqual(sources, ['built', 'reused', 'reused', 'built'], 'camera-only views reuse the first mesh');

    const [fullA, fullB, fullC, half] = result.views;
    assert.deepEqual(fullB.chunkFiles, fullA.chunkFiles, 'reused views publish the same files');
    assert.deepEqual(fullC.chunkFiles, fullA.chunkFiles);
    assert.deepEqual(fullB.diagnostics, fullA.diagnostics);
    assert.equal(fullB.quads, fullA.quads);
    assert.ok(fullA.chunkFiles.length && half.chunkFiles.length, 'both meshes wrote chunks');

    // Only two distinct meshes were written, and every published prefix exists.
    const written = await readdir(cacheDir);
    assert.equal(written.filter((file) => /^m[0-9a-f]{16}\..*\.bin$/.test(file)).length, fullA.chunkFiles.length + half.chunkFiles.length);
    assert.ok(written.includes(MESH_INDEX_FILE));
    for (const prefix of [...fullA.chunkFiles, ...half.chunkFiles])
      assert.ok(await readFile(`${prefix}.bin`).then(() => true, () => false), `${prefix}.bin must exist`);

    // The scene metadata still carries per-view cameras for the shared geometry.
    const scenes = JSON.parse(await readFile(join(scratch('fixture-artifacts-dedup'), 'scenes.json'), 'utf8'));
    assert.deepEqual(Object.keys(scenes), ['full-a', 'full-b', 'full-c', 'half']);
    assert.notDeepEqual(scenes['full-a'].eye, scenes['full-b'].eye);
    assert.deepEqual(scenes['full-b'].chunkFiles, scenes['full-a'].chunkFiles);
  } finally {
    for (const dir of [scratch('fixture-artifacts-dedup'), cacheDir]) await rm(dir, { recursive: true, force: true });
  }
});

test('a second build reuses the on-disk cache and an edited model invalidates it', async () => {
  const stable = testBuilding(false);
  const suffix = 'reuse';
  try {
    const cold = await buildFixture(stable, suffix);
    assert.equal(cold.report.lightSource, 'computed');
    assert.ok(meshOnly(cold) > 0, 'the first build must mesh');
    assert.ok(cacheWritten(cold) > 0, 'the first build must write the cache');
    assert.deepEqual(cold.views.map((view) => view.meshSource), ['built', 'reused', 'reused', 'built']);

    const warm = await buildFixture(stable, suffix);
    assert.equal(warm.report.lightSource, 'unused');
    assert.equal(meshOnly(warm), 0, 'a warm build remeshes nothing');
    assert.equal(Number(warm.report.lightMs), 0, 'a warm build skips light computation');
    assert.equal(cacheWritten(warm), 0, 'a warm build rewrites nothing');
    assert.deepEqual(warm.views.map((view) => view.meshSource), ['cached', 'reused', 'reused', 'cached']);
    assert.deepEqual(
      warm.views.map((view) => [view.name, view.quads, view.chunkFiles]),
      cold.views.map((view) => [view.name, view.quads, view.chunkFiles]),
      'cache hits must reproduce the cold build exactly',
    );

    // Editing the model changes the fingerprint, so the cache cannot mask it.
    const edited = await buildFixture(testBuilding(true), suffix);
    assert.equal(edited.report.lightSource, 'restored');
    assert.ok(meshOnly(edited) > 0, 'an edited model must be remeshed');
    assert.deepEqual(edited.views.map((view) => view.meshSource), ['partial', 'reused', 'reused', 'partial']);
    assert.notDeepEqual(
      edited.views.map((view) => view.quads),
      cold.views.map((view) => view.quads),
      'the edited model produces different geometry',
    );
  } finally {
    for (const dir of [scratch(`fixture-artifacts-${suffix}`), scratch(`fixture-meshes-${suffix}`)])
      await rm(dir, { recursive: true, force: true });
  }
});

test('a local edit preserves distant packed chunks and matches a cold rebuild', async () => {
  const suffix = 'partial';
  const definition = (edited: boolean) => defineBuilding({
    id: 'mesh-cache-partial-fixture', name: 'Partial mesh fixture',
    bounds: { min: [0, 0, 0], max: [80, 8, 16] },
    build: () => {
      const world = new Structure();
      for (let x = 0; x < 80; x++) for (let z = 0; z < 16; z++) world.set(x, 0, z, stone);
      if (edited) world.set(5, 1, 5, minecraftBlock('glowstone'));
      return world;
    },
  });
  try {
    const first = await buildFixture(definition(false), suffix);
    const edited = await buildFixture(definition(true), suffix);
    const cold = await buildFixture(definition(true), 'partial-cold');
    assert.equal(edited.views[0].meshSource, 'partial');
    assert.equal(edited.views[0].chunkFiles.length, 5);
    assert.equal(edited.views[0].chunkFiles[4], first.views[0].chunkFiles[4], 'distant chunk is reused');
    assert.notEqual(edited.views[0].chunkFiles[0], first.views[0].chunkFiles[0], 'edited chunk is rebuilt');
    assert.equal(edited.views[0].quads, cold.views[0].quads);
    for (let i = 0; i < 5; i++)
      assert.deepEqual(await readFile(`${edited.views[0].chunkFiles[i]}.bin`), await readFile(`${cold.views[0].chunkFiles[i]}.bin`));
  } finally {
    for (const name of ['partial', 'partial-cold'])
      for (const dir of [scratch(`fixture-artifacts-${name}`), scratch(`fixture-meshes-${name}`)])
        await rm(dir, { recursive: true, force: true });
  }
});

test('a damaged light snapshot falls back to full lighting', async () => {
  const suffix = 'damaged-light';
  const cacheDir = scratch(`fixture-meshes-${suffix}`);
  try {
    await buildFixture(testBuilding(false), suffix);
    await writeFile(join(cacheDir, LIGHT_CACHE_FILE), 'damaged');
    const edited = await buildFixture(testBuilding(true), suffix);
    assert.equal(edited.report.lightSource, 'computed');
    assert.equal(edited.views[0].meshSource, 'partial');
  } finally {
    for (const dir of [scratch(`fixture-artifacts-${suffix}`), cacheDir])
      await rm(dir, { recursive: true, force: true });
  }
});

test('palette mesh tables refresh when a structure gains a new block state', () => {
  const world = sampleWorld();
  mesh(world, undefined, '0,0,0'); // populate the shared palette tables
  world.set(2, 1, 2, minecraftBlock('glass'));
  const updated = packMeshData(mesh(world, undefined, '0,0,0'), origin);
  const fresh = Structure.fromSnapshot(world.snapshot());
  assert.deepEqual(updated, packMeshData(mesh(fresh, undefined, '0,0,0'), origin));
});
