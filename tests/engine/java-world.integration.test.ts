import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { read } from 'nbtify';
import { block, Structure } from '../../src/core/structure.js';
import { defaultJavaExporterBinary, exportJavaWorld, JAVA_TARGET } from '../../src/targets/java/world.js';

test('built Java exporter creates independently readable level and region NBT', { skip: !existsSync(defaultJavaExporterBinary()) }, async () => {
  const worldsDir = join(tmpdir(), `blockwright-java-${process.pid}-${Date.now()}`);
  const output = join(worldsDir, 'independent-world');
  try {
    const world = new Structure();
    world.set(-1, -64, 0, block('stone'));
    world.set(0, 0, 0, block('oak_stairs', { weirdo_direction: 3, upside_down_bit: false }));
    const report = await exportJavaWorld(world, { min: [-16, -64, 0], max: [16, 1, 16] }, {
      worldsDir, folderName: 'independent-world', name: 'Blockwright Java integration', spawn: [0, 1, 0], seed: 8,
    });
    assert.deepEqual({ chunks: report.chunks, regions: report.regions, blocks: report.blocks }, { chunks: 2, regions: 2, blocks: 2 });
    const level: any = (await read(gunzipSync(await readFile(join(output, 'level.dat'))), { endian: 'big', compression: null, strict: true })).data;
    assert.equal(Number(level.Data.DataVersion), JAVA_TARGET.dataVersion);
    assert.equal(String(level.Data.LevelName), 'Blockwright Java integration');
    assert.equal(String(level.Data.Version.Name), JAVA_TARGET.gameVersion);
    assert.equal(Number(level.Data.version), 19133);
    assert.deepEqual(Array.from(level.Data.spawn.pos, Number), [0, 1, 0]);
    assert.ok(existsSync(join(output, 'level.dat_old')));
    const worldGen: any = (await read(gunzipSync(await readFile(join(output, 'data', 'minecraft', 'world_gen_settings.dat'))), { endian: 'big', compression: null, strict: true })).data;
    assert.equal(Number(worldGen.DataVersion), JAVA_TARGET.dataVersion);
    assert.equal(String(worldGen.data.dimensions['minecraft:overworld'].type), 'minecraft:overworld');
    assert.equal(String(worldGen.data.dimensions['minecraft:overworld'].generator.type), 'minecraft:flat');
    assert.equal(Number(worldGen.data.dimensions['minecraft:overworld'].generator.settings.features), 0);
    assert.equal(Number(worldGen.data.dimensions['minecraft:overworld'].generator.settings.lakes), 0);
    assert.deepEqual(Array.from(worldGen.data.dimensions['minecraft:overworld'].generator.settings.layers, (l: any) => String(l.block)), ['minecraft:bedrock', 'minecraft:dirt', 'minecraft:grass_block']);
    const region = await readFile(join(output, 'dimensions', 'minecraft', 'overworld', 'region', 'r.0.0.mca'));
    const sector = region.readUIntBE(0, 3);
    const length = region.readUInt32BE(sector * 4096);
    assert.equal(region[sector * 4096 + 4], 2);
    const compressed = region.subarray(sector * 4096 + 5, sector * 4096 + 4 + length);
    const chunk: any = (await read(inflateSync(compressed), { endian: 'big', compression: null, strict: true })).data;
    assert.equal(Number(chunk.DataVersion), JAVA_TARGET.dataVersion);
    assert.equal(Number(chunk.xPos), 0);
    assert.ok(chunk.sections.some((section: any) => Number(section.Y) === 0));
  } finally {
    await rm(worldsDir, { recursive: true, force: true });
  }
});
