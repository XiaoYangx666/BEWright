import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startLivePreview } from '../../src/cli/render/live.js';
import type { SnapshotRequest } from '../../src/cli/render/prepare.js';

function snapshotRequest(root: string, id = 'light-fixture', light = false): SnapshotRequest {
  return { id, content: { roots: [root] }, params: {}, name: 'preview', camera: 'iso', options: {},
    cli: { styleName: 'natural', noRender: false, width: 1280, height: 960,
      light, ambient: 0.18, exposure: 1, curve: 1.45, day: 1 } };
}


/** Tiny fixture model: one emitter, one wall, builds in well under a second. */
async function writeFixture(root: string) {
  const building = join(root, 'light-fixture');
  await mkdir(building, { recursive: true });
  await writeFile(
    join(building, 'blockwright.building.json'),
    JSON.stringify({ schemaVersion: 1, id: 'light-fixture', name: 'Light fixture', entry: './building.mjs' }),
  );
  await writeFile(
    join(building, 'building.mjs'),
    `import {defineBuilding,Structure,block} from 'bewright';
export default defineBuilding({id:'light-fixture',name:'Light fixture',bounds:{min:[0,0,0],max:[16,8,8]},build(){const s=new Structure();s.set(2,1,2,block('glowstone'));s.set(8,1,2,block('stone'));return s;}});`,
  );
  return root;
}

/** Regression fixture: a TS entry that imports a sibling via a `./x.js` specifier. */
async function writeSpecifierFixture(root: string) {
  const building = join(root, 'specifier-fixture');
  await mkdir(building, { recursive: true });
  await writeFile(
    join(building, 'blockwright.building.json'),
    JSON.stringify({ schemaVersion: 1, id: 'specifier-fixture', name: 'Specifier fixture', entry: './building.ts' }),
  );
  await writeFile(
    join(building, 'building.ts'),
    `import {defineBuilding} from 'bewright';
import {scene} from './scene.js';
export default defineBuilding(scene);`,
  );
  await writeFile(
    join(building, 'scene.ts'),
    `import {defineBuilding,Structure,block} from 'bewright';
export const scene = {id:'specifier-fixture',name:'Specifier fixture',bounds:{min:[0,0,0],max:[16,8,8]},build(){const s=new Structure();s.set(3,1,3,block('glowstone'));return s;}};`,
  );
  return root;
}

async function waitReady(base: string, accept: (state: any) => boolean = () => true) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await fetch(base + 'state').then((response) => response.json());
    if (state.status === 'error') throw new Error(state.error);
    if (state.status === 'ready' && accept(state)) return state;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error('fixture model did not become ready');
}

test('watch server exposes scriptable lighting state without rebuilds', { timeout: 90_000 }, async () => {
  const parent = resolve('cache');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'lighting-api-'));
  await writeFixture(root);
  const { close, server } = await startLivePreview({
    request: snapshotRequest(root),
    root,
    port: 0,
    watchPaths: [],
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    await waitReady(base);
    assert.deepEqual(await fetch(base + 'lighting').then((r) => r.json()), {
      ambient: 0.18,
      exposure: 1,
      curve: 1.45,
      day: 1,
      light: false,
    });
    const before = await fetch(base + 'state').then((r) => r.json());
    const rejected = await fetch(base + 'lighting', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ambient: 5 }),
    });
    assert.equal(rejected.status, 400);
    const applied = await fetch(base + 'lighting', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ambient: 0.05, curve: 2 }),
    }).then((r) => r.json());
    assert.deepEqual(applied, { ambient: 0.05, exposure: 1, curve: 2, day: 1, light: false });
    assert.deepEqual((await fetch(base + 'state').then((r) => r.json())).lighting, applied);
    const after = await fetch(base + 'state').then((r) => r.json());
    assert.deepEqual(after.lighting, applied);
    assert.equal(after.revision, before.revision, 'lighting must not trigger a rebuild');
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

