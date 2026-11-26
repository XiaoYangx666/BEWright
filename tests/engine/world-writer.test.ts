import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  backupWorld,
  defaultWorldWriterBinary,
  directStructureStream,
  encodeDirectStructure,
  placeStructureInWorld,
  validateWorldDirectory,
} from '../../src/targets/bedrock/world.js';
import { Structure, AIR, type Box } from '../../src/core/structure.js';
import { minecraftBlock as b } from '../../src/blocks/registry.js';

test('world writer validates Bedrock world records before mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blockwright-world-'));
  try {
    await assert.rejects(() => validateWorldDirectory(root), /level\.dat/);
    await writeFile(join(root, 'level.dat'), 'fixture');
    await assert.rejects(() => validateWorldDirectory(root), /db\/CURRENT/);
    await mkdir(join(root, 'db'));
    await writeFile(join(root, 'db', 'CURRENT'), 'MANIFEST-000001\n');
    assert.equal(await validateWorldDirectory(root), root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('world writer rejects an unaligned placement before creating a backup', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'blockwright-world-'));
  const world = join(parent, 'world');
  try {
    await mkdir(join(world, 'db'), { recursive: true });
    await writeFile(join(world, 'level.dat'), 'fixture');
    await writeFile(join(world, 'db', 'CURRENT'), 'MANIFEST-000001\n');
    const structure = join(parent, 'sample.mcstructure');
    await writeFile(structure, 'fixture');
    await assert.rejects(() => placeStructureInWorld({ world, structure, position: [1, 64, 0], binary: defaultWorldWriterBinary() }), /multiples of 16/);
    const entries = await import('node:fs/promises').then(fs => fs.readdir(parent));
    assert.deepEqual(entries.sort(), ['sample.mcstructure', 'world']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('direct structure protocol keeps explicit air separate from omitted void cells', () => {
  const structure = new Structure();
  structure.set(0, 0, 0, b('stone'));
  structure.set(1, 0, 0, AIR);
  const bytes = encodeDirectStructure(structure, { min: [0, 0, 0], max: [3, 1, 1] });
  assert.equal(bytes.subarray(0, 8).toString(), 'BLKWRDIR');
  assert.equal(bytes.readUInt32LE(8), 1);
  assert.deepEqual([...bytes.subarray(-16)], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0]);
});

test('backupWorld copies an existing world without pre-creating the target', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'blockwright-backup-'));
  const world = join(parent, 'world');
  try {
    await mkdir(join(world, 'db'), { recursive: true });
    await writeFile(join(world, 'level.dat'), 'fixture');
    await writeFile(join(world, 'db', 'CURRENT'), 'MANIFEST-000001\n');
    const backup = await backupWorld(world);
    assert.notEqual(backup, world);
    assert.equal(await readFile(join(backup, 'level.dat'), 'utf8'), 'fixture');
    assert.equal(await readFile(join(backup, 'db', 'CURRENT'), 'utf8'), 'MANIFEST-000001\n');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

/** Non-void cells of a region, counted independently of the encoder. */
function countRegionCells(structure: Structure, region: Box) {
  let count = 0;
  structure.forEach(() => {
    count++;
  }, region);
  return count;
}

test('streamed direct structure matches the single-buffer encoding across chunk boundaries', () => {
  const structure = new Structure();
  for (let x = 0; x < 24; x++)
    for (let z = 0; z < 24; z++) {
      structure.set(x, 0, z, x % 3 === 0 ? AIR : b('stone'));
      if ((x + z) % 5 === 0) structure.set(x, 1, z, b('oak_planks'));
    }
  // The stream is cut every 7 records, so records land on both sides of many chunks.
  const region: Box = { min: [0, 0, 0], max: [24, 2, 24] };
  const stream = directStructureStream(structure, region, { recordsPerChunk: 7 });
  const chunks = [...stream.chunks];
  assert.equal(stream.blocks, countRegionCells(structure, region));
  assert.deepEqual(Buffer.concat(chunks), encodeDirectStructure(structure, region));
  // Header, block count, then one bounded buffer per 7 records plus a short tail.
  assert.equal(chunks.length, 2 + Math.ceil(stream.blocks / 7));
  assert.equal(chunks[1]!.readUInt32LE(0), stream.blocks);
  const records = chunks.slice(2);
  for (const chunk of records.slice(0, -1)) assert.equal(chunk.length, 7 * 16);
  assert.equal(records.at(-1)!.length, (stream.blocks % 7 || 7) * 16);
});

test('streamed direct structure filters cells outside the placement region', () => {
  const structure = new Structure();
  structure.fill({ min: [-8, 0, -8], max: [24, 3, 24] }, b('stone'));
  structure.set(30, 0, 30, b('diamond_block'));
  const region: Box = { min: [0, 0, 0], max: [16, 2, 16] };
  const stream = directStructureStream(structure, region, { recordsPerChunk: 64 });
  assert.equal(stream.blocks, countRegionCells(structure, region));
  assert.equal(stream.blocks, 16 * 2 * 16);
  assert.deepEqual(Buffer.concat([...stream.chunks]), encodeDirectStructure(structure, region));
});

test('streamed records group every cell of one chunk column together', () => {
  // The world writer holds a single chunk and flushes it when the column changes,
  // so records for a column must arrive contiguously and without interleaving.
  const structure = new Structure();
  for (let x = 0; x < 48; x += 7)
    for (let z = 0; z < 48; z += 5) for (let y = 0; y < 8; y++) structure.set(x, y, z, b('stone'));
  const region: Box = { min: [0, 0, 0], max: [48, 8, 48] };
  const stream = directStructureStream(structure, region, { recordsPerChunk: 3 });
  const records = Buffer.concat([...stream.chunks].slice(2));
  const columns: string[] = [];
  for (let offset = 0; offset < records.length; offset += 16) {
    const x = records.readUInt32LE(offset);
    const z = records.readUInt32LE(offset + 8);
    columns.push(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
  }
  assert.equal(columns.length, stream.blocks);
  const runs = columns.filter((column, index) => column !== columns[index - 1]);
  assert.deepEqual(runs, [...new Set(runs)]);
});
