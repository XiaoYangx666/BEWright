import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createScene,
  StructureKit,
  minecraftBlock as b,
  DiagnosticError,
  terrainRecipe,
  recordTerrain,
  scatterPlants,
  Structure,
  block,
  coordinateDiagnostic,
  type Box,
} from '../../src/index.js';
import { generateModel, runModelCheck } from '../../src/content/check.js';
import { applyBedrockWallConnections } from '../../src/blocks/connections.js';
import type { LoadedBuilding } from '../../src/content/load.js';

const bounds: Box = { min: [-8, -2, -8], max: [32, 26, 24] };
function flatScene() {
  const scene = createScene({ bounds, seed: 12 });
  scene.terrain('ground', { base: 0 }, { materials: { rock: 'stone', soil: 'dirt', surface: 'grass_block' } });
  return scene;
}
function blocking(findings: readonly { severity: string }[]) {
  return findings.filter((d) => d.severity === 'error' || d.severity === 'unknown');
}

test('a creator combines terrain, custom roof, railing, tree and plants through one scene', () => {
  const scene = flatScene();
  scene.draw('hall', (kit) => {
    kit.fill(0, 1, 0, 8, 1, 6, 'spruce_planks');
    for (const x of [0, 8]) for (const z of [0, 6]) kit.fill(x, 2, z, x, 6, z, 'oak_log');
  });
  const roof = scene.gableRoof(
    'roof',
    {
      x0: -1,
      x1: 9,
      z0: -1,
      z1: 7,
      eaveY: 7,
      profile: (d) => Math.floor(d / 2),
    },
    {
      tile: 'deepslate_tiles',
      surface: (cell) => (cell.edge ? 'deepslate_tile_slab' : 'deepslate_tiles'),
      decorate: (kit, cell) => {
        if (cell.ridge)
          kit.put(
            ...(cell.position.map((v, i) => (i === 1 ? v + 1 : v)) as [number, number, number]),
            'polished_deepslate',
          );
      },
    },
  );
  scene.railing(
    'edge',
    {
      path: [
        [0, 2, 0],
        [8, 2, 0],
      ],
      gaps: [[3, 5]],
    },
    {
      post: 'oak_fence',
      panel: 'oak_fence',
      place: (kit, cell) => kit.put(...cell.position, cell.post ? 'oak_fence' : 'spruce_fence'),
    },
    { overlap: 'replace' },
  );
  scene.treePreset('pine', {
    kind: 'pine',
    origin: [18, 1, 12],
    height: 8,
    trunk: 'spruce_log',
    leaf: 'spruce_leaves',
  });
  const plants = scene.plants('flowers', {
    x0: 12,
    x1: 15,
    z0: 0,
    z1: 3,
    coverage: 1,
    plants: [{ weight: 1, blocks: ['poppy'] }],
  });
  assert.equal(plants.placed.length, 16);
  assert.equal(scene.world.get(14, 1, 2)?.name, 'minecraft:poppy');
  assert.equal(scene.world.get(18, 1, 12)?.name, 'minecraft:spruce_log');
  assert.ok(roof.ridges.length > 0);
  assert.deepEqual(blocking(scene.check()), []);
});

test('all geometry callbacks are atomic, including decoration and invalid material failures', () => {
  const scene = flatScene();
  const before = scene.world.snapshot();
  assert.throws(
    () =>
      scene.roof(
        'bad-roof',
        { x0: 0, x1: 3, z0: 0, z1: 2, heightAt: () => 6 },
        {
          tile: 'stone',
          decorate: (kit, cell) => {
            kit.put(...cell.position, 'gold_block');
            if (cell.position[0] === 2) throw new Error('ornament failed');
          },
        },
      ),
    DiagnosticError,
  );
  assert.deepEqual(scene.world.snapshot(), before);
  assert.throws(
    () =>
      scene.draw('bad-material', (kit) => {
        kit.put(0, 2, 0, 'oak_planks');
        kit.put(1, 2, 0, 'not_a_minecraft_block');
      }),
    DiagnosticError,
  );
  assert.deepEqual(scene.world.snapshot(), before);
  // Failed drafts do not consume their component id.
  scene.draw('bad-material', (kit) => kit.put(0, 2, 0, 'oak_planks'));
  assert.equal(scene.world.get(0, 2, 0)?.name, 'minecraft:oak_planks');
});

