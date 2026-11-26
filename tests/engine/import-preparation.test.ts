import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importCommand } from '../../src/cli/commands/import.js';

test('Bedrock preparation failures never create a world, and dry runs never generate', async (t) => {
  const cache = resolve('cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'import-preparation-'));
  const id = `preparation-${Date.now()}`;
  const building = join(root, id);
  await mkdir(building);
  const entry = join(building, 'building.mjs');
  await writeFile(
    join(building, 'blockwright.building.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Preparation fixture',
      entry: './building.mjs',
    }),
  );
  await writeFile(
    entry,
    `import { Structure, block, defineBuilding } from 'bewright';
export let builds = 0;
export default defineBuilding({ id: '${id}', name: 'Preparation fixture',
  params: { mode: { type: 'string', default: 'throw' } },
  bounds: { min: [0,0,0], max: [16,4,16] },
  spawn: [1,1,1],
  build({mode}) { builds++; if(mode==='throw') throw Error('fixture generation failed');
    const s = new Structure(); s.set(0,0,0,block('not_a_real_block')); return s; },
  check() { throw Error('import must not execute building checks'); }
});`,
  );
  const options = [id, '--content', root, '--worlds-dir', join(root, 'worlds'), '--folder', 'destination'];
  const printed: string[] = [];
  t.mock.method(console, 'log', (line: string) => printed.push(line));
  try {
    await assert.rejects(() => importCommand([...options, '--origin', '1,64,0']), /multiples of 16/);
    await assert.rejects(() => importCommand(options), /fixture generation failed/);
    await assert.rejects(() => importCommand([...options, '--param', 'mode=invalid']), /not_a_real_block/);
    assert.deepEqual(await readdir(root), [id]);
    const loaded = await import(pathToFileURL(entry).href);
    const before = loaded.builds;
    await importCommand([...options, '--dry-run']);
    assert.equal(loaded.builds, before);
    assert.deepEqual(await readdir(root), [id]);
    const local = [building, '--local', '--origin=16,-58,-16', '--dry-run'];
    await importCommand([...local, '--folder', 'local-preview']);
    const plan = JSON.parse(printed.at(-1)!);
    assert.equal(plan.building, id);
    assert.equal(plan.world, join(building, 'output', 'bedrock-worlds', 'local-preview'));
    assert.deepEqual(plan.spawn, [17, -57, -15]);
    assert.equal(loaded.builds, before);
    await assert.rejects(() => importCommand([...local, '--folder', '..']), /Invalid world folder name/);
    const file = join(root, 'fixture.mcstructure');
    await writeFile(file, 'file placement must validate alignment without parsing');
    await assert.rejects(
      () => importCommand(['--file', file, '--worlds-dir', join(root, 'worlds'), '--origin', '1,64,0']),
      /multiples of 16/,
    );
    assert.deepEqual((await readdir(root)).sort(), [id, 'fixture.mcstructure'].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
