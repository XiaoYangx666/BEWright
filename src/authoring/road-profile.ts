import { type Box, type Structure, type Vec3 } from '../core/structure.js';
import { SurfaceQuery } from './surface.js';
import { coordinateDiagnostic, type Diagnostic } from './diagnostics.js';
import { structureIdentity } from './model-target.js';
import { collisionBoxes } from './traversal.js';
import {
  planConstruction,
  commitConstruction,
  type ConstructionSink,
  type ConstructionRequest,
} from './construction.js';
import {
  routeCentreline,
  planRoad,
  recordRoadPaving,
  roadPassability,
  type RoadPlan,
  type RoadMaterials,
} from './roads.js';

export type RoadSection = Readonly<{
  x: number;
  z: number;
  y: number;
  step: number;
  bridge: boolean;
  columns: readonly Readonly<{ x: number; z: number; ground: number; water: number | null }>[];
}>;
export type BridgeSpan = Readonly<{
  start: number;
  end: number;
  length: number;
  deckY: number;
  abutments: readonly [number, number];
}>;
export type RoadProfileMaterials = RoadMaterials &
  Readonly<{
    /** Cantilever edge beam outside the walking width; no underwater piers. */
    bridgeEdge?: (position: Vec3, span: BridgeSpan) => import('../core/structure.js').State;
    bridgeRailing?: (position: Vec3, span: BridgeSpan) => import('../core/structure.js').State;
  }>;
export type RoadProfileSpec = Readonly<{
  id: string;
  /** X/Z define the corridor; only first and last Y are fixed pavement block heights. */
  waypoints: readonly Vec3[];
  width: number;
  minY: number;
  maxY: number;
  maxCut: number;
  maxFill: number;
  earthworkBudget: number;
  maxStep?: number;
  headroom?: number;
  /** Flat landing at each entrance/endpoint, including the endpoint itself. Default 2. */
  landingLength?: number;
  /** Omit to refuse water crossings with road.bridge-required. */
  bridge?: Readonly<{ maxSpan: number; waterClearance: number }>;
  bounds?: Box;
  where?: (x: number, z: number) => boolean;
}>;
export type ProfiledRoadPlan = RoadPlan &
  Readonly<{
    id: string;
    targetIdentity: number;
    baseRevision: number;
    sections: readonly RoadSection[];
    spans: readonly BridgeSpan[];
    headroom: number;
    constructionBounds?: Box;
    /** Original water cells preserved by the crossing, not a second voxel model. */
    waterCells: readonly Vec3[];
  }>;

export function fullSupport(world: Pick<Structure, 'get'>, x: number, y: number, z: number): boolean {
  const shape = collisionBoxes(world.get(x, y, z));
  return (
    shape.kind === 'supported' &&
    shape.boxes.some((b) => b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1 && b[4] === 1 && b[5] === 1)
  );
}