test('bounds cover callback decorations and protection checks each material independently', () => {
  const scene = flatScene();
  scene.protect({ id: 'allowed-stone', region: { min: [0, 2, 0], max: [3, 3, 1] }, allow: ['stone'] });
  const before = scene.world.snapshot();
  assert.throws(
    () =>
      scene.draw('mixed-materials', (kit) => {
        kit.put(0, 2, 0, 'stone');
        kit.put(1, 2, 0, 'oak_planks');
      }),
    (error: unknown) =>
      error instanceof DiagnosticError &&
      error.diagnostics.some((d) => d.target.position?.[0] === 1 && d.rule.startsWith('protection.')),
  );
  assert.deepEqual(scene.world.snapshot(), before);
  assert.throws(
    () =>
      scene.draw('outside', (kit) => {
        kit.put(0, 4, 0, 'stone');
        kit.put(bounds.max[0], 4, 0, 'stone');
      }),
    DiagnosticError,
  );
  assert.deepEqual(scene.world.snapshot(), before);
});

test('invalid coordinates and unbounded drawing cannot cause a partial commit', () => {
  const scene = flatScene();
  const before = scene.world.snapshot();
  for (const invalid of [0.5, NaN, Infinity]) {
    assert.throws(
      () =>
        scene.draw('invalid', (kit) => {
          kit.put(0, 3, 0, 'stone');
          kit.put(invalid, 3, 0, 'stone');
        }),
      DiagnosticError,
    );
    assert.throws(
      () =>
        scene.draw('invalid', (kit) => {
          kit.put(0, 3, 0, 'stone');
          kit.air(invalid, 3, 0);
        }),
      DiagnosticError,
    );
    assert.throws(() => scene.draw('invalid', (kit) => kit.fill(0, 1, 0, invalid, 3, 0, 'stone')), DiagnosticError);
    assert.deepEqual(scene.world.snapshot(), before);
  }
});

test('one where predicate has the same inclusion meaning for terrain and plants', () => {
  const kit = new StructureKit();
  const where = (x: number) => x < 2;
  recordTerrain(kit, terrainRecipe({ base: 0, seed: 1 }), {
    region: { min: [0, 0, 0], max: [4, 1, 1] },
    floorY: 0,
    where,
    materials: { rock: () => b('grass_block') },
  });
  const plants = scatterPlants(kit, {
    x0: 0,
    x1: 3,
    z0: 0,
    z1: 0,
    surfaceY: 0,
    where,
    coverage: 1,
    plants: [{ weight: 1, blocks: ['poppy'] }],
  });
  assert.deepEqual(
    plants.placed.map((p) => p[0]),
    [0, 1],
  );
  assert.equal(kit.get(2, 0, 0), null);
});

test('half-open boxes and connected lines work identically in direct and recorded drawing', () => {
  const scene = createScene({ bounds });
  const direct = new StructureKit();
  const draw = (kit: import('../../src/authoring/kit.js').BlockKit) => {
    kit.fill({ min: [0, 0, 0], max: [4, 3, 4] }, 'stone');
    kit.carve({ min: [1, 1, 1], max: [3, 3, 3] });
    kit.line(
      [
        [0, 4, 0],
        [3, 4, 3],
      ],
      'oak_planks',
    );
  };
  draw(direct);
  scene.draw('room', draw);
  const cells = (world: typeof scene.world) => {
    const entries: string[] = [];
    world.forEach((x, y, z) => entries.push(`${x},${y},${z}:${JSON.stringify(world.get(x, y, z))}`));
    return entries.sort();
  };
  assert.deepEqual(cells(scene.world), cells(direct.s));
  assert.equal(scene.world.get(4, 0, 0), null);
  assert.equal(scene.world.get(1, 1, 1)?.name, 'minecraft:air');
  assert.deepEqual(blocking(scene.check()), []);
});

