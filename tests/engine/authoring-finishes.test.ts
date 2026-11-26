import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure, AIR, type Vec3 } from '../../src/core/structure.js';
import { minecraftBlock } from '../../src/blocks/registry.js';
import { planWalkway, buildWalkway, checkWalkway, type WalkwaySpec } from '../../src/authoring/walkway.js';
import { planFinishedCanal, buildFinishedCanal, checkFinishedCanal } from '../../src/authoring/canal.js';
import { planWaterSystem } from '../../src/authoring/water/plan.js';
import { SurfaceQuery } from '../../src/authoring/surface.js';
import { planRoad } from '../../src/authoring/roads.js';
import { planRoadProfile } from '../../src/authoring/road-profile.js';

const stone = minecraftBlock('stone');
function ground() {
  const s = new Structure();
  s.fill({ min: [-10, 4, -10], max: [25, 5, 25] }, stone);
  return s;
}
function walkway(y = 10): WalkwaySpec {
  return {
    id: 'test-walkway',
    route: [
      [0, y, 0],
      [12, y, 0],
    ],
    width: 5,
    supports: { spacing: 6, minY: 0 },
    railing: { height: 1 },
    lights: { spacing: 8 },
    materials: {
      surface: () => minecraftBlock('spruce_planks'),
      beam: () => minecraftBlock('dark_oak_planks'),
      pier: () => minecraftBlock('dark_oak_log'),
      rail: () => minecraftBlock('dark_oak_fence'),
      light: (sink, [x, y, z]) => {
        sink.put(x, y, z, 'dark_oak_fence');
        sink.put(x, y + 1, z, 'lantern', { hanging: false });
      },
    },
  };
}
function canal(width = 1, level = 8) {
  const world = ground();
  const water = planWaterSystem({
    id: 'pool-channel',
    source: [0, level, 0],
    outlet: [0, level, 12],
    segments: [
      {
        id: 'pond',
        kind: 'pool',
        path: [[0, level, 0]],
        depth: 3,
        basin: { min: [-3, level - 3, -3], max: [4, level + 1, 4] },
        outline: (x, z) => x * x + z * z <= 9,
      },
      {
        id: 'channel',
        kind: 'reach',
        path: Array.from({ length: 10 }, (_, i) => [0, level, i + 3] as Vec3),
        halfWidth: width,
        depth: 3,
      },
    ],
  });
  const plan = planFinishedCanal(
    world,
    {
      water,
      materials: {
        water: () => minecraftBlock('water'),
        bed: () => stone,
        bank: () => minecraftBlock('stone_bricks'),
        coping: (sink, b) =>
          sink.put(b.x, b.top + 1, b.z, minecraftBlock('stone_brick_slab', { 'minecraft:vertical_half': 'bottom' })),
      },
    },
    { excavationAuthorized: true },
  );
  return { world, plan };
}

test('walkway height changes move decks, rails, fixtures and ground-to-beam supports together', () => {
  const world = ground(),
    revision = world.revision;
  const low = planWalkway(world, walkway()),
    high = planWalkway(world, walkway(13));
  assert.equal(world.revision, revision);
  assert.equal(low.construction.feasible, true);
  assert.deepEqual(
    high.supports,
    low.supports.map((s) => ({ ...s, deckY: s.deckY + 3 })),
  );
  assert.deepEqual(
    high.rails.map((c) => c.position),
    low.rails.map((c) => [c.position[0], c.position[1] + 3, c.position[2]]),
  );
  assert.deepEqual(
    high.fixtures.map((c) => c.position),
    low.fixtures.map((c) => [c.position[0], c.position[1] + 3, c.position[2]]),
  );
  buildWalkway(world, high);
  assert.deepEqual(checkWalkway(world, high), []);
});

test('walkway uses existing solved road profiles and leaves declared access volumes clear', () => {
  const world = ground();
  const road = planRoadProfile(world, {
    id: 'profile',
    waypoints: [
      [0, 5, 0],
      [12, 5, 0],
    ],
    width: 4,
    minY: 5,
    maxY: 5,
    maxCut: 0,
    maxFill: 0,
    earthworkBudget: 0,
  });
  const plan = planWalkway(
    world,
    { ...walkway(5), road, openings: [{ min: [-2, 0, -4], max: [3, 20, 5] }] },
    { excavationAuthorized: true },
  );
  assert.equal(plan.road, road);
  buildWalkway(world, plan);
  assert.ok(plan.rails.every((c) => c.position[0] >= 3));
  assert.deepEqual(checkWalkway(world, plan), []);
});