/** Finite discrete longitudinal profile. Planning never writes the target. */
export function planRoadProfile(world: Structure, spec: RoadProfileSpec): ProfiledRoadPlan {
  for (const [name, value] of Object.entries({
    width: spec.width,
    minY: spec.minY,
    maxY: spec.maxY,
    maxCut: spec.maxCut,
    maxFill: spec.maxFill,
    earthworkBudget: spec.earthworkBudget,
  }))
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  if (
    spec.width < 1 ||
    spec.minY > spec.maxY ||
    spec.maxY - spec.minY > 128 ||
    Math.min(spec.maxCut, spec.maxFill, spec.earthworkBudget) < 0
  )
    throw new Error('Invalid or unbounded road profile limits');
  if (spec.waypoints.some((p) => p.some((v) => !Number.isSafeInteger(v))))
    throw new Error('Road waypoints must be integer cells');
  const maxStep = spec.maxStep ?? 1;
  const headroom = spec.headroom ?? 2;
  const landingLength = spec.landingLength ?? 2;
  if (!Number.isSafeInteger(landingLength) || landingLength < 1) throw new Error('landingLength must be positive');
  if (![0, 1].includes(maxStep) || !Number.isSafeInteger(headroom) || headroom < 2)
    throw new Error('Road step must be 0 or 1 and headroom >= 2');
  if (
    spec.bridge &&
    (!Number.isSafeInteger(spec.bridge.maxSpan) ||
      spec.bridge.maxSpan < 1 ||
      !Number.isSafeInteger(spec.bridge.waterClearance) ||
      spec.bridge.waterClearance < 1)
  )
    throw new Error('Bridge span and clearance must be positive integers');
  const targetIdentity = structureIdentity(world),
    baseRevision = world.revision;
  const centre = routeCentreline(spec.waypoints);
  const diagnostics: Diagnostic[] = [];
  const fail = (rule: string, position: Vec3, message: string) =>
    diagnostics.push(
      coordinateDiagnostic({ rule, position, object: { kind: 'route', id: spec.id }, message, source: 'road-profile' }),
    );
  const range = world.inspect().bounds;
  const surface = new SurfaceQuery(world, {
    minY: range?.min[1] ?? 0,
    maxY: range ? range.max[1] : spec.maxY,
    scanLimit: Math.max(48, range ? range.max[1] - range.min[1] + 2 : 48),
    airStopsTerrain: false,
  });
  // Use one cardinal tangent. Diagonal lateral offsets leave holes at elbows.
  const surveyed = centre.map((p, i) => {
    const q = centre[i + 1] ?? centre[i - 1] ?? p;
    const alongX = q.x !== p.x;
    return Array.from({ length: spec.width }, (_, j) => {
      const lateral = j - Math.floor(spec.width / 2);
      const x = p.x + (alongX ? 0 : lateral),
        z = p.z + (alongX ? lateral : 0);
      const ground = surface.terrain(x, z),
        water = surface.water(x, z);
      if (ground === null || !fullSupport(world, x, ground, z))
        fail('road.unresolved-ground', [x, spec.minY, z], '路基没有确认的实体地面');
      if (spec.where && !spec.where(x, z)) fail('road.corridor-blocked', [x, spec.minY, z], '走廊被掩码拒绝');
      return { x, z, ground: ground ?? spec.minY, water };
    });
  });
  if (!spec.bridge) {
    const wet = surveyed.flat().find((c) => c.water !== null);
    if (wet) fail('road.bridge-required', [wet.x, wet.water!, wet.z], '当前走廊跨水，需要声明桥的跨度与净空');
  }
  let wetRun = 0;
  for (const [i, columns] of surveyed.entries()) {
    wetRun = columns.some((c) => c.water !== null) ? wetRun + 1 : 0;
    if (spec.bridge && wetRun === spec.bridge.maxSpan + 1)
      fail(
        'road.bridge-span',
        [centre[i]!.x, spec.minY, centre[i]!.z],
        `跨水长度超过桥的 ${spec.bridge.maxSpan} 格跨度上限`,
      );
  }
  type Candidate = { y: number; bridge: boolean; earth: number };
  /**
   * Steps that must share one height because the corridor turns there.
   *
   * A section's footprint is perpendicular to its own tangent, so at a bend the
   * last section of one leg and the first of the next overlap: the perpendicular
   * rows/columns cross. Those shared cells can only hold one road surface, so the
   * profile must stay flat across the bend. Without this the solver happily steps
   * down through the corner and the two footprints then disagree at the shared
   * cells — reported as `road.crossing-conflict`, which reads as a routing error
   * even though the corridor itself is fine.
   *
   * Measured on a 3-wide right-angle corridor: the conflict count drops to zero
   * once the flat run reaches `width - 3` steps each side, and even widths need
   * slightly more than the odd-width linear fit suggests (width 6 still conflicts
   * at reach 3). Any reach at or above the requirement is safe — a longer flat
   * run only forbids stepping through a bend, it never forces an unreachable
   * profile, since the two legs meet at the corner cell and that cell already
   * satisfies both endpoint constraints. `width` is therefore used as a
   * deliberate upper bound rather than the tighter `width - 3`: it costs a few
   * extra flat steps on wide roads and cannot under-constrain.
   */
  const cornerReach = spec.width;
  const cornerFlat = new Set<number>();
  for (let i = 1; i < centre.length; i++) {
    const a = centre[i - 1]!,
      b = centre[i]!,
      c = centre[i + 1];
    if (!c) continue;
    const incoming = { x: b.x - a.x, z: b.z - a.z },
      outgoing = { x: c.x - b.x, z: c.z - b.z };
    if (outgoing.x === incoming.x && outgoing.z === incoming.z) continue;
    // The bend sits between i and i+1; flatten both sides.
    for (let k = i - cornerReach + 1; k <= i + cornerReach; k++) if (k >= 0 && k < centre.length) cornerFlat.add(k);
  }
  const candidates = surveyed.map((columns, i) => {
    const choices: Candidate[] = [];
    for (let y = spec.minY; y <= spec.maxY; y++) {
      if (
        (i < landingLength && y !== spec.waypoints[0]![1]) ||
        (i >= centre.length - landingLength && y !== spec.waypoints.at(-1)![1])
      )
        continue;
      if (spec.bounds && (y < spec.bounds.min[1] || y + headroom >= spec.bounds.max[1])) continue;
      const bridge = columns.some((c) => c.water !== null);
      if (bridge && (!spec.bridge || i === 0 || i === centre.length - 1)) continue;
      if (
        columns.some((c) =>
          bridge
            ? y <= c.ground || (c.water !== null && y - (c.water + 1) < spec.bridge!.waterClearance)
            : c.ground - y > spec.maxCut || y - 1 - c.ground > spec.maxFill,
        )
      )
        continue;
      const earth = bridge
        ? 0
        : columns.reduce((n, c) => n + Math.max(0, c.ground - y) + Math.max(0, y - 1 - c.ground), 0);
      choices.push({ y, bridge, earth });
    }
    return choices;
  });
  type Node = { c: Candidate; run: number; rise: number; cost: number; smooth: number; previous: Node | null };
  let layer: Node[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const next: Node[] = [];
    for (const c of candidates[i]!) {
      const byRun = new Map<string, Node>();
      const previous: (Node | null)[] = i === 0 ? [null] : layer;
      for (const p of previous) {
        if (p && (Math.abs(c.y - p.c.y) > maxStep || ((c.bridge || p.c.bridge) && c.y !== p.c.y))) continue;
        // A bend holds one height: both footprints cover the shared corner cells.
        if (p && cornerFlat.has(i) && cornerFlat.has(i - 1) && c.y !== p.c.y) continue;
        // A one-cell crest needs stairs facing both ways; require a landing instead.
        if (p && p.rise > 0 && c.y < p.c.y) continue;
        const run = c.bridge ? (p?.run ?? 0) + 1 : 0;
        if (run > (spec.bridge?.maxSpan ?? 0)) continue;
        const rise = p ? c.y - p.c.y : 0;
        const node: Node = {
          c,
          run,
          rise,
          cost: (p?.cost ?? 0) + c.earth,
          smooth: (p?.smooth ?? 0) + Math.abs(rise),
          previous: p,
        };
        const key = `${run}/${rise > 0}`;
        const old = byRun.get(key);
        if (!old || node.cost < old.cost || (node.cost === old.cost && node.smooth < old.smooth)) byRun.set(key, node);
      }
      next.push(...byRun.values());
    }
    layer = next;
    if (!layer.length) {
      const p = centre[i]!;
      fail(
        'road.no-profile',
        [p.x, spec.waypoints[0]![1], p.z],
        `第 ${i} 段没有满足端点、坡度、削填、桥长和净空约束的纵断面`,
      );
      break;
    }
  }
  const best = layer.sort((a, b) => a.cost - b.cost || a.smooth - b.smooth)[0];
  const heights: Candidate[] = [];
  for (let n: Node | null = best ?? null; n; n = n.previous) heights.unshift(n.c);
  if (best && best.cost > spec.earthworkBudget)
    fail(
      'road.earthwork-budget',
      spec.waypoints[0]!,
      `断面削填计量 ${best.cost} 超过预算 ${spec.earthworkBudget}（弯角重叠断面保守重复计量）`,
    );
  const sections: RoadSection[] = centre.map((p, i) => ({
    x: p.x,
    z: p.z,
    y: heights[i]?.y ?? spec.waypoints[0]![1],
    step: i,
    bridge: heights[i]?.bridge ?? false,
    columns: surveyed[i]!,
  }));
  // Reuse the road design contract/material pass, replacing only its sampled footprint.
  let cursor = 0;
  const base = planRoad({
    waypoints: spec.waypoints,
    profile: { width: 1, maxStepUp: maxStep, maxStepDown: maxStep, strategy: 'stairs', object: spec.id },
    heightAt: () => sections[cursor++]!.y,
  });
  const cells: RoadPlan['cells'][number][] = [];
  const seen = new Map<string, RoadPlan['cells'][number]>();
  for (const section of sections)
    for (const [j, c] of section.columns.entries()) {
      const prev = sections[section.step - 1],
        next = sections[section.step + 1];
      const low = prev && prev.y < section.y ? prev : next && next.y < section.y ? next : null;
      const stairDirection = low
        ? section.x !== low.x
          ? section.x > low.x
            ? 0
            : 1
          : section.z > low.z
            ? 2
            : 3
        : null;
      const cell = {
        x: c.x,
        z: c.z,
        y: section.y,
        step: section.step,
        lateral: j - Math.floor(spec.width / 2),
        strategy: 'stairs' as const,
        stairDirection,
        rise: section.step ? section.y - sections[section.step - 1]!.y : 0,
        cut: section.bridge ? 0 : Math.max(0, c.ground - section.y),
        fill: section.bridge ? 0 : Math.max(0, section.y - 1 - c.ground),
        bridge: section.bridge,
      };
      const key = `${c.x},${c.z}`,
        old = seen.get(key);
      if (old) {
        if (old.y !== cell.y || old.bridge !== cell.bridge)
          fail(
            'road.crossing-conflict',
            [cell.x, cell.y, cell.z],
            '弯角或自交处有不兼容的路面标高；请延长平段或调整走廊',
          );
        // Centreline ownership matters for stair direction and passability.
        if (cell.lateral === 0 && old.lateral !== 0) {
          cells.splice(cells.indexOf(old), 1);
          cells.push(cell);
          seen.set(key, cell);
        }
        continue;
      }
      seen.set(key, cell);
      cells.push(cell);
      if (
        spec.bounds &&
        (cell.x < spec.bounds.min[0] ||
          cell.x >= spec.bounds.max[0] ||
          cell.z < spec.bounds.min[2] ||
          cell.z >= spec.bounds.max[2])
      )
        fail('road.corridor-bounds', [cell.x, cell.y, cell.z], '路宽超出场地边界');
    }
  const spans: BridgeSpan[] = [];
  for (let i = 0; i < sections.length; i++)
    if (sections[i]!.bridge) {
      const start = i;
      while (sections[i + 1]?.bridge) i++;
      spans.push({ start, end: i, length: i - start + 1, deckY: sections[i]!.y, abutments: [start - 1, i + 1] });
    }
  const waterCells: Vec3[] = [];
  for (const c of surveyed.flat())
    if (c.water !== null)
      for (let y = c.ground + 1; y <= c.water; y++)
        if (world.get(c.x, y, c.z)?.name === 'minecraft:water') waterCells.push([c.x, y, c.z]);
  diagnostics.push(...base.diagnostics);
  return {
    ...base,
    id: spec.id,
    targetIdentity,
    baseRevision,
    sections,
    spans,
    headroom,
    constructionBounds: spec.bounds,
    waterCells,
    cells,
    profile: { ...base.profile, width: spec.width },
    diagnostics,
    feasible: !diagnostics.some((d) => d.severity === 'error' || d.severity === 'unknown'),
    cutBlocks: cells.reduce((n, c) => n + c.cut, 0),
    fillBlocks: cells.reduce((n, c) => n + c.fill, 0),
    bounds: {
      min: [Math.min(...cells.map((c) => c.x)), spec.minY, Math.min(...cells.map((c) => c.z))],
      max: [Math.max(...cells.map((c) => c.x)) + 1, spec.maxY + headroom + 1, Math.max(...cells.map((c) => c.z)) + 1],
    },
  };
}

