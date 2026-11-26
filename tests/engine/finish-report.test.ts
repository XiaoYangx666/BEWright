import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Structure, type Box } from '../../src/core/structure.js';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { coordinateDiagnostic } from '../../src/authoring/diagnostic-core.js';
import { diagnosticMarkers } from '../../src/preview/diagnostics.js';
import { runBuild } from '../../src/content/pipeline.js';
import { createProjectContext } from '../../src/project/context.js';
import { previewCommand } from '../../src/cli/commands/preview.js';
import type { LoadedBuilding } from '../../src/content/load.js';

const bounds: Box = { min: [0, 0, 0], max: [8, 8, 8] };
const missing = coordinateDiagnostic({
  rule: 'walkway.support-gap',
  object: { kind: 'walkway', id: 'test' },
  position: [2, 2, 2],
  message: 'missing pier',
});
test('build artifacts retain complete building findings alongside model and preview diagnostics', async () => {
  const cache = resolve('cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'finish-report-'));
  const loaded: LoadedBuilding = {
    definition: {
      id: 'fixture',
      name: 'fixture',
      bounds,
      build: () => {
        const s = new Structure();
        s.set(0, 0, 0, minecraftBlock('stone'));
        return s;
      },
      check: () => [missing],
    },
    discovered: {
      id: 'fixture',
      name: 'fixture',
      root,
      entry: '',
      manifestPath: '',
      editions: ['bedrock'],
      status: 'stable',
      source: 'test',
    },
  };
  try {
    const result = await runBuild(loaded, { project: createProjectContext(root) });
    const report = JSON.parse(await readFile(join(result.artifactDir, 'report.json'), 'utf8'));
    assert.equal(report.check.status, 'failed');
    assert.equal(report.diagnosticCounts.error, 1);
    for (const list of [report.diagnosticsUnified, report.buildingDiagnostics, report.check.diagnostics])
      assert.ok(list.some((d: typeof missing) => d.rule === missing.rule && d.target.position?.join(',') === '2,2,2'));
    assert.equal(report.modelDiagnostics.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostic overlays show cell/region findings in the selected view without changing model geometry', () => {
  const outside = coordinateDiagnostic({ rule: 'outside', position: [20, 0, 0], message: 'outside' }),
    info = coordinateDiagnostic({ rule: 'coverage', region: bounds, severity: 'info', message: 'coverage' });
  const unknown = coordinateDiagnostic({
    rule: 'unsupported',
    region: { min: [4, 0, 4], max: [6, 3, 6] },
    severity: 'unknown',
    conclusive: false,
    message: 'unknown',
  });
  const markers = diagnosticMarkers([missing, outside, info, unknown], bounds);
  assert.equal(markers.length, 2);
  assert.deepEqual(markers[0]?.bounds, { min: [2, 2, 2], max: [3, 3, 3] });
  assert.equal(markers[0]?.color, '#ff3159');
  assert.equal(markers[1]?.color, '#ffb32c');
});

test(
  'checked static preview renders current-model markers and returns the saved screenshot path',
  { skip: process.env.BLOCKWRIGHT_LIVE_BROWSER_TEST !== '1' },
  async () => {
    const cache = resolve('cache');
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(join(cache, 'finish-preview-'));
    const name = 'finish-preview-regression',
      previewRoot = join(root, 'output', 'previews');
    const originalLog = console.log,
      logs: string[] = [];
    try {
      await writeFile(
        join(root, 'blockwright.building.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: 'finish-preview-regression',
          name: 'Finish preview regression',
          entry: './building.ts',
          status: 'wip',
        }),
      );
      await writeFile(
        join(root, 'building.ts'),
        `import {defineBuilding,Structure,minecraftBlock,coordinateDiagnostic} from 'bewright';
      let builds=0;export default defineBuilding({id:'finish-preview-regression',name:'Finish preview regression',bounds:{min:[0,0,0],max:[4,4,4]},build:()=>{builds++;const s=new Structure();s.set(1,0,1,minecraftBlock('stone'));return s;},check:()=>{if(builds!==1)throw new Error('duplicate generation');return [coordinateDiagnostic({rule:'test.missing',position:[1,1,1],message:'marker fixture'})];}});`,
      );
      console.log = (...args) => logs.push(args.map(String).join(' '));
      await previewCommand([
        'finish-preview-regression',
        '--content',
        root,
        '--check',
        '--report',
        '--json',
        '--name',
        name,
        '--width',
        '320',
        '--height',
        '240',
      ]);
      const result = JSON.parse(logs.at(-1)!);
      assert.equal(resolve(result.image), join(previewRoot, `${name}-iso.png`));
      assert.ok((await readFile(resolve(result.image))).length > 100);
      const metadata = JSON.parse(await readFile(join(previewRoot, `${name}.json`), 'utf8'));
      assert.equal(metadata.checkDiagnostics[0].rule, 'test.missing');
      assert.equal(metadata.markers.length, 1);
      assert.deepEqual(metadata.markers[0].bounds.min, [1, 1, 1]);
    } finally {
      console.log = originalLog;
      await rm(root, { recursive: true, force: true });
      for (const file of [`${name}-iso.png`, `${name}.json`, `${name}.render.json`])
        await rm(join(previewRoot, file), { force: true });
    }
  },
);
