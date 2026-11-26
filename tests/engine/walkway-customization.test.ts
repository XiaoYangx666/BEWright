import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure, AIR } from '../../src/core/structure.js';
import { minecraftBlock as b } from '../../src/blocks/registry.js';
import { applyBedrockWallConnections } from '../../src/blocks/connections.js';
import { planWalkway, buildWalkway, checkWalkway, type WalkwaySpec } from '../../src/authoring/walkway.js';
import { customSpec } from '../fixtures/custom-walkway.js';

function ground() {
  const world = new Structure();
  world.fill({ min: [-5, 4, -8], max: [28, 5, 8] }, b('stone'));
  return world;
}
test('custom deck, slab beams, offset supports, panel railing and attached details share resolved heights', () => {
  for (const height of [12, 15]) {
    const world = ground(),
      revision = world.revision,
      plan = planWalkway(world, customSpec(height));
    assert.equal(world.revision, revision);
    assert.equal(plan.construction.feasible, true, JSON.stringify(plan.construction.diagnostics));
    buildWalkway(world, plan);
    assert.deepEqual(
      checkWalkway(world, plan).filter((d) => d.severity !== 'info'),
      [],
    );
    const support = plan.components.find((c) => c.kind === 'support')!;
    assert.equal(support.contacts[0]![1], height);
    assert.equal(support.anchors[0]![1], 4);
    assert.equal(support.anchors[0]![0], support.contacts[0]![0] + 2);
    const beam = plan.components.find((c) => c.kind === 'beams')!.cells[0]!;
    world.set(...beam.position, b('stone_brick_slab', { 'minecraft:vertical_half': 'bottom' }));
    assert.ok(
      checkWalkway(world, plan).some(
        (d) => d.rule === 'walkway.component-missing' && d.target.position?.join(',') === beam.position.join(','),
      ),
    );
  }
});
test('cutting a custom support elbow or its real offset foot is located on the final model', () => {
  for (const removeFoot of [false, true]) {
    const world = ground(),
      plan = planWalkway(world, customSpec());
    buildWalkway(world, plan);
    const support = plan.components.find((c) => c.kind === 'support')!;
    const p = removeFoot ? support.anchors[0]! : support.cells.find((c) => c.position[1] === 7)!.position;
    world.set(...p, AIR);
    const diagnostics = checkWalkway(world, plan);
    assert.ok(
      diagnostics.some(
        (d) =>
          ['walkway.component-missing', 'walkway.support-gap'].includes(d.rule) &&
          d.target.position?.join(',') === p.join(','),
      ),
    );
    assert.ok(diagnostics.some((d) => d.rule === 'walkway.component-disconnected'));
  }
});
test('custom callbacks run once at planning and are not replayed during commit or final checks', () => {
  const world = ground(),
    spec = customSpec();
  let calls = 0;
  const plan = planWalkway(world, {
    ...spec,
    builders: {
      ...spec.builders,
      deck: (sink, context) => {
        calls++;
        spec.builders!.deck!(sink, context);
      },
    },
  });
  assert.equal(calls, 1);
  buildWalkway(world, plan);
  checkWalkway(world, plan);
  assert.equal(calls, 1);
});
test('missing railing, floating details and invented footings refuse atomic construction', () => {
  const spec = customSpec();
  const variants: WalkwaySpec['builders'][] = [
    { ...spec.builders, railing: () => {} },
    {
      ...spec.builders,
      details: (sink) => {
        sink.put(0, 23, -6, 'stone');
        sink.put(0, 24, -6, 'stone');
      },
    },
    {
      ...spec.builders,
      support: (sink, site) => {
        sink.put(site.x, 6, site.z, 'stone');
        return { footings: [[site.x, 6, site.z]] };
      },
    },
    {
      ...spec.builders,
      beams: () => {
        throw new Error('bad beam geometry');
      },
    },
  ];
  for (const builders of variants) {
    const world = ground(),
      revision = world.revision,
      plan = planWalkway(world, { ...spec, builders });
    assert.equal(plan.construction.feasible, false);
    assert.throws(() => buildWalkway(world, plan));
    assert.equal(world.revision, revision);
  }
});
test('custom geometry cannot fill an entrance or the road headroom', () => {
  const spec = customSpec();
  for (const p of [
    [0, 13, 0],
    [5, 13, -5],
  ] as const) {
    const world = ground(),
      revision = world.revision;
    const plan = planWalkway(world, {
      ...spec,
      openings: [{ min: [5, 12, -5], max: [6, 16, -4] }],
      builders: {
        ...spec.builders,
        details: (sink, context) => {
          spec.builders!.details!(sink, context);
          sink.put(p[0], p[1], p[2], 'stone');
        },
      },
    });
    assert.equal(plan.construction.feasible, false);
    assert.throws(() => buildWalkway(world, plan));
    assert.equal(world.revision, revision);
  }
});
test('custom support can use an offset real footing when there is no ground directly below the beam', () => {
  const world = ground();
  // Front support sites have x=-1 or x=0. Their shifted roots remain intact.
  world.set(-1, 4, -2, AIR);
  const plan = planWalkway(world, customSpec());
  assert.equal(plan.construction.feasible, true, JSON.stringify(plan.construction.diagnostics));
  buildWalkway(world, plan);
  assert.deepEqual(
    checkWalkway(world, plan).filter((d) => d.severity !== 'info'),
    [],
  );
});