test('road convenience solves landing heights and orients a fixed stair material', () => {
  const scene = flatScene();
  const road = scene.road(
    'ascent',
    {
      route: [
        [0, 1, 2],
        [18, 7, 2],
      ],
      width: 3,
    },
    {
      surface: 'spruce_planks',
      support: 'stone',
      stairs: 'spruce_stairs',
    },
  );
  assert.ok(road.cells.some((c) => c.stairDirection !== null));
  for (const cell of road.cells.filter((c) => c.stairDirection !== null))
    assert.equal(scene.world.get(cell.x, cell.y, cell.z)?.states.weirdo_direction, cell.stairDirection);
  assert.deepEqual(blocking(scene.check()), []);
});

test('nested scene calls and async geometry cannot leave an outer component half committed', () => {
  const scene = flatScene();
  const before = scene.world.snapshot();
  assert.throws(
    () =>
      scene.draw('outer', (kit) => {
        kit.put(0, 2, 0, 'stone');
        scene.draw('inner', (inner) => inner.put(1, 2, 0, 'stone'));
      }),
    DiagnosticError,
  );
  assert.throws(() => scene.draw('async', async (kit) => kit.put(0, 2, 0, 'stone')), DiagnosticError);
  assert.deepEqual(scene.world.snapshot(), before);
});

test('walkway component callbacks run once and automatic checks catch later broken supports', () => {
  const scene = flatScene();
  let lights = 0;
  const plan = scene.walkway('bridge', {
    route: [
      [2, 8, 5],
      [22, 8, 5],
    ],
    width: 3,
    supports: { spacing: 5, minY: -2 },
    lights: { spacing: 10 },
    materials: {
      surface: 'spruce_planks',
      beam: 'dark_oak_planks',
      pier: 'oak_log',
      rail: 'oak_fence',
      light: (sink, [x, y, z]) => {
        lights++;
        sink.put(x, y, z, 'oak_fence');
        sink.put(x, y + 1, z, 'lantern', { hanging: false });
      },
    },
  });
  const calls = lights;
  assert.ok(calls > 0);
  assert.deepEqual(blocking(scene.check()), []);
  assert.equal(lights, calls);
  const support = plan.supports[0]!;
  scene.world.set(support.x, support.ground + 1, support.z, null);
  assert.ok(scene.check().some((d) => d.rule.startsWith('walkway.') && d.target.position));
  assert.equal(lights, calls);
});

test('canal uses static materials and automatically audits its shared water and bank plans', () => {
  const scene = flatScene();
  const canal = scene.canal('canal', {
    water: {
      source: [2, 0, 8],
      outlet: [16, 0, 8],
      segments: [
        {
          id: 'reach',
          kind: 'reach',
          route: [
            [2, 0, 8],
            [16, 0, 8],
          ],
          halfWidth: 1,
          depth: 2,
        },
      ],
    },
    materials: {
      bed: 'stone',
      bank: 'stone_bricks',
      coping: (sink, bank) => sink.put(bank.x, bank.top + 1, bank.z, 'stone_brick_slab'),
    },
  });
  assert.equal(scene.world.get(8, 0, 8)?.name, 'minecraft:water');
  assert.deepEqual(blocking(scene.check()), []);
  const wall = canal.banks[0]!;
  scene.world.set(wall.x, wall.waterY, wall.z, null);
  assert.ok(scene.check().some((d) => d.rule.startsWith('canal.') || d.rule.startsWith('water.')));
});

test('intentional scene replacement transfers cell ownership; raw edits remain located', () => {
  const scene = flatScene();
  scene.draw('foundation', (kit) => kit.put(0, 1, 0, 'stone_bricks'));
  assert.throws(() => scene.draw('unapproved', (kit) => kit.put(0, 1, 0, 'oak_planks')), DiagnosticError);
  scene.draw('finished-floor', (kit) => kit.put(0, 1, 0, 'oak_planks'), { overlap: 'replace' });
  assert.deepEqual(blocking(scene.check()), []);
  scene.world.set(0, 1, 0, b('dirt'));
  const finding = scene.check().find((d) => d.rule === 'authoring.changed-cell');
  assert.equal(finding?.object.id, 'finished-floor');
  assert.deepEqual(finding?.target.position, [0, 1, 0]);
});

