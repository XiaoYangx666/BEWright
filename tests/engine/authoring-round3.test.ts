import test from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '../../src/core/structure.js';
import {
  StructureKit,
  gableRoof,
  profileHipRoof,
  roofSurface,
  alternatingGableRecipe,
  alternatingGable,
  ridgeLines,
  eaveLines,
  floatingRoofTiles,
  tree,
  treePreset,
  scatterPlants,
} from '../../src/authoring/index.js';

const cellMap = (kit: StructureKit) => {
  const entries: string[] = [];
  kit.s.forEach((x, y, z, id) => {
    const state = kit.s.palette[id]!;
    entries.push(`${x},${y},${z} ${state.name} ${JSON.stringify(state.states)}`);
  });
  return entries.sort();
};

const positions = (line: { cells: readonly { position: Vec3 }[] }) => line.cells.map((c) => c.position);

test('ridgeLines returns one straight ridge for a gable roof', () => {
  const plan = gableRoof(
    new StructureKit(),
    { x0: 0, x1: 8, z0: 0, z1: 6, eaveY: 4, profile: (d) => d },
    { tile: 'stone' },
  );
  const lines = ridgeLines(plan);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0]!.step, [1, 0]);
  assert.deepEqual(
    positions(lines[0]!),
    Array.from({ length: 9 }, (_, x) => [x, 7, 3] as Vec3),
  );
});

test('ridgeLines splits an even hip roof into a central ridge and four hip lines', () => {
  const plan = profileHipRoof(
    new StructureKit(),
    { x0: 0, x1: 8, z0: 0, z1: 6, eaveY: 0, profile: [0, 1, 2, 3] },
    { tile: 'stone' },
  );
  const lines = ridgeLines(plan);
  assert.equal(lines.length, 5);
  const shapes = lines
    .map((line) =>
      positions(line)
        .map(([x, , z]) => `${x},${z}`)
        .join(' '),
    )
    .sort();
  assert.deepEqual(shapes, ['1,1 2,2 3,3', '1,5 2,4 3,3', '3,3 4,3 5,3', '5,3 6,2 7,1', '5,3 6,4 7,5']);
  const central = lines.find(
    (line) => line.cells.length === 3 && line.cells[0]!.position[2] === 3 && line.step[0] === 1,
  );
  assert.ok(central, 'central ridge line expected');
  assert.deepEqual(central.step, [1, 0]);
  // Every ridge cell is covered by at least one line.
  const covered = new Set(lines.flatMap((line) => line.cells.map((c) => c.position.join(','))));
  for (const cell of plan.ridges) assert.ok(covered.has(cell.position.join(',')));
});

test('ridgeLines keeps crossing hips whole through a pointed apex', () => {
  const plan = profileHipRoof(
    new StructureKit(),
    { x0: 0, x1: 6, z0: 0, z1: 6, eaveY: 0, profile: [0, 1, 2, 3] },
    { tile: 'stone' },
  );
  const lines = ridgeLines(plan);
  assert.equal(lines.length, 2);
  const shapes = lines
    .map((line) =>
      positions(line)
        .map(([x, , z]) => `${x},${z}`)
        .join(' '),
    )
    .sort();
  assert.deepEqual(shapes, ['1,1 2,2 3,3 4,4 5,5', '1,5 2,4 3,3 4,2 5,1']);
});

test('ridgeLines follows an offset ridge created by offsetAt', () => {
  const plan = gableRoof(
    new StructureKit(),
    { x0: 0, x1: 4, z0: 0, z1: 6, eaveY: 0, profile: (d) => d, offsetAt: (_x, z) => (z < 3 ? 2 : 0) },
    { tile: 'stone' },
  );
  const lines = ridgeLines(plan);
  assert.equal(lines.length, 1);
  assert.deepEqual(
    positions(lines[0]!),
    Array.from({ length: 5 }, (_, x) => [x, 4, 2] as Vec3),
  );
});