test('final walkway check detects a later cut at the pier foot and a removed rail and fixture', () => {
  const world = ground(),
    plan = planWalkway(world, walkway());
  buildWalkway(world, plan);
  const support = plan.supports.find((s) => s.ground + 1 < s.deckY)!,
    rail = plan.rails[0]!,
    fixture = plan.fixtures.at(-1)!;
  world.set(support.x, support.ground, support.z, AIR);
  world.set(...rail.position, AIR);
  world.set(...fixture.position, AIR);
  const diagnostics = checkWalkway(world, plan);
  assert.ok(
    diagnostics.some(
      (d) =>
        d.rule === 'walkway.support-gap' &&
        d.target.position?.join(',') === [support.x, support.ground, support.z].join(','),
    ),
  );
  assert.ok(
    diagnostics.some(
      (d) => d.rule === 'walkway.railing-gap' && d.target.position?.join(',') === rail.position.join(','),
    ),
  );
  assert.ok(diagnostics.some((d) => d.rule === 'walkway.fixture-gap'));
});

test('unresolved support and failing materials refuse the whole walkway without partial writes', () => {
  const empty = new Structure(),
    spec = walkway();
  const plan = planWalkway(empty, spec);
  assert.ok(plan.construction.diagnostics.some((d) => d.severity === 'unknown'));
  assert.throws(() => buildWalkway(empty, plan));
  assert.equal(empty.revision, 0);
  const world = ground(),
    revision = world.revision;
  const refused = planWalkway(world, {
    ...spec,
    materials: {
      ...spec.materials,
      rail: () => {
        throw new Error('bad fixture');
      },
    },
  });
  assert.equal(refused.construction.feasible, false);
  assert.throws(() => buildWalkway(world, refused));
  assert.equal(world.revision, revision);
  const stale = planWalkway(world, spec);
  world.set(20, 5, 20, stone);
  assert.throws(() => buildWalkway(world, stale), /revision/);
});

test('canal width and water level drive pond banks and coping from one water footprint', () => {
  const narrow = canal(),
    wide = canal(2),
    raised = canal(1, 10);
  for (const { world, plan } of [narrow, wide, raised]) {
    assert.equal(plan.construction.feasible, true, JSON.stringify(plan.construction.diagnostics));
    buildFinishedCanal(world, plan);
    assert.deepEqual(
      checkFinishedCanal(world, plan).filter((d) => d.severity !== 'info'),
      [],
    );
  }
  assert.ok(wide.plan.banks.some((b) => b.x === 3 && b.z === 8));
  assert.ok(!narrow.plan.banks.some((b) => b.x === 3 && b.z === 8));
  assert.deepEqual(
    raised.plan.banks,
    narrow.plan.banks.map((b) => ({ ...b, bottom: b.bottom + 2, waterY: b.waterY + 2, top: b.top + 2 })),
  );
});

test('final canal checks locate removed bed, bank, unsupported coping and severed outlet', () => {
  const { world, plan } = canal();
  buildFinishedCanal(world, plan);
  const bank = plan.banks.find((b) => b.z === 8)!,
    cap = plan.coping.find((c) => c.position[2] === 9)!;
  world.set(0, 5, 8, AIR);
  world.set(bank.x, bank.waterY, bank.z, AIR);
  world.set(cap.position[0], cap.position[1] - 1, cap.position[2], AIR);
  for (let x = -1; x <= 1; x++) for (let y = 6; y <= 8; y++) world.set(x, y, 10, stone);
  const findings = checkFinishedCanal(world, plan);
  for (const rule of ['water.basin-floor', 'canal.bank-gap', 'canal.coping-support', 'canal.disconnected'])
    assert.ok(
      findings.some((d) => d.rule === rule),
      rule,
    );
  assert.ok(findings.filter((d) => d.severity !== 'info').every((d) => d.object.id && d.target.position));
  world.set(cap.position[0], cap.position[1] - 1, cap.position[2], {
    name: 'minecraft:unrecognized_support',
    states: {},
  });
  const unknown = checkFinishedCanal(world, plan).find(
    (d) => d.rule === 'canal.coping-support' && d.target.position?.join(',') === cap.position.join(','),
  );
  assert.equal(unknown?.severity, 'unknown');
  assert.equal(unknown?.conclusive, false);
});

