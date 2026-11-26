import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure, type Vec3 } from '../../src/core/structure.js';
import { minecraftBlock as b } from '../../src/blocks/registry.js';
import {
  StructureKit,
  gableRoof,
  profileHipRoof,
  roofSurface,
  alternatingGableRecipe,
  planRailing,
  railing,
  rectanglePath,
  scatterPlants,
  tree,
  voxelPath,
  leafCluster,
} from '../../src/authoring/index.js';

test('kit wraps an existing structure and retains explicit material states', () => {
  const world = new Structure(),
    kit = new StructureKit({}, world);
  const top = b('stone_brick_slab', { 'minecraft:vertical_half': 'top' });
  kit.fill(-1, 0, -1, 1, 0, 1, top);
  assert.equal(world.inspect().occupied, 9);
  assert.equal(world.get(1, 0, 1)?.states['minecraft:vertical_half'], 'top');
  assert.equal(world.get(2, 0, 1), null);
  kit.slab(0, 1, 0, top, false);
  assert.equal(world.get(0, 1, 0)?.states['minecraft:vertical_half'], 'bottom');
});

test('roof shell leaves attic open, supplies stable attachment queries and accepts asymmetry', () => {
  const kit = new StructureKit();
  const plan = gableRoof(
    kit,
    {
      x0: 0,
      x1: 8,
      z0: 0,
      z1: 6,
      eaveY: 4,
      profile: (d) => d,
      thickness: 2,
      offsetAt: (x, z) => (x === 0 && z === 0 ? 1 : 0),
    },
    { tile: 'stone' },
  );
  assert.equal(plan.heightAt(4, 3), 7);
  assert.equal(plan.heightAt(-1, 3), null);
  assert.equal(plan.heightAt(0, 0), 5);
  assert.equal(kit.get(4, 5, 3), null);
  assert.equal(kit.get(4, 6, 3)?.name, 'minecraft:stone');
  assert.ok(plan.ridges.some((c) => c.position.join(',') === '4,7,3'));
  assert.equal(plan.eaves.length, 28);
  assert.deepEqual(plan.bounds, { min: [0, 3, 0], max: [9, 8, 7] });
});

test('roof families accept alternate axes and arbitrary polygon footprints', () => {
  const kit = new StructureKit();
  const hip = profileHipRoof(kit, { x0: 0, x1: 6, z0: 0, z1: 6, eaveY: 0, profile: [0, 1, 2, 3] }, { tile: 'stone' });
  assert.equal(hip.heightAt(3, 3), 3);
  assert.equal(hip.heightAt(0, 3), 0);
  const gable = gableRoof(
    new StructureKit(),
    { x0: 0, x1: 6, z0: 0, z1: 8, ridgeAxis: 'z', eaveY: 0, profile: (d) => d },
    { tile: 'stone' },
  );
  assert.equal(gable.heightAt(3, 0), 3);
  assert.equal(gable.heightAt(0, 4), 0);
  const hex = roofSurface(
    new StructureKit(),
    {
      x0: -3,
      x1: 3,
      z0: -3,
      z1: 3,
      heightAt: (x, z) => {
        const n = Math.max(Math.abs(x), Math.abs(z), Math.abs(x + z));
        return n > 3 ? null : 3 - n;
      },
    },
    { tile: 'stone' },
  );
  assert.equal(hex.heightAt(3, 3), null);
  assert.equal(hex.cells.length, 37);
  assert.throws(() => gableRoof(kit, { x0: 0, x1: 2, z0: 0, z1: 2, eaveY: 0, profile: [] }, { tile: 'stone' }));
  assert.throws(() => roofSurface(kit, { x0: 0, x1: 1, z0: 0, z1: 1, heightAt: () => NaN }, { tile: 'stone' }));
});

test('roof decorations run after every surface cell', () => {
  const kit = new StructureKit();
  roofSurface(
    kit,
    { x0: 0, x1: 2, z0: 0, z1: 0, heightAt: () => 0 },
    {
      tile: 'stone',
      decorate: (target, cell) => {
        if (cell.position[0] === 0) target.put(1, 0, 0, 'gold_block');
      },
    },
  );
  assert.equal(kit.get(1, 0, 0)?.name, 'minecraft:gold_block');
});

test('alternating gable recipe exposes ridge and corner closure controls', () => {
  const kit = new StructureKit();
  roofSurface(
    kit,
    { x0: 0, x1: 2, z0: 0, z1: 2, heightAt: () => 0 },
    alternatingGableRecipe({
      x0: 0,
      x1: 2,
      z0: 0,
      z1: 2,
      ridgeAxis: 'x',
      tile: 'stone',
      stairs: 'deepslate_tile_stairs',
      slab: 'deepslate_tile_slab',
      ridgeCap: false,
      cornerClosure: false,
    }),
  );
  assert.equal(kit.get(1, 1, 1), null);
  assert.equal(kit.get(0, 1, 0), null);
});

test('railing visits closed corners once, keeps spacing through gaps, supports sloped paths', () => {
  const cells = planRailing({
    path: rectanglePath({ x0: 0, x1: 4, z0: 0, z1: 4 }, 2),
    closed: true,
    postEvery: 3,
    gaps: [[2, 3]],
  });
  assert.equal(cells.length, 14);
  assert.equal(new Set(cells.map((c) => c.position.join(','))).size, cells.length);
  assert.equal(cells.find((c) => c.distance === 6)?.post, true);
  assert.equal(cells.filter((c) => c.corner).length, 4);
  const kit = new StructureKit();
  const slope = railing(
    kit,
    {
      path: [
        [0, 0, 0],
        [4, 2, 0],
      ],
      postEvery: 2,
    },
    { post: 'stone', panel: 'oak_fence', cap: b('stone_brick_slab', { 'minecraft:vertical_half': 'top' }) },
  );
  assert.deepEqual(slope.at(-1)?.position, [4, 2, 0]);
  assert.equal(kit.get(4, 3, 0)?.states['minecraft:vertical_half'], 'top');
  assert.throws(() =>
    planRailing({
      path: [
        [0, 0, 0],
        [2, 0, 2],
      ],
    }),
  );
});