test('eaveLines walks a rectangular eave as one closed loop', () => {
  const plan = gableRoof(
    new StructureKit(),
    { x0: 0, x1: 4, z0: 0, z1: 4, eaveY: 0, profile: (d) => d },
    { tile: 'stone' },
  );
  const lines = eaveLines(plan);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.cells.length, plan.eaves.length);
  assert.deepEqual(lines[0]!.cells[0]!.position, [0, 0, 0]);
  // Closed loop: consecutive cells are adjacent, and the walk returns next to the start.
  const cells = lines[0]!.cells;
  for (let i = 1; i < cells.length; i++) {
    const [a, b] = [cells[i - 1]!.position, cells[i]!.position];
    assert.equal(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[2] - b[2])), 1);
  }
  const [first, last] = [cells[0]!.position, cells.at(-1)!.position];
  assert.equal(Math.max(Math.abs(first[0] - last[0]), Math.abs(first[2] - last[2])), 1);
  assert.deepEqual(lines[0]!.step, [0, 1]);
});

test('eaveLines partitions notched footprints including the inner notch boundary', () => {
  const plan = roofSurface(
    new StructureKit(),
    {
      x0: 0,
      x1: 4,
      z0: 0,
      z1: 4,
      heightAt: (x, z) => (x > 2 && z > 2 ? null : 2),
    },
    { tile: 'stone' },
  );
  const lines = eaveLines(plan);
  const seen = new Set<string>();
  for (const line of lines)
    for (const cell of line.cells) {
      const key = cell.position.join(',');
      assert.ok(!seen.has(key), `eave cell visited twice: ${key}`);
      seen.add(key);
    }
  assert.equal(seen.size, plan.eaves.length);
  assert.equal(lines.length, 1, 'notched boundary stays one connected walk');
});

test('half-grid gable reproduces the alternating cladding and matches the integer path', () => {
  const recipe = (halfGrid: boolean) =>
    alternatingGableRecipe({
      x0: 0,
      x1: 6,
      z0: 0,
      z1: 8,
      ridgeAxis: 'x',
      tile: 'deepslate_tiles',
      stairs: 'deepslate_tile_stairs',
      slab: 'deepslate_tile_slab',
      halfGrid,
    });
  const spec = { x0: 0, x1: 6, z0: 0, z1: 8, eaveY: 4, solidFromY: 4, ridgeAxis: 'x' as const };
  const int = new StructureKit();
  const intPlan = gableRoof(int, { ...spec, profile: (d) => Math.floor(d / 2) }, recipe(false));
  const half = new StructureKit();
  const halfPlan = gableRoof(half, { ...spec, halfGrid: true, profile: (d) => d * 0.5 }, recipe(true));
  assert.deepEqual(cellMap(half), cellMap(int));
  // Half cells carry the quantized fraction: t even -> 0 (slab), t odd -> 0.5 (stair).
  assert.equal(halfPlan.heightAt(3, 0), 4);
  assert.equal(halfPlan.cells.find((c) => c.position[0] === 3 && c.position[2] === 1)!.half, 0.5);
  assert.equal(halfPlan.cells.find((c) => c.position[0] === 3 && c.position[2] === 2)!.half, 0);
  assert.equal(int.get(3, 4, 0)?.name, 'minecraft:deepslate_tile_slab');
  assert.equal(int.get(3, 4, 1)?.states.weirdo_direction, 2);
  assert.equal(int.get(3, 5, 2)?.name, 'minecraft:deepslate_tile_slab');
  assert.equal(int.get(3, 5, 3)?.states.weirdo_direction, 2);
  assert.equal(int.get(3, 6, 4)?.name, 'minecraft:deepslate_tiles');
  assert.equal(int.get(3, 7, 4)?.name, 'minecraft:deepslate_tile_slab', 'ridge cap');
  assert.equal(int.get(0, 4, 0)?.name, 'minecraft:deepslate_tiles', 'corner closure');
  assert.equal(int.get(0, 5, 0)?.name, 'minecraft:deepslate_tile_slab');
});