test('declared external water ports are preserved and an obstructed port is caught after construction', () => {
  const world = ground();
  for (let x = -1; x <= 1; x++) for (let y = 6; y <= 8; y++) world.set(x, y, 6, minecraftBlock('water'));
  const water = planWaterSystem({
    id: 'outflow',
    source: [0, 8, 0],
    outlet: [0, 8, 5],
    segments: [
      {
        id: 'reach',
        kind: 'reach',
        path: Array.from({ length: 6 }, (_, z) => [0, 8, z] as Vec3),
        depth: 3,
        halfWidth: 1,
      },
    ],
  });
  const plan = planFinishedCanal(
    world,
    {
      water,
      openBoundary: (p) => p[2] === 6,
      materials: { water: () => minecraftBlock('water'), bed: () => stone, bank: () => stone },
    },
    { excavationAuthorized: true },
  );
  buildFinishedCanal(world, plan);
  assert.deepEqual(
    checkFinishedCanal(world, plan).filter((d) => d.severity !== 'info'),
    [],
  );
  assert.ok(plan.connections.length > 0);
  world.set(0, 8, 6, stone);
  assert.ok(
    checkFinishedCanal(world, plan).some(
      (d) => d.rule === 'canal.disconnected' && d.target.position?.join(',') === '0,8,6',
    ),
  );
});

test('a mandatory receiving port cannot silently become a closed bank when initially dry or blocked', () => {
  for (const blocked of [false, true]) {
    const world = ground();
    if (blocked) world.set(0, 8, 6, stone);
    const revision = world.revision;
    const water = planWaterSystem({
      id: 'mandatory-outflow',
      source: [0, 8, 0],
      outlet: [0, 8, 5],
      segments: [
        {
          id: 'reach',
          kind: 'reach',
          path: Array.from({ length: 6 }, (_, z) => [0, 8, z] as Vec3),
          depth: 3,
          halfWidth: 1,
        },
      ],
    });
    const plan = planFinishedCanal(
      world,
      {
        water,
        requiredConnections: [[0, 8, 6]],
        openBoundary: (p) => p[2] === 6,
        materials: { water: () => minecraftBlock('water'), bed: () => stone, bank: () => stone },
      },
      { excavationAuthorized: true },
    );
    assert.equal(plan.construction.feasible, false);
    assert.ok(
      plan.construction.diagnostics.some(
        (d) => d.rule === 'canal.disconnected' && d.target.position?.join(',') === '0,8,6',
      ),
    );
    assert.throws(() => buildFinishedCanal(world, plan));
    assert.equal(world.revision, revision);
  }
});

test('sloping switchbacks hold a landing at each wide bend and leave a usable deck', () => {
  const world = ground(),
    base = walkway(10);
  const plan = planWalkway(world, {
    ...base,
    route: [
      [0, 10, 0],
      [15, 14, 0],
      [15, 19, 15],
      [0, 23, 15],
    ],
    materials: {
      ...base.materials,
      stairs: (_, dir) => minecraftBlock('spruce_stairs', { weirdo_direction: dir, upside_down_bit: false }),
    },
  });
  assert.equal(plan.construction.feasible, true, JSON.stringify(plan.construction.diagnostics));
  buildWalkway(world, plan);
  assert.ok(plan.road.cells.some((c) => c.y === 14));
  assert.deepEqual(
    checkWalkway(world, plan).filter((d) => d.severity !== 'info'),
    [],
  );
});

test('deep stepped reaches connect by their overlapping volume; dry diagonal surfaces still fail', () => {
  const path: Vec3[] = [
    [0, 8, 0],
    [0, 8, 1],
    [0, 7, 2],
    [0, 7, 3],
    [0, 6, 4],
  ];
  const spec = {
    id: 'steps',
    source: path[0]!,
    outlet: path.at(-1),
    segments: [{ id: 'reach', kind: 'reach' as const, path, halfWidth: 1, depth: 3 }],
  };
  assert.equal(planWaterSystem(spec).feasible, true);
  assert.equal(planWaterSystem({ ...spec, segments: [{ ...spec.segments[0]!, depth: 1 }] }).feasible, false);
  const world = ground();
  const plan = planFinishedCanal(
    world,
    {
      water: planWaterSystem(spec),
      materials: { water: () => minecraftBlock('water'), bed: () => stone, bank: () => stone },
    },
    { excavationAuthorized: true },
  );
  assert.equal(plan.construction.feasible, true, JSON.stringify(plan.construction.diagnostics));
  buildFinishedCanal(world, plan);
  assert.deepEqual(
    checkFinishedCanal(world, plan).filter((d) => d.severity !== 'info'),
    [],
  );
});