/** Final support and open-water checks, usable before commit on the recorder. */
export function checkRoadProfile(world: Pick<Structure, 'get'>, plan: ProfiledRoadPlan): Diagnostic[] {
  const diagnostics = roadPassability(world, plan, { headroom: plan.headroom });
  const fail = (rule: string, p: Vec3, message: string) =>
    diagnostics.push(
      coordinateDiagnostic({
        rule,
        position: p,
        object: { kind: 'route', id: plan.id },
        message,
        conclusive: collisionBoxes(world.get(...p)).kind !== 'unknown',
        severity: collisionBoxes(world.get(...p)).kind === 'unknown' ? 'unknown' : 'error',
        source: 'road-profile-check',
      }),
    );
  for (const s of plan.sections)
    for (const c of s.columns) {
      if (!s.bridge) {
        for (let y = Math.min(c.ground, s.y - 1); y < s.y; y++)
          if (!fullSupport(world, c.x, y, c.z)) {
            fail('road.foundation-gap', [c.x, y, c.z], '路基或桥台未接到完整实体地面');
            break;
          }
      } else if (c.water !== null)
        for (let y = c.water + 1; y < s.y; y++) {
          const shape = collisionBoxes(world.get(c.x, y, c.z));
          if (shape.kind === 'unknown' || shape.boxes.length) {
            fail('road.bridge-clearance', [c.x, y, c.z], '桥下水面净空被占用或无法判定');
            break;
          }
        }
    }
  for (const p of plan.waterCells)
    if (world.get(...p)?.name !== 'minecraft:water') fail('road.water-blocked', p, '桥梁施工改变了原有水体');
  const top = (x: number, y: number, z: number, u: number, v: number) => {
    const shape = collisionBoxes(world.get(x, y, z));
    return shape.kind === 'supported'
      ? y + shape.boxes.reduce((h, b) => (u >= b[0] && u <= b[3] && v >= b[2] && v <= b[5] ? Math.max(h, b[4]) : h), 0)
      : NaN;
  };
  // Check actual edge heights, not block Y: a full cube in place of a stair
  // would otherwise satisfy the integer grade while still requiring a jump.
  const cells = new Map(plan.cells.map((c) => [`${c.x},${c.z}`, c]));
  for (const a of plan.cells)
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const b = cells.get(`${a.x + dx!},${a.z + dz!}`);
      if (!b) continue;
      const h1 = top(a.x, a.y, a.z, dx ? 0.75 : 0.5, dz ? 0.75 : 0.5);
      const h2 = top(b.x, b.y, b.z, dx ? 0.25 : 0.5, dz ? 0.25 : 0.5);
      if (Number.isFinite(h1) && Number.isFinite(h2) && Math.abs(h1 - h2) > 0.6)
        fail('road.walk-step', [b.x, b.y, b.z], `相邻路面实际碰撞高差 ${Math.abs(h1 - h2)} 超过无跳跃步高 0.6`);
    }
  return diagnostics;
}