test('unknown custom collision stays undecidable and a declared empty lamp is refused', () => {
  const world = ground(),
    spec = customSpec(),
    revision = world.revision;
  const unknown = planWalkway(world, {
    ...spec,
    builders: {
      ...spec.builders,
      railing: (sink, context) => {
        for (const c of context.railSites) sink.put(...c.position, 'iron_bars');
      },
    },
  });
  assert.equal(unknown.construction.feasible, false);
  assert.ok(unknown.construction.diagnostics.some((d) => d.severity === 'unknown' && d.conclusive === false));
  assert.throws(() => buildWalkway(world, unknown));
  assert.equal(world.revision, revision);
  const empty = planWalkway(world, { ...spec, lights: { spacing: 10 }, materials: { light: () => {} } });
  assert.equal(empty.construction.feasible, false);
  assert.ok(
    empty.construction.diagnostics.some(
      (d) => d.rule === 'walkway.component-missing' && d.object.id.includes('/light-'),
    ),
  );
  assert.throws(() => buildWalkway(world, empty));
  assert.equal(world.revision, revision);
});

test('unknown replacement at an actual offset footing stays unknown in the final check', () => {
  const world = ground(),
    plan = planWalkway(world, customSpec());
  buildWalkway(world, plan);
  const foot = plan.components.find((c) => c.kind === 'support')!.anchors[0]!;
  world.set(...foot, { name: 'minecraft:unknown_footing', states: {} });
  const finding = checkWalkway(world, plan).find(
    (d) => d.rule === 'walkway.support-gap' && d.target.position?.join(',') === foot.join(','),
  );
  assert.equal(finding?.severity, 'unknown');
  assert.equal(finding?.conclusive, false);
});

test('legitimate derived wall connections pass while an unrelated stored-state change is located', () => {
  const world = ground(),
    plan = planWalkway(world, customSpec());
  buildWalkway(world, plan);
  assert.ok(applyBedrockWallConnections(world, world.inspect().bounds!) > 0);
  assert.deepEqual(
    checkWalkway(world, plan).filter((d) => d.severity !== 'info'),
    [],
  );
  const wall = plan.rails.find((c) => c.state.name === 'minecraft:stone_brick_wall')!;
  world.set(...wall.position, {
    ...world.get(...wall.position)!,
    states: { ...world.get(...wall.position)!.states, wall_connection_type_north: 'tall' },
  });
  assert.ok(
    checkWalkway(world, plan).some(
      (d) => d.rule === 'walkway.component-missing' && d.target.position?.join(',') === wall.position.join(','),
    ),
  );
});
