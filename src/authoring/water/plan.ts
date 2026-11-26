import { contains, type Vec3 } from '../../core/structure.js';
import { coordinateDiagnostic, type Diagnostic, type DiagnosticObject } from '../diagnostic-core.js';
import type { SurfaceQuery } from '../surface.js';
import {
  WATER_RULES,
  type WaterColumn,
  type WaterPlan,
  type WaterPort,
  type WaterSegmentPlan,
  type WaterSegmentSpec,
  type WaterSystemSpec,
} from './contracts.js';
import { segmentObject } from './geometry.js';

function objectOf(spec: WaterSystemSpec): DiagnosticObject {
  if (spec.object) return typeof spec.object === 'string' ? { kind: 'water-system', id: spec.object } : spec.object;
  return { kind: 'water-system', id: spec.id };
}

/** Water level a segment holds: the first path point's Y. */
function point0Y(spec: WaterSegmentSpec): number {
  return spec.path[0]?.[1] ?? spec.basin?.max[1] ?? 0;
}

/** Half-open outline of a pool: the body, or null when no basin was declared. */
function bodyOutline(segment: WaterSegmentSpec): { min: [number, number]; max: [number, number] } | null {
  if (!segment.basin) return null;
  return { min: [segment.basin.min[0], segment.basin.min[2]], max: [segment.basin.max[0], segment.basin.max[2]] };
}

function faceOffsets(facing: number): { forward: readonly [number, number]; lateral: readonly [number, number] } {
  if (facing === 0) return { forward: [1, 0], lateral: [0, 1] };
  if (facing === 1) return { forward: [-1, 0], lateral: [0, 1] };
  if (facing === 2) return { forward: [0, 1], lateral: [1, 0] };
  return { forward: [0, -1], lateral: [1, 0] };
}

/** Cross-section cells of a port: `width` cells on the face perpendicular to `facing`. */
function portCells(port: WaterPort, fallbackWidth: number): Vec3[] {
  const width = Math.max(1, Math.floor(port.width ?? fallbackWidth));
  const { lateral } = faceOffsets(port.facing);
  const half = Math.floor(width / 2);
  const cells: Vec3[] = [];
  for (let index = 0; index < width; index++) {
    const offset = index - half;
    cells.push([port.at[0] + lateral[0] * offset, port.at[1], port.at[2] + lateral[1] * offset]);
  }
  return cells;
}

/** Port of a segment end when the spec declares none: the path end, full width. */
function derivedPort(segment: WaterSegmentSpec, end: 'inlet' | 'outlet'): WaterPort {
  const point = end === 'inlet' ? segment.path[0]! : segment.path.at(-1)!;
  const width = (segment.halfWidth ?? 1) * 2 + 1;
  if (segment.path.length < 2) return { at: [...point] as Vec3, facing: 0, width };
  const neighbour = end === 'inlet' ? segment.path[1]! : segment.path.at(-2)!;
  const dx = point[0] - neighbour[0];
  const dz = point[2] - neighbour[2];
  const facing = dx > 0 ? 0 : dx < 0 ? 1 : dz > 0 ? 2 : 3;
  return { at: [...point] as Vec3, facing, width };
}

/** Do two step footprints touch (share a cell or a face, in any direction)? */
function footprintsTouch(from: readonly Vec3[], to: readonly Vec3[]): boolean {
  for (const a of from)
    for (const b of to) {
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 1) return true;
    }
  return false;
}

/**
 * Direction of travel at a path step, used to lay the cross-section.
 *
 * The tangent is measured over a wide window rather than to the nearest
 * neighbour: on a meandering path the nearest neighbour is mostly *sideways*,
 * so a one-step tangent would stand the cross-section across the channel and
 * break the reach apart. Ties keep the previous step's axis, so the choice
 * cannot flip back and forth along one reach. A step that does not move in XZ
 * at all (a vertical fall) returns `null` and keeps the square footprint.
 */
function travelDirection(path: readonly Vec3[], index: number, previous: number | null = null): number | null {
  const window = 4;
  const from = path[Math.max(0, index - window)]!;
  const to = path[Math.min(path.length - 1, index + window)]!;
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (dx !== 0 || dz !== 0) {
    if (Math.abs(dx) === Math.abs(dz) && previous !== null) return previous;
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3;
  }
  // No horizontal movement anywhere near this step: look further out before
  // giving up, so a long vertical sheet still gets a facing from its approach.
  for (let offset = 1; offset < path.length; offset++)
    for (const candidate of [index - offset, index + offset]) {
      if (candidate < 0 || candidate >= path.length) continue;
      const ex = path[candidate]![0] - path[index]![0];
      const ez = path[candidate]![2] - path[index]![2];
      if (ex !== 0 || ez !== 0) return Math.abs(ex) > Math.abs(ez) ? (ex > 0 ? 0 : 1) : ez > 0 ? 2 : 3;
    }
  return null;
}

