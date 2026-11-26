import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure } from '../../src/core/structure.js';
import { minecraftBlock as b } from '../../src/blocks/registry.js';
import { planRoadProfile, buildRoadProfile, checkRoadProfile } from '../../src/authoring/index.js';

/**
 * 道路纵断面在**转角**处的行为。
 *
 * 路段的横向断面垂直于自身切线，所以直角转弯时「前一段的最后一条断面」与
 * 「后一段的第一条断面」会在转角格上重叠。这些格子只能有一个路面标高，
 * 因此纵断面必须在转角处保持同高——否则会报 `road.crossing-conflict`，
 * 看起来像路线画错了，实际上只是求解器没有把转角当作约束。
 */

/** 一个从南向北逐格升高的石质地面，用来造出真实的削填需求。 */
function slopedGround(size = 40, base = 8): Structure {
  const world = new Structure();
  const stone = b('stone');
  for (let x = 0; x < size; x++)
    for (let z = 0; z < size; z++) {
      const top = base + Math.round(z / 3);
      for (let y = 0; y <= top; y++) world.set(x, y, z, stone);
    }
  return world;
}

/** 直角转弯：先向东，再向北。 */
const ROUTE = [
  [8, 14, 12],
  [22, 14, 12],
  [22, 14, 30],
] as const;

function profile(world: Structure, width: number) {
  return planRoadProfile(world, {
    id: 'elbow',
    waypoints: ROUTE.map((p) => [...p] as [number, number, number]),
    width,
    minY: 8,
    maxY: 20,
    maxCut: 24,
    maxFill: 12,
    earthworkBudget: 20000,
    bridge: { maxSpan: 15, waterClearance: 2 },
  });
}

test('a right-angle corridor plans without a crossing conflict', () => {
  const world = slopedGround();
  const road = profile(world, 3);
  assert.equal(road.feasible, true, JSON.stringify(road.diagnostics.slice(0, 4)));
  assert.equal(
    road.diagnostics.filter((d) => d.rule === 'road.crossing-conflict').length,
    0,
    'a bend must not report a height conflict',
  );
});

test('every corridor width survives the same bend', () => {
  const world = slopedGround();
  // 偶数宽度曾经失败：断面每侧覆盖的步数与宽度不是线性关系。
  for (const width of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const road = profile(world, width);
    const conflicts = road.diagnostics.filter((d) => d.rule === 'road.crossing-conflict').length;
    assert.equal(conflicts, 0, `width ${width} reported ${conflicts} crossing conflicts`);
    assert.equal(road.feasible, true, `width ${width} was infeasible`);
  }
});

test('the corner holds one height instead of stepping through the bend', () => {
  const world = slopedGround();
  const road = profile(world, 3);
  const cells = new Map(road.cells.map((c) => [`${c.x},${c.z}`, c]));

  // 转角格本身被两条断面共同覆盖；随便取转角周围一圈，都必须是同一个标高。
  const corner = cells.get('22,12');
  assert.ok(corner, 'the corner cell must be paved');
  for (const [dx, dz] of [
    [0, 0],
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const) {
    const neighbour = cells.get(`${22 + dx},${12 + dz}`);
    if (neighbour) assert.equal(neighbour.y, corner.y, `cell ${22 + dx},${12 + dz} disagrees with the bend height`);
  }
});

test('the planned surface stays continuous across the whole corner', () => {
  const world = slopedGround();
  const road = profile(world, 5);
  const cells = new Map(road.cells.map((c) => [`${c.x},${c.z}`, c]));
  let jumps = 0;
  for (const c of road.cells)
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const other = cells.get(`${c.x + dx},${c.z + dz}`);
      if (other && Math.abs(other.y - c.y) > 1) jumps++;
    }
  assert.equal(jumps, 0, 'adjacent road cells must not differ by more than one block');
});

test('the corner constraint still produces a passable, buildable road', () => {
  const world = slopedGround();
  const road = profile(world, 3);
  const result = buildRoadProfile(world, road, {
    surface: () => b('stone_bricks'),
    support: () => b('stone'),
    stairs: (_cell, direction) => b('stone_brick_stairs', { weirdo_direction: direction, upside_down_bit: false }),
  });
  assert.equal(result.committed, true, 'the corner plan must still commit');
  // 复核用的是实际碰撞几何：转角同高不能变成"铺了却走不过去"。
  const findings = checkRoadProfile(world, road).filter((d) => d.severity === 'error');
  assert.deepEqual(findings.map((d) => d.rule), []);
});