export function recordRoadProfile(
  sink: ConstructionSink,
  world: Structure,
  plan: ProfiledRoadPlan,
  materials: RoadProfileMaterials,
): void {
  for (const d of plan.diagnostics) sink.report(d);
  if (!plan.feasible) return;
  if (structureIdentity(world) !== plan.targetIdentity || world.revision !== plan.baseRevision) {
    sink.report(
      coordinateDiagnostic({
        rule: 'road.stale-target',
        object: plan.id,
        region: plan.bounds,
        message: '纵断面依据的模型已改变，必须重新规划',
      }),
    );
    return;
  }
  recordRoadPaving(sink, plan, materials);
  if (materials.bridgeRailing && !materials.bridgeEdge) throw new Error('Bridge railing requires an edge beam');
  if (materials.bridgeEdge)
    for (const span of plan.spans)
      for (let step = span.start - 1; step <= span.end + 1; step++) {
        const section = plan.sections[step]!;
        const next = plan.sections[step + 1] ?? plan.sections[step - 1]!;
        const alongX = next.x !== section.x;
        for (const offset of [-Math.floor(plan.profile.width / 2) - 1, Math.ceil(plan.profile.width / 2)]) {
          const p: Vec3 = [section.x + (alongX ? 0 : offset), section.y, section.z + (alongX ? offset : 0)];
          if (
            plan.constructionBounds &&
            p.some(
              (v, axis) =>
                v < plan.constructionBounds!.min[axis] ||
                v + (axis === 1 && materials.bridgeRailing ? 1 : 0) >= plan.constructionBounds!.max[axis],
            )
          ) {
            sink.report(
              coordinateDiagnostic({
                rule: 'road.edge-bounds',
                object: plan.id,
                position: p,
                message: '桥边梁或栏杆超出声明场地',
              }),
            );
            continue;
          }
          sink.put(...p, materials.bridgeEdge(p, span), {}, 'road');
          if (!fullSupport(sink, ...p))
            sink.report(
              coordinateDiagnostic({
                rule: 'road.edge-support',
                object: plan.id,
                position: p,
                message: '桥边梁必须提供完整支撑',
              }),
            );
          if (materials.bridgeRailing) {
            const rail: Vec3 = [p[0], p[1] + 1, p[2]];
            sink.put(...rail, materials.bridgeRailing(rail, span), {}, 'road');
          }
        }
      }
  for (const d of checkRoadProfile(sink, plan)) sink.report(d);
}

export function buildRoadProfile(
  world: Structure,
  plan: ProfiledRoadPlan,
  materials: RoadProfileMaterials,
  options: Pick<ConstructionRequest, 'protection' | 'rules' | 'bounds'> = {},
) {
  const construction = planConstruction(world, {
    ...options,
    bounds: options.bounds ?? plan.constructionBounds,
    id: plan.id,
    object: { kind: 'route', id: plan.id },
    excavationAuthorized: true,
    build: (sink) => recordRoadProfile(sink, world, plan, materials),
  });
  return {
    plan: construction,
    committed: construction.feasible ? (commitConstruction(world, construction), true) : false,
    diagnostics: construction.diagnostics,
  };
}