/** Plan the channel geometry. Water is placed only after every bed cell exists. */
export function planWaterSystem(spec: WaterSystemSpec, surface?: SurfaceQuery): WaterPlan {
  if (!spec.segments.length) throw new Error(`Water system ${spec.id} has no segments`);
  const object = objectOf(spec);
  const diagnostics: Diagnostic[] = [];
  const segments: WaterSegmentPlan[] = [];
  for (const segment of spec.segments) {
    if (segment.path.length < 1) throw new Error(`Water segment ${segment.id} needs a path`);
    const halfWidth = segment.halfWidth ?? 1;
    if (!Number.isSafeInteger(halfWidth) || halfWidth < 0)
      throw new Error(`Water segment ${segment.id} has an invalid width`);
    const declaredDepth = segment.depth ?? null;
    if (declaredDepth !== null && (!Number.isSafeInteger(declaredDepth) || declaredDepth < 1))
      throw new Error(`Water segment ${segment.id} has an invalid depth`);
    const hanging = segment.kind === 'drop' || segment.kind === 'wall-sheet';
    /**
     * Facing used when the path itself has no horizontal movement (a vertical
     * fall). The declared port says which way the water travels, so the
     * cross-section stands across the channel instead of becoming a 3x3 block.
     */
    const declaredFacing = segment.outlet?.facing ?? segment.inlet?.facing ?? null;
    const columns = new Map<string, WaterColumn>();
    /** Cells of each step's own footprint — the honest truth for a hanging sheet. */
    const sheetCells = new Map<string, Vec3>();
    const stepFootprints: Vec3[][] = [];
    /** Axis chosen for the previous step, so the cross-section cannot flip. */
    let previousDirection: number | null = null;
    const steps: Vec3[] = [];
    let lowest = Infinity;
    let highest = -Infinity;
    segment.path.forEach((point, step) => {
      const [x, , z] = point;
      const top = segment.surfaceAt?.(x, z, step) ?? point[1];
      const declaredBed = segment.bedAt?.(x, z, step) ?? null;
      let depth = declaredDepth ?? 1;
      if (declaredBed !== null) {
        const derived = top - declaredBed;
        if (declaredDepth !== null && declaredDepth !== derived)
          diagnostics.push(
            coordinateDiagnostic({
              rule: WATER_RULES.depthConflict,
              severity: 'warning',
              object: segmentObject(segment),
              position: [x, top, z],
              message: `${segment.id} 在 ${x},${z} 同时声明 depth=${declaredDepth} 与 bedAt=${declaredBed}，两者相差 ${derived} 层；以 bedAt 为准`,
              data: { depth: declaredDepth, bed: declaredBed, derived },
              source: 'water-plan',
            }),
          );
        depth = Math.max(1, derived);
      }
      const bottom = top - depth + 1;
      lowest = Math.min(lowest, bottom, bottom - 1);
      highest = Math.max(highest, top);
      steps.push([x, top, z]);
      const footprint: Vec3[] = [];
      /*
       * The footprint is a **cross-section**, not a square brush: for a path with
       * a direction it spans the perpendicular at this step, so a straight
       * channel is exactly `2 * halfWidth + 1` wide and does not stick out one
       * row past its own ends (which is how a brook used to swallow the first
       * row of the fall below it). A single-point path has no direction, so it
       * keeps the square footprint.
       */
      const direction =
        segment.path.length > 1 ? (travelDirection(segment.path, step, previousDirection) ?? declaredFacing) : null;
      if (direction !== null) previousDirection = direction;
      const offsets: [number, number][] = [];
      if (direction === null) {
        for (let dx = -halfWidth; dx <= halfWidth; dx++)
          for (let dz = -halfWidth; dz <= halfWidth; dz++) offsets.push([dx, dz]);
      } else {
        const { lateral } = faceOffsets(direction);
        for (let index = -halfWidth; index <= halfWidth; index++)
          offsets.push([lateral[0] * index, lateral[1] * index]);
      }
      for (const [dx, dz] of offsets) {
        const cell: Vec3 = [x + dx, top, z + dz];
        sheetCells.set(cell.join(','), cell);
        footprint.push(cell);
        // Body connectivity is volumetric: adjacent stepped surfaces can still
        // share two wet layers. Surface-only tests incorrectly reject a deep
        // channel every time its level drops one block.
        if (!hanging) for (let y = bottom; y < top; y++) footprint.push([x + dx, y, z + dz]);
        if (hanging) continue;
        // A pool that declares a basin **is** that basin: the path only says
        // where it is and at what level, so its own slab must not add water
        // outside the declared outline.
        if (segment.kind === 'pool' && segment.basin) continue;
        const key = `${x + dx},${z + dz}`;
        const existing = columns.get(key);
        // A body fills its column between the deepest declared bottom and the
        // highest declared surface, so a channel that steps down through the
        // same column still reads as one water body.
        columns.set(key, {
          x: x + dx,
          z: z + dz,
          top: existing ? Math.max(existing.top, top) : top,
          bottom: existing ? Math.min(existing.bottom, bottom) : bottom,
          bed: existing ? Math.min(existing.bed, bottom - 1) : bottom - 1,
          depth: existing ? Math.max(existing.depth, depth) : depth,
          source: 'path',
          step,
        });
      }
      /*
       * Consecutive path steps of a **body** must actually touch: two waypoints
       * three blocks apart on a one-wide channel leave dry cells *inside* the
       * segment, which is exactly the "looks continuous, is not" failure the
       * water rules exist to catch. Wider segments touch as soon as their
       * footprints meet. A hanging sheet is exempt: it is a stylized curtain in
       * the air, and what has to be continuous there is its landing.
       */
      const previousFootprint = stepFootprints.at(-1);
      if (!hanging && previousFootprint && !footprintsTouch(previousFootprint, footprint))
        diagnostics.push(
          coordinateDiagnostic({
            rule: WATER_RULES.discontinuity,
            object: segmentObject(segment),
            position: [...footprint[0]!] as Vec3,
            message: `${segment.id} 的第 ${step} 个路径点与上一个路径点不相邻，中间会留干格；请补上中间点或加宽水段`,
            data: { step, previous: steps.at(-2) ?? null, current: [x, top, z] },
            source: 'water-plan',
          }),
        );
      stepFootprints.push(footprint);
    });
    if (lowest === Infinity) lowest = spec.source[1];
    if (highest === -Infinity) highest = spec.source[1];
    // A pool's declared outline *is* its body: it overrides path columns it
    // covers and adds the rest of the water surface the path slab never had.
    const outline = bodyOutline(segment);
    if (segment.kind === 'pool' && outline) {
      const level = point0Y(segment);
      const depth = declaredDepth ?? 1;
      const shape = segment.outline;
      let outside = 0;
      for (let x = outline.min[0]; x < outline.max[0]; x++)
        for (let z = outline.min[1]; z < outline.max[1]; z++) {
          if (shape && !shape(x, z)) {
            outside++;
            continue;
          }
          const key = `${x},${z}`;
          columns.set(key, {
            x,
            z,
            top: level,
            bottom: level - depth + 1,
            bed: level - depth,
            depth,
            source: 'basin',
          });
        }
      if (shape && outside === (outline.max[0] - outline.min[0]) * (outline.max[1] - outline.min[1]))
        diagnostics.push(
          coordinateDiagnostic({
            rule: WATER_RULES.basinOutline,
            object: segmentObject(segment),
            region: segment.basin!,
            message: `${segment.id} 的 outline 在 basin 范围内没有留下任何水格，潭会是空的`,
            source: 'water-plan',
          }),
        );
      const box = segment.basin!;
      // The box's Y range is only advisory — the water level comes from the
      // path and the thickness from `depth` — but a box that sits entirely away
      // from the water column is a design mistake worth naming.
      const columnBottom = level - depth + 1;
      if (box.max[1] < columnBottom || box.min[1] > level)
        diagnostics.push(
          coordinateDiagnostic({
            rule: WATER_RULES.basinOutline,
            severity: 'warning',
            object: segmentObject(segment),
            region: box,
            message: `${segment.id} 的 basin Y 范围 [${box.min[1]},${box.max[1]}) 与水位 ${level}（水柱 ${columnBottom}..${level}）无关；潭的 Y 范围只作参考，水位由 path/depth 决定`,
            data: { level, depth, basinY: [box.min[1], box.max[1]] },
            source: 'water-plan',
          }),
        );
    }
    const all = [...columns.values()];
    const pathColumns = all.filter((column) => column.source === 'path');
    const basinColumns = all.filter((column) => column.source === 'basin');
    /*
     * Two representations, on purpose:
     *
     * - a **body** (reach / pool) is columns: a surface, a volume and a bed per
     *   column, which is what the floor and side contracts are judged on;
     * - a **hanging sheet** (drop / wall-sheet) is just its cells. A waterfall
     *   passes through the same (x,z) column at several heights without filling
     *   the air between them, so a column model would invent water under the
     *   falling sheet — exactly the bug the drop test guards.
     */
    const surfaceCells = hanging ? [...sheetCells.values()] : all.flatMap((column) => columnRange(column));
    const basinCells = hanging ? [] : basinColumns.flatMap((column) => columnRange(column));
    const bedCells = hanging
      ? []
      : pathColumns.concat(basinColumns).map((column) => [column.x, column.bed, column.z] as Vec3);
    const carveCells = hanging ? [...sheetCells.values()] : all.flatMap((column) => columnRange(column));
    const inlet = segment.inlet ?? derivedPort(segment, 'inlet');
    const outlet = segment.outlet ?? derivedPort(segment, 'outlet');
    const inletCells = portCells(inlet, halfWidth * 2 + 1);
    const outletCells = portCells(outlet, halfWidth * 2 + 1);
    if (segment.externalOutlet) {
      const { bounds, facing } = segment.externalOutlet;
      const [dx, dz] = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ][facing]!;
      for (const cell of outletCells) {
        const wet = all.some((c) => c.x === cell[0] && c.z === cell[2] && cell[1] >= c.bottom && cell[1] <= c.top);
        if (!wet || !contains(bounds, ...cell) || contains(bounds, cell[0] + dx!, cell[1], cell[2] + dz!))
          diagnostics.push(
            coordinateDiagnostic({
              rule: 'water.external-outlet',
              object: segmentObject(segment),
              position: cell,
              message: '场景外出口必须是边界上朝外的实际湿截面',
              source: 'water-plan',
            }),
          );
      }
    }
    segments.push({
      spec: segment,
      steps,
      columns: all,
      surfaceCells,
      basinCells,
      bedCells,
      carveCells,
      inletCells,
      outletCells,
      inletY: inlet.at[1],
      outletY: outlet.at[1],
      lowest,
      highest,
    });
  }

  const byId = new Map(segments.map((segment) => [segment.spec.id, segment]));
  const wet = new Set<string>();
  for (const segment of segments) for (const cell of segment.surfaceCells) wet.add(cell.join(','));
  for (const segment of segments) for (const cell of segment.spec.inflows ?? []) wet.add(cell.join(','));

  /** Do the two cross-sections touch (share a cell or a face)? */
  const sectionsTouch = (from: readonly Vec3[], to: readonly Vec3[]): boolean => {
    for (const a of from)
      for (const b of to) {
        if (a[1] === b[1] && Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]) <= 1) return true;
        // The receiving body may also be wet one level below the lip (a pour
        // into a pool) — that is what `dropLanding` judges, not this rule.
      }
    return false;
  };

  // Continuity: a declared connection must name a real segment, and the two
  // interfaces must actually touch. There is no invented tolerance: a route
  // that stops short is reported, not rounded up to "close enough".
  for (const segment of segments) {
    const isCarrying = segment.spec.kind !== 'pool';
    for (const id of segment.spec.connectsTo ?? []) {
      const target = byId.get(id);
      if (!target) {
        diagnostics.push(
          coordinateDiagnostic({
            rule: WATER_RULES.portMissing,
            object: segmentObject(segment.spec),
            position: [...(segment.spec.path.at(-1) ?? spec.source)] as Vec3,
            message: `${segment.spec.id} 的 connectsTo 指向不存在的段 "${id}"，无法校验这段连接`,
            data: { from: segment.spec.id, to: id },
            source: 'water-plan',
          }),
        );
        continue;
      }
      if (!isCarrying) continue;
      const receiving = target.surfaceCells.filter((cell) => cell[1] === target.inletY);
      if (segment.spec.kind === 'drop') {
        // A waterfall lands on the next surface or in its pool: below the drop
        // foot must be either the receiving water or its bed, not empty air.
        if (target.inletY > segment.outletY)
          diagnostics.push(
            coordinateDiagnostic({
              rule: WATER_RULES.dropLanding,
              object: segmentObject(segment.spec),
              position: [...segment.spec.path.at(-1)!] as Vec3,
              message: `跌水落点 ${segment.spec.path.at(-1)!.join(',')} 的下游水面 ${target.inletY} 高于落点 ${segment.outletY}`,
              data: { from: segment.spec.id, to: target.spec.id, footY: segment.outletY, receivingY: target.inletY },
              source: 'water-plan',
            }),
          );
        else if (!sectionsTouch(segment.outletCells, receiving))
          diagnostics.push(
            coordinateDiagnostic({
              rule: WATER_RULES.discontinuity,
              object: segmentObject(segment.spec),
              position: [...segment.outletCells[0]!] as Vec3,
              message: `${segment.spec.id} 的落点 ${segment.outletCells[0]!.join(',')} 下方没有 ${target.spec.id} 的水面，水帘落空`,
              data: { from: segment.spec.id, to: target.spec.id },
              source: 'water-plan',
            }),
          );
        continue;
      }
      // A direct connection holds one level. Anything else is a drop the design
      // forgot to declare — the framework does not silently accept a step, and
      // it says which segment to add rather than widening a tolerance.
      if (target.inletY !== segment.outletY) {
        diagnostics.push(
          coordinateDiagnostic({
            rule: WATER_RULES.levelMismatch,
            object: segmentObject(segment.spec),
            position: [...segment.outletCells[0]!] as Vec3,
            message: `${segment.spec.id} 出口水位 ${segment.outletY} 与 ${target.spec.id} 入水口水位 ${target.inletY} 不同；有落差就应在两者之间显式声明一段跌水`,
            data: { from: segment.spec.id, to: target.spec.id, fromY: segment.outletY, toY: target.inletY },
            source: 'water-plan',
          }),
        );
        continue;
      }
      if (!sectionsTouch(segment.outletCells, target.inletCells) && !sectionsTouch(segment.outletCells, receiving))
        diagnostics.push(
          coordinateDiagnostic({
            rule: WATER_RULES.discontinuity,
            object,
            position: [...segment.outletCells[0]!] as Vec3,
            message: `${segment.spec.id} 的出口 ${segment.outletCells[0]!.join(',')} 与 ${target.spec.id} 的入水口不相邻，水会断开`,
            data: { from: segment.spec.id, to: target.spec.id },
            source: 'water-plan',
          }),
        );
    }
  }

  // The source must be water *in the plan or the model*. Planning runs before
  // any block exists, so asking the model alone would call every system's source
  // dry; the plan's own water cells are the honest check at this stage, and
  // `checkWaterSystem` verifies the finished model again.
  if (surface) {
    const sourceSample = surface.water(spec.source[0], spec.source[2]);
    if (sourceSample === null && !wet.has(spec.source.join(',')))
      diagnostics.push(
        coordinateDiagnostic({
          rule: WATER_RULES.drySource,
          object,
          position: [...spec.source] as Vec3,
          message: `源头 ${spec.source.join(',')} 既没有水面，也不在计划的任何水段里，水系会从干河床开始`,
          source: 'water-plan',
        }),
      );
  }
  const outlet = spec.outlet ?? null;
  return {
    id: spec.id,
    source: [...spec.source] as Vec3,
    outlet,
    segments,
    diagnostics,
    feasible: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  };
}

/** Water cells of a column, top down. */
function columnRange(column: WaterColumn): Vec3[] {
  const cells: Vec3[] = [];
  for (let y = column.top; y >= column.bottom; y--) cells.push([column.x, y, column.z]);
  return cells;
}

/** Water surface cells of a completed system, for downstream plants and checks. */
export function waterSurfaceCells(plan: WaterPlan): Vec3[] {
  const out: Vec3[] = [];
  for (const segment of plan.segments) out.push(...segment.surfaceCells);
  return out;
}

/** True when a cell lies in any pool basin of the plan. */
export function inPoolBasin(plan: WaterPlan, x: number, y: number, z: number): boolean {
  return plan.segments.some((segment) => {
    if (segment.spec.kind !== 'pool') return false;
    if (segment.spec.outline && !segment.spec.outline(x, z)) return false;
    return !!segment.spec.basin && contains(segment.spec.basin, x, y, z);
  });
}