test('derived wall connections are allowed while real slab state changes are rejected', () => {
  const scene = flatScene();
  scene.draw('walls', (kit) => kit.fill(0, 1, 0, 2, 1, 0, 'stone_brick_wall'));
  scene.draw('slab', (kit) => kit.slab(4, 1, 0, 'stone_brick_slab', true));
  applyBedrockWallConnections(scene.world, bounds);
  assert.deepEqual(blocking(scene.check()), []);
  scene.world.set(4, 1, 0, b('stone_brick_slab', { 'minecraft:vertical_half': 'bottom' }));
  assert.ok(scene.check().some((d) => d.rule === 'authoring.changed-cell' && d.object.id === 'slab'));
});

test('custom species and transformed prefabs share final geometry auditing', () => {
  const scene = flatScene();
  const report = scene.vegetation('shrubs', {
    x0: 12,
    x1: 14,
    z0: 12,
    z1: 14,
    base: 0,
    layers: [
      {
        layer: 'shrub',
        coverage: 1,
        seed: 1,
        species: [
          {
            id: 'custom',
            layer: 'shrub',
            weight: 1,
            generate: () => {
              const kit = new StructureKit();
              kit.put(0, 0, 0, 'oak_leaves');
              return kit.s;
            },
          },
        ],
      },
    ],
  });
  assert.equal(report.placed, 9);
  const prefab = new StructureKit();
  prefab.stair(0, 0, 0, 0, 'oak_stairs');
  scene.place('turned', { prefab: prefab.s, origin: [0, 1, 0], transform: { rotation: 90, mirror: 'none' } });
  assert.notEqual(scene.world.get(0, 1, 0)?.states.weirdo_direction, 0);
  assert.deepEqual(blocking(scene.check()), []);
});

test('natural and constructed stone have different ownership, including excavation and prefab air', () => {
  const scene = flatScene();
  scene.draw('stonework', (kit) => kit.put(0, 1, 0, 'stone'));
  const original = scene.world.snapshot();
  assert.throws(() => scene.draw('overwrite', (kit) => kit.put(0, 1, 0, 'dirt')), DiagnosticError);
  assert.throws(() => scene.draw('dig', (kit) => kit.air(0, 1, 0)), DiagnosticError);
  const clear = new StructureKit();
  clear.air(0, 0, 0);
  assert.throws(() => scene.place('clear', { prefab: clear.s, origin: [0, 1, 0] }), DiagnosticError);
  assert.deepEqual(scene.world.snapshot(), original);
  const stone = new StructureKit();
  stone.put(0, 0, 0, 'stone');
  // Idempotence uses the common permission policy, with no second overlap pass.
  scene.place('restamp', { prefab: stone.s, origin: [0, 1, 0] });
  scene.draw('soil-cut', (kit) => kit.air(2, 0, 0));
  scene.place('authorized-clear', { prefab: clear.s, origin: [0, 1, 0] }, { overlap: 'replace' });
  assert.equal(scene.world.get(0, 1, 0)?.name, 'minecraft:air');
  assert.deepEqual(blocking(scene.check()), []);
});

test('component bounds may narrow the scene but cannot expand it', () => {
  const scene = flatScene();
  const before = scene.world.snapshot();
  assert.throws(
    () =>
      scene.draw('outside', (kit) => kit.put(33, 1, 0, 'stone'), {
        bounds: { min: [-8, -2, -8], max: [40, 26, 24] },
      }),
    /inside the scene/,
  );
  assert.deepEqual(scene.world.snapshot(), before);
  const outsideAir = new StructureKit();
  outsideAir.air(40, 0, 0);
  assert.throws(() => scene.place('air-outside', { prefab: outsideAir.s, origin: [0, 0, 0] }), DiagnosticError);
  assert.deepEqual(scene.world.snapshot(), before);
  assert.throws(() => scene.place('fractional', { prefab: outsideAir.s, origin: [0.5, 0, 0] }));
  assert.deepEqual(scene.world.snapshot(), before);
});