test('a deeper pond and overlapping shallower reach retain their shared real bed', () => {
  const world = ground(),
    water = planWaterSystem({
      id: 'overlap',
      source: [0, 10, 0],
      outlet: [0, 10, 8],
      segments: [
        { id: 'pond', kind: 'pool', path: [[0, 10, 0]], depth: 5, basin: { min: [-3, 5, -3], max: [4, 11, 4] } },
        {
          id: 'reach',
          kind: 'reach',
          path: Array.from({ length: 9 }, (_, z) => [0, 10, z] as Vec3),
          halfWidth: 1,
          depth: 3,
        },
      ],
    });
  const plan = planFinishedCanal(
    world,
    { water, materials: { water: () => minecraftBlock('water'), bed: () => stone, bank: () => stone } },
    { excavationAuthorized: true },
  );
  assert.equal(plan.construction.feasible, true, JSON.stringify(plan.construction.diagnostics));
  buildFinishedCanal(world, plan);
  assert.equal(world.get(0, 7, 0)?.name, 'minecraft:water');
  assert.equal(world.get(0, 5, 0)?.name, 'minecraft:stone');
  assert.deepEqual(
    checkFinishedCanal(world, plan).filter((d) => d.severity !== 'info'),
    [],
  );
});

test('bounded support surveys skip whole-model inspection and still invalidate column results', () => {
  const world = ground();
  let inspections = 0;
  const inspect = world.inspect.bind(world);
  world.inspect = () => {
    inspections++;
    return inspect();
  };
  const query = new SurfaceQuery(world, { minY: 0, maxY: 12, scanLimit: 13, airStopsTerrain: false });
  assert.equal(query.terrain(0, 0), 4);
  assert.equal(inspections, 0);
  world.set(0, 6, 0, stone);
  assert.equal(query.terrain(0, 0), 6);
  assert.equal(inspections, 0);
});

test('bad pier and floating custom-light callbacks are refused before any world write', () => {
  for (const materials of [
    { ...walkway().materials, pier: () => AIR },
    {
      ...walkway().materials,
      light: (sink: Parameters<NonNullable<WalkwaySpec['materials']['light']>>[0], [x, y, z]: Vec3) =>
        sink.put(x + 3, y + 4, z, 'lantern', { hanging: false }),
    },
  ]) {
    const world = ground(),
      revision = world.revision,
      plan = planWalkway(world, { ...walkway(), materials });
    assert.equal(plan.construction.feasible, false);
    assert.throws(() => buildWalkway(world, plan));
    assert.equal(world.revision, revision);
  }
});

test('canal clearing follows crossing road heights and refuses water touching the underside', () => {
  const fixture = (roadY: number, waterY: number) => {
    const world = ground();
    const road = planRoad({
      waypoints: [
        [-6, roadY, 6],
        [6, roadY, 6],
      ],
      profile: { object: 'crossing', width: 3, strategy: 'stairs', maxStepUp: 1, maxStepDown: 1 },
    });
    for (const c of road.cells)
      for (let y = c.y - 2; y <= c.y; y++) world.set(c.x, y, c.z, minecraftBlock('spruce_planks'));
    const water = planWaterSystem({
      id: 'crossed-channel',
      source: [0, waterY, 0],
      outlet: [0, waterY, 12],
      segments: [
        {
          id: 'channel',
          kind: 'reach',
          path: Array.from({ length: 13 }, (_, z) => [0, waterY, z] as Vec3),
          halfWidth: 1,
          depth: 3,
        },
      ],
    });
    const plan = planFinishedCanal(
      world,
      {
        water,
        crossings: [{ road, deckThickness: 3 }],
        clearTo: () => 30,
        materials: { water: () => minecraftBlock('water'), bed: () => stone, bank: () => stone },
      },
      { excavationAuthorized: true },
    );
    return { world, plan };
  };
  const low = fixture(12, 8),
    high = fixture(15, 11);
  for (const { world, plan } of [low, high]) {
    assert.equal(plan.construction.feasible, true, JSON.stringify(plan.construction.diagnostics));
    buildFinishedCanal(world, plan);
    assert.deepEqual(
      checkFinishedCanal(world, plan).filter((d) => d.severity !== 'info'),
      [],
    );
  }
  assert.deepEqual(
    high.plan.crossings,
    low.plan.crossings.map((c) => ({
      ...c,
      deck: [c.deck[0], c.deck[1] + 3, c.deck[2]],
      underside: c.underside + 3,
      waterY: c.waterY + 3,
    })),
  );
  const invalid = fixture(12, 11),
    revision = invalid.world.revision;
  assert.ok(invalid.plan.construction.diagnostics.some((d) => d.rule === 'canal.crossing-clearance'));
  assert.throws(() => buildFinishedCanal(invalid.world, invalid.plan));
  assert.equal(invalid.world.revision, revision);
  low.world.set(0, 12, 6, AIR);
  low.world.set(0, 9, 7, stone);
  const findings = checkFinishedCanal(low.world, low.plan);
  assert.ok(findings.some((d) => d.rule === 'canal.crossing-deck' && d.target.position?.join(',') === '0,12,6'));
  assert.ok(findings.some((d) => d.rule === 'canal.crossing-clearance' && d.target.position?.join(',') === '0,9,7'));
});
