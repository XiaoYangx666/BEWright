import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { normalizePlacementIds } from '../../src/content/world-layout.js';
import { comparePreservation } from '../../src/targets/bedrock/preserve.js';
import { backupWorld } from '../../src/targets/bedrock/world.js';

test('placement ids accept repeated and comma-separated values', () => {
  assert.deepEqual(normalizePlacementIds(['cafe', 'promenade, poolrooms', 'cafe', ' ']), [
    'cafe',
    'promenade',
    'poolrooms',
  ]);
  assert.deepEqual(normalizePlacementIds(undefined), []);
});

test('preservation compares level.dat hashes and player keys', () => {
  const before = { levelDatSha256: 'a', levelDatBytes: 10, players: ['player_a', 'player_b'] };
  const after = { levelDatSha256: 'a', levelDatBytes: 10, players: ['player_a', 'player_b'] };
  const unchanged = comparePreservation(before, after);
  assert.equal(unchanged.levelDatUnchanged, true);
  assert.equal(unchanged.players.preserved, true);
  const changed = comparePreservation(before, { ...after, levelDatSha256: 'b', players: ['player_a'] });
  assert.equal(changed.levelDatUnchanged, false);
  assert.equal(changed.players.preserved, false);
  assert.equal(comparePreservation(before, { ...after, players: null }).players.preserved, null);
});

test('backups can be directed outside the world parent', async (t) => {
  const root = await mkdtemp(join(resolve('cache'), 'world-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = join(root, 'world');
  const backups = join(root, 'backups');
  await mkdir(join(world, 'db'), { recursive: true });
  await writeFile(join(world, 'level.dat'), 'level');
  await writeFile(join(world, 'db', 'CURRENT'), 'MANIFEST-000001\n');
  const target = await backupWorld(world, backups);
  assert.equal(dirname(target), backups);
  assert.equal(await readFile(join(target, 'level.dat'), 'utf8'), 'level');
  assert.equal(await readFile(join(target, 'db', 'CURRENT'), 'utf8'), 'MANIFEST-000001\n');
});
