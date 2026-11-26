import type { Structure, Vec3 } from '../core/structure.js';
import { matchesRecordedState } from './recorded-geometry.js';
import type { ConstructionSink, ConstructionWrite } from './construction.js';
import { coordinateDiagnostic, type Diagnostic } from './diagnostic-core.js';
import { collisionBoxes } from './traversal.js';

/** Resolved component geometry, retained for final-model checks; no callback replay. */
export type WalkwayComponent = Readonly<{
  id: string;
  kind: 'deck' | 'beams' | 'support' | 'railing' | 'light' | 'details';
  cells: readonly ConstructionWrite[];
  anchors: readonly Vec3[];
  contacts: readonly Vec3[];
  custom: boolean;
}>;
const offsets = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;
export function neighboursOf([x, y, z]: Vec3): Vec3[] {
  return offsets.map(([dx, dy, dz]) => [x + dx, y + dy, z + dz]);
}
export function recordWalkwayComponent(
  sink: ConstructionSink,
  build: (sink: ConstructionSink) => void,
): ConstructionWrite[] {
  const writes = new Map<string, ConstructionWrite>();
  build({
    ...sink,
    put: (x, y, z, material, states, role) => {
      sink.put(x, y, z, material, states, role ?? 'road');
      writes.set(`${x},${y},${z}`, { position: [x, y, z], state: sink.get(x, y, z)!, role: role ?? 'road' });
    },
    air: (x, y, z, role) => {
      sink.air(x, y, z, role ?? 'road');
      writes.delete(`${x},${y},${z}`);
    },
  });
  return [...writes.values()];
}
function solid(world: Pick<Structure, 'get'>, p: Vec3): boolean | null {
  const shape = collisionBoxes(world.get(...p));
  return shape.kind === 'unknown' ? null : shape.boxes.length > 0;
}

/** Voxel attachment checks, not structural physics or load-bearing calculations. */
export function checkWalkwayComponent(
  world: Pick<Structure, 'get'>,
  object: string,
  component: WalkwayComponent,
  connectors: readonly Vec3[] = [],
): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const report = (rule: string, p: Vec3, message: string, unknown = false) =>
    findings.push(
      coordinateDiagnostic({
        rule,
        object: { kind: 'walkway-component', id: `${object}/${component.id}` },
        position: p,
        severity: unknown ? 'unknown' : 'error',
        conclusive: !unknown,
        message,
        source: 'walkway-final',
      }),
    );
  for (const c of component.cells) {
    if (!matchesRecordedState(world, c.position, c.state))
      report(
        'walkway.component-missing',
        c.position,
        '自定义构件的方块或方向状态与施工计划不符',
        solid(world, c.position) === null,
      );
  }
  if (component.kind === 'deck') return findings;
  if (!component.cells.length && component.kind === 'details') return findings;
  if (!component.cells.length && component.kind === 'light') {
    report('walkway.component-missing', component.anchors[0] ?? [0, 0, 0], '声明的灯具回调没有生成构件');
    return findings;
  }
  const own = new Set(component.cells.map((c) => c.position.join(',')));
  // Details can attach to existing terrain or other planned components. Own
  // cells are never used as external roots (a floating stack is not grounded).
  let anchors =
    component.kind === 'details'
      ? component.cells
          .flatMap((c) => neighboursOf(c.position))
          .filter((p) => !own.has(p.join(',')) && solid(world, p) !== false)
      : component.anchors;
  if (component.kind === 'details' && anchors.some((p) => solid(world, p) === true))
    anchors = anchors.filter((p) => solid(world, p) === true);
  if (!anchors.length) {
    report(
      'walkway.component-unanchored',
      component.cells[0]?.position ?? component.contacts[0] ?? [0, 0, 0],
      '构件没有声明或实际可用的连接点',
    );
    return findings;
  }
  for (const p of anchors)
    if (solid(world, p) !== true)
      report('walkway.component-anchor', p, '构件连接点缺失或无法判断碰撞', solid(world, p) === null);
  const allowed = new Map(
    [...component.cells.map((c) => c.position), ...connectors, ...anchors, ...component.contacts].map((p) => [
      p.join(','),
      p,
    ]),
  );
  const flood = (allowUnknown: boolean) => {
    const reached = new Set<string>();
    const queue = anchors.filter((p) => solid(world, p) === true || (allowUnknown && solid(world, p) === null));
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]!,
        key = p.join(',');
      if (reached.has(key)) continue;
      reached.add(key);
      for (const q of neighboursOf(p))
        if (
          allowed.has(q.join(',')) &&
          !reached.has(q.join(',')) &&
          (solid(world, q) === true || (allowUnknown && solid(world, q) === null))
        )
          queue.push(q);
    }
    return reached;
  };
  const reached = flood(false),
    possible = flood(true);
  for (const p of [...component.cells.map((c) => c.position), ...component.contacts])
    if (!reached.has(p.join(','))) {
      report(
        'walkway.component-disconnected',
        p,
        '构件未通过自身及声明的连接构件接到实际锚点',
        possible.has(p.join(',')),
      );
      break;
    }
  return findings;
}