test('prefab placement resolves all materials before committing any clearing or foundation', () => {
  const scene = flatScene();
  const before = scene.world.snapshot();
  const prefab = new Structure();
  prefab.set(0, 0, 0, block('air'));
  prefab.set(1, 0, 0, block('not_a_registered_material'));
  assert.throws(() => scene.place('bad-prefab', { prefab, origin: [0, 0, 0] }), DiagnosticError);
  assert.deepEqual(scene.world.snapshot(), before);
  const raised = new StructureKit();
  raised.put(0, 0, 0, 'oak_planks');
  scene.place('foundation', {
    prefab: raised.s,
    origin: [0, 3, 0],
    surface: scene.surfaces,
    maxFoundation: 3,
    foundation: 'stone',
  });
  assert.equal(scene.world.get(0, 2, 0)?.name, 'minecraft:stone');
  assert.deepEqual(blocking(scene.check()), []);
});

test('grounding retains foundation checks while allowing subsequent superstructure', () => {
  const scene = flatScene();
  scene.grounding(
    'foundation',
    {
      footprint: { x0: 0, x1: 4, z0: 0, z1: 4 },
      floorY: 2,
      mode: 'plinth',
      maxCut: 0,
      maxFill: 3,
      earthworkBudget: 100,
    },
    { floor: 'stone_bricks', foundation: 'stone' },
  );
  scene.draw('columns', (kit) => kit.fill(0, 3, 0, 0, 6, 0, 'oak_log'));
  assert.deepEqual(blocking(scene.check()), []);
  scene.draw('missing-foot', (kit) => kit.air(0, 1, 0), { overlap: 'replace' });
  assert.ok(scene.check().some((d) => d.rule === 'grounding.foundation-gap'));
});

test('tree final checks read the current model after intentional scene edits', () => {
  const scene = flatScene();
  const spec = {
    kind: 'pine',
    origin: [10, 1, 10],
    height: 8,
    trunk: 'spruce_log',
    leaf: 'spruce_leaves',
  } as const;
  const tree = scene.treePreset('pine', { ...spec, origin: [...spec.origin] });
  tree.structure.set(0, 2, 0, null);
  assert.deepEqual(blocking(scene.check()), []);
  scene.draw('trunk-cut', (kit) => kit.air(10, 3, 10), { overlap: 'replace' });
  const finding = scene.check().find((d) => d.rule === 'tree.changed-cell');
  assert.deepEqual(finding?.target.position, [10, 3, 10]);
});

test('build/check runs component assertions without a building check and respects explicit skip', async () => {
  const definition = {
    id: 'scene-test',
    name: 'Scene test',
    bounds,
    build: () => {
      const scene = flatScene();
      scene.verify('entrance', (world) =>
        world.get(0, 0, 0)?.name === 'minecraft:grass_block'
          ? []
          : [
              coordinateDiagnostic({
                rule: 'entrance.changed',
                object: 'door',
                position: [0, 0, 0],
                message: 'Door ground changed',
              }),
            ],
      );
      return scene.world;
    },
  };
  const loaded: LoadedBuilding = {
    definition,
    discovered: {
      id: definition.id,
      name: definition.name,
      root: '',
      entry: '',
      manifestPath: '',
      editions: ['bedrock'],
      status: 'stable',
      source: 'test',
    },
  };
  const generated = generateModel(definition);
  assert.equal((await runModelCheck(loaded, generated)).status, 'passed');
  const skipped = await runModelCheck(loaded, generated, { check: false });
  assert.equal(skipped.status, 'not-run');
  assert.equal(skipped.executed, false);
  generated.world.set(0, 0, 0, null);
  const checked = await runModelCheck(loaded, generated);
  assert.equal(checked.status, 'failed');
  assert.ok(checked.diagnostics.some((d) => d.rule === 'entrance.changed'));
});