test('alternatingGable is exactly gableRoof composed with the recipe', () => {
  const pair = new StructureKit(),
    one = new StructureKit();
  const spec = {
    x0: 0,
    x1: 6,
    z0: 0,
    z1: 8,
    eaveY: 4,
    solidFromY: 4,
    ridgeAxis: 'z' as const,
    profile: (d: number) => Math.floor(d / 2),
    tile: 'deepslate_tiles',
    stairs: 'deepslate_tile_stairs',
    slab: 'deepslate_tile_slab',
  };
  gableRoof(pair, spec, alternatingGableRecipe(spec));
  alternatingGable(one, spec);
  assert.deepEqual(cellMap(one), cellMap(pair));
  // The half-grid switch reaches both halves of the composition.
  const halfPair = new StructureKit(),
    halfOne = new StructureKit();
  gableRoof(
    halfPair,
    { ...spec, halfGrid: true, profile: (d: number) => d * 0.5 },
    alternatingGableRecipe({ ...spec, halfGrid: true }),
  );
  alternatingGable(halfOne, { ...spec, halfGrid: true, profile: (d: number) => d * 0.5 });
  assert.deepEqual(cellMap(halfOne), cellMap(halfPair));
});

test('floatingRoofTiles reports isolated tiles but not connected shells', () => {
  const kit = new StructureKit();
  const plan = roofSurface(kit, { x0: 0, x1: 1, z0: 0, z1: 0, heightAt: () => 3 }, { tile: 'stone' });
  assert.deepEqual(floatingRoofTiles(kit, plan), []);
  kit.air(1, 3, 0);
  assert.deepEqual(floatingRoofTiles(kit, plan), [[0, 3, 0]]);
  kit.fill(-1, 2, 0, 1, 2, 0, 'stone');
  assert.deepEqual(floatingRoofTiles(kit, plan), []);
});

test('tree reports floating crowns; presets stay attached', () => {
  const kit = new StructureKit();
  const detached = tree(kit, {
    branches: [
      {
        path: [
          [0, 0, 0],
          [0, 3, 0],
        ] as Vec3[],
        material: 'oak_log',
      },
    ],
    crowns: [{ center: [6, 3, 0] as Vec3, radii: [2, 1, 2] as Vec3, material: 'oak_leaves' }],
    collision: 'replace',
  });
  assert.ok(detached.floating.length > 0);
  const pine = treePreset(new StructureKit(), {
    kind: 'pine',
    origin: [0, 0, 0],
    height: 7,
    trunk: 'spruce_log',
    leaf: 'spruce_leaves',
  });
  assert.deepEqual(pine.floating, []);
  const broadleaf = treePreset(new StructureKit(), {
    kind: 'broadleaf',
    origin: [0, 0, 0],
    height: 5,
    trunk: 'oak_log',
    leaf: 'oak_leaves',
  });
  assert.deepEqual(broadleaf.floating, []);
});

test('scatter fast path equals the ranked path and reports skipped reasons', () => {
  for (const seed of [1, 7, 99]) {
    const make = () => {
      const kit = new StructureKit();
      kit.fill(0, 0, 0, 19, 0, 19, 'grass_block');
      return kit;
    };
    const spec = {
      x0: 0,
      x1: 19,
      z0: 0,
      z1: 19,
      surfaceY: 0 as const,
      coverage: 0.4,
      seed,
      plants: [
        { weight: 2, blocks: ['poppy'] },
        { weight: 1, blocks: ['fern'] },
      ],
    };
    const fast = scatterPlants(make(), spec);
    const slow = scatterPlants(make(), { ...spec, minSpacing: 1e-9 });
    const sorted = (report: { placed: Vec3[] }) => report.placed.map((p) => p.join(',')).sort();
    assert.deepEqual(sorted(fast), sorted(slow));
    assert.deepEqual(fast.skipped, slow.skipped);
  }
  const stone = new StructureKit();
  stone.put(0, 0, 0, 'stone');
  const report = scatterPlants(stone, {
    x0: 0,
    x1: 0,
    z0: 0,
    z1: 0,
    surfaceY: 0,
    coverage: 1,
    plants: [{ weight: 1, blocks: ['poppy'] }],
  });
  assert.deepEqual(report.placed, []);
  assert.deepEqual(report.skipped, { noSoil: 1, noHeadroom: 0 });
});
