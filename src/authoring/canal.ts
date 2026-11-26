import type { State, Structure, Vec3 } from '../core/structure.js';
import { coordinateDiagnostic, mergeDiagnostics, DiagnosticError, type Diagnostic } from './diagnostic-core.js';
import {
  planConstruction,
  commitConstruction,
  type ConstructionPlan,
  type ConstructionRequest,
  type ConstructionSink,
  type ConstructionWrite,
} from './construction.js';
import { recordWaterSystem, type WaterMaterials } from './water/build.js';
import { checkWaterSystem, sealsWater } from './water/check.js';
import type { WaterColumn, WaterPlan } from './water/contracts.js';
import { SurfaceQuery } from './surface.js';
import { fullSupport } from './road-profile.js';
import type { RoadPlan } from './roads.js';
import { collisionBoxes } from './traversal.js';

export type CanalBank = Readonly<{ x: number; z: number; bottom: number; waterY: number; top: number }>;
export type CanalSpec = Readonly<{
  water: WaterPlan;
  materials: WaterMaterials &
    Readonly<{
      bank: (position: Vec3, bank: CanalBank) => State;
      coping?: (sink: ConstructionSink, bank: CanalBank) => void;
    }>;
  /** Explicit connection to existing upstream/downstream water, not an arbitrary leak exemption. */
  openBoundary?: (position: Vec3) => boolean;
  /** Mandatory receiving/source cells: a dry or blocked port must not become a closed bank. */
  requiredConnections?: readonly Vec3[];
  /** Resolve clearance from a shared crossing plan instead of carving its deck. */
  clearTo?: (column: WaterColumn) => number;
  /** Resolved roads constrain the trench using their actual planned underside. */
  crossings?: readonly Readonly<{ road: RoadPlan; deckThickness: number }>[];
  bankTop?: (column: CanalBank, terrain: number | null) => number;
  /** Bridges/access platforms may suppress visible coping; their underwater wall remains. */
  finishBank?: (bank: CanalBank) => boolean;
}>;
export type FinishedCanalPlan = Readonly<{
  id: string;
  water: WaterPlan;
  banks: readonly CanalBank[];
  coping: readonly ConstructionWrite[];
  connections: readonly Vec3[];
  construction: ConstructionPlan;
  crossings: readonly Readonly<{ deck: Vec3; underside: number; waterY: number }>[];
}>;
type Options = Pick<ConstructionRequest, 'bounds' | 'protection' | 'rules' | 'excavationAuthorized' | 'overlapAllowed'>;
const around = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Finish the actual water-plan perimeter, including elbows and irregular pool outlines. */
export function planFinishedCanal(world: Structure, spec: CanalSpec, options: Options = {}): FinishedCanalPlan {
  const wet = new Set(spec.water.segments.flatMap((s) => s.surfaceCells.map((p) => p.join(','))));
  const columns = new Map<string, WaterColumn>();
  const conflicts: Diagnostic[] = [];
  const crossingColumns = new Map<string, { deck: Vec3; underside: number }>();
  for (const crossing of spec.crossings ?? []) {
    if (!Number.isSafeInteger(crossing.deckThickness) || crossing.deckThickness < 1)
      throw new Error('Crossing deck thickness must be a positive integer');
    for (const c of crossing.road.cells) {
      const key = `${c.x},${c.z}`,
        underside = c.y - crossing.deckThickness + 1;
      if (!crossingColumns.has(key) || crossingColumns.get(key)!.underside > underside)
        crossingColumns.set(key, { deck: [c.x, c.y, c.z], underside });
    }
  }
  for (const s of spec.water.segments)
    for (const c of s.columns) {
      const key = `${c.x},${c.z}`,
        old = columns.get(key);
      if (old && (old.bottom > c.top + 1 || c.bottom > old.top + 1))
        conflicts.push(
          coordinateDiagnostic({
            rule: 'canal.column-conflict',
            object: spec.water.id,
            position: [c.x, c.top, c.z],
            message: '同一水柱的水段被干燥高度隔开，不能合并成连续水体',
          }),
        );
      const top = old ? Math.max(old.top, c.top) : c.top,
        bottom = old ? Math.min(old.bottom, c.bottom) : c.bottom;
      columns.set(key, { ...c, top, bottom, bed: bottom - 1, depth: top - bottom + 1 });
    }
  const connections = new Map<string, Vec3>((spec.requiredConnections ?? []).map((p) => [p.join(','), [...p] as Vec3])),
    spills = new Map<string, Vec3>();
  const walls = new Map<string, Vec3>();
  for (const s of spec.water.segments) {
    if (s.spec.kind === 'drop' || s.spec.kind === 'wall-sheet') continue;
    for (const p of s.surfaceCells)
      for (const [dx, dz] of around) {
        const q: Vec3 = [p[0] + dx, p[1], p[2] + dz],
          key = q.join(',');
        if (wet.has(key) || connections.has(key)) continue;
        const neighbour = columns.get(`${q[0]},${q[2]}`);
        // An explicitly downhill body may spill over its next one-block step.
        // This is a side aperture above the lower surface, never a missing floor.
        if (neighbour && q[1] === neighbour.top + 1 && p[1] > neighbour.top && neighbour.bottom <= p[1] - 1) {
          spills.set(key, q);
          continue;
        }
        if (spec.openBoundary?.(q) && world.get(...q)?.name === 'minecraft:water') {
          connections.set(key, q);
          continue;
        }
        walls.set(key, q);
      }
  }
  const extent = world.inspect().bounds;
  const surfaces = new SurfaceQuery(world, {
    minY: extent?.min[1] ?? 0,
    maxY: extent?.max[1] ?? 0,
    scanLimit: Math.max(1, (extent?.max[1] ?? 1) - (extent?.min[1] ?? 0) + 1),
    airStopsTerrain: false,
  });
  const banks = new Map<string, CanalBank>();
  for (const [x, y, z] of walls.values()) {
    if (columns.has(`${x},${z}`)) continue;
    const key = `${x},${z}`,
      old = banks.get(key);
    const waterY = Math.max(y, old?.waterY ?? y),
      bottom = Math.min(y - 1, old?.bottom ?? y - 1);
    const raw = { x, z, waterY, bottom, top: waterY };
    const top = spec.bankTop?.(raw, surfaces.terrain(x, z)) ?? Math.max(waterY, surfaces.terrain(x, z) ?? waterY);
    if (!Number.isSafeInteger(top) || top < waterY)
      throw new Error('Canal bank top must be an integer at or above water');
    banks.set(key, { ...raw, top });
  }
  const apertures = [...connections.values(), ...spills.values()];
  const water: WaterPlan = {
    ...spec.water,
    segments: spec.water.segments.map((s) => {
      if (s.spec.kind === 'drop' || s.spec.kind === 'wall-sheet') return s;
      // Overlapping pool/channel columns have one actual floor and one volume.
      // Otherwise the channel's shallower bed would be written inside its pool.
      const merged = s.columns.map((c) => ({ ...c, ...columns.get(`${c.x},${c.z}`)!, source: c.source }));
      const volume = (c: WaterColumn): Vec3[] =>
        Array.from({ length: c.top - c.bottom + 1 }, (_, i) => [c.x, c.bottom + i, c.z]);
      return {
        ...s,
        columns: merged,
        surfaceCells: merged.flatMap(volume),
        basinCells: merged.filter((c) => c.source === 'basin').flatMap(volume),
        bedCells: merged.map((c) => [c.x, c.bed, c.z] as Vec3),
        spec: { ...s.spec, inflows: [...(s.spec.inflows ?? []), ...apertures] },
      };
    }),
  };
  const coping: ConstructionWrite[] = [];
  const crossings = [...columns.values()].flatMap((c) => {
    const crossing = crossingColumns.get(`${c.x},${c.z}`);
    return crossing ? [{ ...crossing, waterY: c.top }] : [];
  });
  const construction = planConstruction(world, {
    ...options,
    id: water.id,
    object: { kind: 'canal', id: water.id },
    build: (sink) => {
      for (const d of water.diagnostics) sink.report(d);
      for (const d of conflicts) sink.report(d);
      if (!water.feasible) return;
      // The water recorder still owns the bed-before-water ordering. Clearance is
      // supplied by this combination rather than by a second independently cut trench.
      recordWaterSystem(
        sink,
        { ...water, segments: water.segments.map((s) => ({ ...s, spec: { ...s.spec, carve: 0 } })) },
        { water: spec.materials.water, bed: spec.materials.bed },
      );
      for (const c of columns.values()) {
        const crossing = crossingColumns.get(`${c.x},${c.z}`);
        const clear = Math.min(spec.clearTo?.(c) ?? c.top + 2, crossing ? crossing.underside - 1 : Infinity);
        if (!Number.isSafeInteger(clear)) throw new Error('Canal clearance must be an integer');
        for (let y = c.top + 1; y <= clear; y++) sink.air(c.x, y, c.z, 'water');
      }
      for (const p of walls.values()) {
        const bank = banks.get(`${p[0]},${p[2]}`) ?? { x: p[0], z: p[2], bottom: p[1], waterY: p[1], top: p[1] };
        sink.put(...p, spec.materials.bank(p, bank), {}, 'bank');
      }
      for (const bank of banks.values()) {
        for (let y = bank.bottom; y <= bank.top; y++)
          sink.put(bank.x, y, bank.z, spec.materials.bank([bank.x, y, bank.z], bank), {}, 'bank');
        if (crossingColumns.has(`${bank.x},${bank.z}`) || spec.finishBank?.(bank) === false || !spec.materials.coping)
          continue;
        spec.materials.coping(
          {
            ...sink,
            put: (x, y, z, m, states, role) => {
              sink.put(x, y, z, m, states, role ?? 'bank');
              coping.push({ position: [x, y, z], state: sink.get(x, y, z)!, role: 'bank' });
            },
          },
          bank,
        );
      }
      for (const d of canalGeometry(sink, {
        id: water.id,
        water,
        banks: [...banks.values()],
        coping,
        connections: [...connections.values()],
        crossings,
      }))
        sink.report(d);
    },
  });
  return {
    id: water.id,
    water,
    banks: [...banks.values()],
    coping,
    connections: [...connections.values()],
    construction,
    crossings,
  };
}
export function buildFinishedCanal(world: Structure, plan: FinishedCanalPlan) {
  if (!plan.construction.feasible) throw new DiagnosticError(plan.construction.diagnostics);
  return commitConstruction(world, plan.construction);
}