test('railing does not promote straight-through control points to corners', () => {
  const straight = planRailing({
    path: [
      [0, 0, 0],
      [2, 0, 0],
      [4, 0, 0],
    ],
    postEvery: 10,
  });
  assert.equal(straight.filter((cell) => cell.corner).length, 0);
  assert.deepEqual(
    straight.filter((cell) => cell.post).map((cell) => cell.position),
    [
      [0, 0, 0],
      [4, 0, 0],
    ],
  );
  const turn = planRailing({
    path: [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
    ],
    postEvery: 10,
  });
  assert.equal(turn.filter((cell) => cell.corner).length, 1);
  assert.equal(turn.find((cell) => cell.position.join(',') === '2,0,0')?.post, true);
});

test('plant scatter obeys terrain, masks, weights, headroom, spacing and seed', () => {
  const make = () => {
    const kit = new StructureKit();
    for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) kit.put(x, x < 0 ? 1 : 2, z, 'grass_block');
    kit.put(0, 4, 0, 'stone');
    return kit;
  };
  const a = make(),
    c = make();
  const spec = {
    x0: -10,
    x1: 10,
    z0: -10,
    z1: 10,
    surfaceY: (x: number) => (x < 0 ? 1 : 2),
    plants: [
      { weight: 1, blocks: ['poppy'] },
      { weight: 1, blocks: ['fern'] },
    ],
    seed: 12,
    coverage: 1,
    minSpacing: 2,
    where: (x: number) => x !== 0,
  };
  const points = scatterPlants(a, spec).placed;
  assert.deepEqual(points, scatterPlants(c, spec).placed);
  assert.ok(points.length > 20);
  for (const [i, p] of points.entries()) {
    assert.notEqual(p[0], 0);
    assert.equal(p[1], p[0] < 0 ? 2 : 3);
    for (const q of points.slice(i + 1)) assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) >= 2);
  }
  assert.ok(Object.keys(a.s.inspect().materials).some((n) => n.includes('poppy')));
  assert.ok(Object.keys(a.s.inspect().materials).some((n) => n.includes('fern')));
  assert.notDeepEqual(points, scatterPlants(make(), { ...spec, seed: 13 }).placed);
  const blocked = make();
  const blockedReport = scatterPlants(blocked, {
    x0: 0,
    x1: 0,
    z0: 0,
    z1: 0,
    surfaceY: 2,
    coverage: 1,
    plants: [
      { weight: 1, blocks: [b('sunflower', { upper_block_bit: false }), b('sunflower', { upper_block_bit: true })] },
    ],
  });
  assert.deepEqual(blockedReport.placed, []);
  assert.deepEqual(blockedReport.skipped, { noSoil: 0, noHeadroom: 1 });
  assert.equal(blocked.get(0, 3, 0), null);
  assert.throws(() => scatterPlants(a, { ...spec, coverage: 2 }));
  assert.throws(() => scatterPlants(a, { ...spec, plants: [] }));
});

test('tree branches stay face-connected and crowns preserve wood; collisions are explicit', () => {
  const path: Vec3[] = [
    [0, 0, 0],
    [3, 5, -2],
  ];
  const cells = voxelPath(path);
  for (let i = 1; i < cells.length; i++)
    assert.equal(
      cells[i].reduce((d, v, a) => d + Math.abs(v - cells[i - 1][a]), 0),
      1,
    );
  const kit = new StructureKit();
  const spec = {
    branches: [{ path, material: 'oak_log' }],
    crowns: [{ center: [3, 5, -2] as Vec3, radii: [3, 2, 3] as Vec3, material: 'oak_leaves' }],
    origin: [10, 0, 0] as Vec3,
  };
  tree(kit, spec);
  for (const [x, y, z] of cells) assert.equal(kit.get(x + 10, y, z)?.name, 'minecraft:oak_log');
  const before = kit.s.revision;
  assert.throws(() => tree(kit, { ...spec, collision: 'error' }));
  assert.equal(kit.s.revision, before);
  const occupied = kit.s.inspect().occupied;
  assert.ok(tree(kit, spec).conflicts.length > 0);
  assert.equal(kit.s.inspect().occupied, occupied);
  const disc = new StructureKit(),
    cone = new StructureKit();
  leafCluster(disc, { center: [0, 0, 0], radii: [4, 1, 4], material: 'oak_leaves', shape: 'disc' });
  leafCluster(cone, { center: [0, 0, 0], radii: [4, 4, 4], material: 'spruce_leaves', shape: 'cone' });
  assert.equal(cone.get(0, 4, 0)?.name, 'minecraft:spruce_leaves');
  assert.equal(cone.get(1, 4, 0), null);
  assert.equal(disc.get(4, 1, 0)?.name, 'minecraft:oak_leaves');
});

test('fractional leaf radii sample only symmetric integer cells', () => {
  const kit = new StructureKit();
  leafCluster(kit, { center: [0, 0, 0], radii: [0.1, 0.1, 0.1], material: 'oak_leaves', sample: () => true });
  assert.equal(kit.s.inspect().occupied, 1);
  assert.equal(kit.get(0, 0, 0)?.name, 'minecraft:oak_leaves');
});