test('--ambient/--exposure/--curve seed the watch server lighting', { timeout: 90_000 }, async () => {
  const parent = resolve('cache');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'lighting-flag-'));
  await writeFixture(root);
  const { close, server } = await startLivePreview({
    request: snapshotRequest(root),
    root,
    port: 0,
    watchPaths: [],
    lighting: { ambient: 0.05, exposure: 1.3, curve: 2 },
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    await waitReady(base);
    assert.deepEqual(await fetch(base + 'lighting').then((r) => r.json()), {
      ambient: 0.05,
      exposure: 1.3,
      curve: 2,
      day: 1,
      light: false,
    });
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the worker resolves ./x.js content specifiers that point at x.ts', { timeout: 90_000 }, async () => {
  const parent = resolve('cache');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'specifier-fixture-'));
  await writeSpecifierFixture(root);
  const { close, server } = await startLivePreview({
    request: snapshotRequest(root, 'specifier-fixture'),
    root,
    port: 0,
    watchPaths: [],
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const state = await waitReady(base);
    assert.equal(state.status, 'ready');
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

test('lighting defaults to off and can be toggled at runtime; camera is scriptable', { timeout: 120_000 }, async () => {
  const parent = resolve('cache');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'lighting-toggle-'));
  await writeFixture(root);
  const { close, server } = await startLivePreview({
    request: snapshotRequest(root),
    root,
    port: 0,
    watchPaths: [],
    agent: true,
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const ready = await waitReady(base);
    assert.equal(ready.light, false, 'lighting must default to off');
    assert.equal(ready.agent, true, 'agent mode must be reported');
    assert.equal(ready.metrics.lightMs, 0, 'no light work when disabled');

    // Runtime toggle re-runs the build with --light and reports the new state.
    const enabled = await fetch(base + 'lighting', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ light: true }),
    }).then((r) => r.json());
    assert.equal(enabled.light, true);
    const lit = await waitReady(base, (state) => state.light === true && state.revision > ready.revision);
    assert.equal(lit.light, true);
    assert.ok(lit.revision > ready.revision, 'toggling light rebuilds the scene');
    assert.ok(lit.metrics.lightMs > 0, 'the rebuild computed light');

    // Scriptable camera pose, validated and echoed through /state.
    const rejected = await fetch(base + 'camera', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eye: [1, 2], target: [0, 0, 0] }),
    });
    assert.equal(rejected.status, 400);
    const pose = await fetch(base + 'camera', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eye: [6, 4, 9], target: [2, 1, 2] }),
    }).then((r) => r.json());
    assert.deepEqual(pose, { eye: [6, 4, 9], target: [2, 1, 2] });
    assert.deepEqual((await fetch(base + 'state').then((r) => r.json())).pose, pose);
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  '/screenshot returns a PNG at the requested pose',
  { skip: !process.env.BLOCKWRIGHT_LIVE_BROWSER_TEST, timeout: 120_000 },
  async () => {
    const parent = resolve('cache');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'screenshot-'));
    await writeFixture(root);
    const { close, server } = await startLivePreview({
      request: snapshotRequest(root, 'light-fixture', true),
      root,
      port: 0,
      watchPaths: [],
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      await waitReady(base);
      const response = await fetch(
        base + 'screenshot?eye=9,5,9&target=2,1,2&ambient=0.4&width=320&height=240',
      );
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 1000, 'PNG payload expected');
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      // The default pose (no eye/target) works too.
      const plain = await fetch(base + 'screenshot');
      assert.equal(plain.headers.get('content-type'), 'image/png');
      await plain.arrayBuffer();
      // The day factor must reach the render: the fixture's lit cell reads
      // bright at day 1 and falls back to ambient at day 0.
      const day = await fetch(base + 'screenshot?width=320&height=240&day=1').then((r) => r.arrayBuffer());
      const night = await fetch(base + 'screenshot?width=320&height=240&day=0').then((r) => r.arrayBuffer());
      assert.notDeepEqual(Buffer.from(day), Buffer.from(night), 'day factor must change the render');
    } finally {
      close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