function canalConnectivity(
  world: Pick<Structure, 'get'>,
  water: WaterPlan,
  connections: readonly Vec3[],
): Diagnostic[] {
  const allowed = new Set([...water.segments.flatMap((s) => s.surfaceCells), ...connections].map((p) => p.join(',')));
  const queue: Vec3[] = world.get(...water.source)?.name === 'minecraft:water' ? [water.source] : [],
    seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!,
      key = p.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      const q: Vec3 = [p[0] + dx!, p[1] + dy!, p[2] + dz!];
      if (allowed.has(q.join(',')) && !seen.has(q.join(',')) && world.get(...q)?.name === 'minecraft:water')
        queue.push(q);
    }
  }
  const findings: Diagnostic[] = [];
  for (const p of [water.source, ...(water.outlet ? [water.outlet] : []), ...connections])
    if (!seen.has(p.join(',')))
      findings.push(
        coordinateDiagnostic({
          rule: 'canal.disconnected',
          object: { kind: 'canal', id: water.id },
          position: p,
          message: '声明的源头、出口或外接水口未通过最终水体贯通',
          source: 'canal-final',
        }),
      );
  return findings;
}
export function checkFinishedCanal(world: Pick<Structure, 'get'>, plan: FinishedCanalPlan): Diagnostic[] {
  return mergeDiagnostics([...plan.construction.diagnostics, ...canalGeometry(world, plan)]);
}
function canalGeometry(world: Pick<Structure, 'get'>, plan: Omit<FinishedCanalPlan, 'construction'>): Diagnostic[] {
  const findings = [...checkWaterSystem(world, plan.water), ...canalConnectivity(world, plan.water, plan.connections)];
  for (const crossing of plan.crossings) {
    const shape = collisionBoxes(world.get(...crossing.deck));
    if (shape.kind === 'unknown' || !shape.boxes.some((b) => b[4] >= 0.5))
      findings.push(
        coordinateDiagnostic({
          rule: 'canal.crossing-deck',
          object: plan.id,
          position: crossing.deck,
          severity: shape.kind === 'unknown' ? 'unknown' : 'error',
          conclusive: shape.kind !== 'unknown',
          message: '跨水道路的计划路面缺失或无法站立',
          source: 'canal-final',
        }),
      );
    if (crossing.waterY >= crossing.underside)
      findings.push(
        coordinateDiagnostic({
          rule: 'canal.crossing-clearance',
          object: plan.id,
          position: [crossing.deck[0], crossing.waterY, crossing.deck[2]],
          message: '水面达到道路桥底，必须调整水系或道路计划',
          source: 'canal-final',
        }),
      );
    for (let y = crossing.waterY + 1; y < crossing.underside; y++) {
      const shape = collisionBoxes(world.get(crossing.deck[0], y, crossing.deck[2]));
      if (shape.kind === 'unknown' || shape.boxes.length) {
        findings.push(
          coordinateDiagnostic({
            rule: 'canal.crossing-clearance',
            object: plan.id,
            position: [crossing.deck[0], y, crossing.deck[2]],
            severity: shape.kind === 'unknown' ? 'unknown' : 'error',
            conclusive: shape.kind !== 'unknown',
            message: '水面与道路桥底之间的净空被占用或无法判定',
            source: 'canal-final',
          }),
        );
        break;
      }
    }
  }
  for (const bank of plan.banks)
    for (let y = bank.bottom; y <= bank.top; y++) {
      const state = world.get(bank.x, y, bank.z),
        seal = sealsWater(state);
      if (seal === 'sealed') continue;
      findings.push(
        coordinateDiagnostic({
          rule: 'canal.bank-gap',
          object: { kind: 'canal', id: plan.id },
          position: [bank.x, y, bank.z],
          severity: seal === 'unknown' ? 'unknown' : 'error',
          conclusive: seal !== 'unknown',
          message: '声明的护岸或压顶基础缺失',
          source: 'canal-final',
        }),
      );
      break;
    }
  for (const c of plan.coping) {
    if (world.get(...c.position)?.name !== c.state.name)
      findings.push(
        coordinateDiagnostic({
          rule: 'canal.coping-gap',
          object: plan.id,
          position: c.position,
          message: '计划中的护岸收边缺失',
          source: 'canal-final',
        }),
      );
    if (!fullSupport(world, c.position[0], c.position[1] - 1, c.position[2])) {
      const unknown = collisionBoxes(world.get(c.position[0], c.position[1] - 1, c.position[2])).kind === 'unknown';
      findings.push(
        coordinateDiagnostic({
          rule: 'canal.coping-support',
          object: plan.id,
          position: c.position,
          severity: unknown ? 'unknown' : 'error',
          conclusive: !unknown,
          message: '护岸收边下方缺少实体支撑',
          source: 'canal-final',
        }),
      );
    }
  }
  return findings;
}
