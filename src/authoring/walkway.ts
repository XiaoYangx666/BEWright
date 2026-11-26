import type { Box, State, Structure, Vec3 } from '../core/structure.js';
import { contains } from '../core/structure.js';
import { coordinateDiagnostic, mergeDiagnostics, DiagnosticError, type Diagnostic } from './diagnostic-core.js';
import {
  planConstruction,
  commitConstruction,
  type ConstructionPlan,
  type ConstructionRequest,
  type ConstructionSink,
  type ConstructionWrite,
} from './construction.js';
import { planRoad, recordRoadPaving, roadPassability, type RoadPlan, type RoadMaterials } from './roads.js';
import { fullSupport } from './road-profile.js';
import { SurfaceQuery } from './surface.js';
import { planRailing, type RailCell } from './railing.js';
import { checkSupport } from './operators.js';
import { collisionBoxes } from './traversal.js';
import { recordWalkwayComponent, checkWalkwayComponent, type WalkwayComponent } from './walkway-components.js';
export type { WalkwayComponent } from './walkway-components.js';

export type WalkwayEdge = Readonly<{ position: Vec3; step: number }>;
export type WalkwaySupport = Readonly<{ x: number; z: number; ground: number; deckY: number }>;
export type WalkwaySupportSite = Readonly<Omit<WalkwaySupport, 'ground'> & { ground: number | null }>;
export type WalkwayBuildContext = Readonly<{
  id: string;
  road: RoadPlan;
  edges: readonly WalkwayEdge[];
  supports: readonly WalkwaySupportSite[];
  railSites: readonly RailCell[];
  deckThickness: number;
  headroom: number;
  railHeight: number;
  openings: readonly Box[];
  /** Read actual original terrain; the sink reads the pending construction. */
  surface: SurfaceQuery;
}>;
export type WalkwayBuilders = Readonly<{
  deck?: (sink: ConstructionSink, context: WalkwayBuildContext) => void;
  beams?: (sink: ConstructionSink, context: WalkwayBuildContext) => void;
  /** Return real existing footings for an offset/arched support; otherwise use the surveyed foot. */
  support?: (
    sink: ConstructionSink,
    site: WalkwaySupportSite,
    context: WalkwayBuildContext,
  ) => void | Readonly<{ footings: readonly Vec3[] }>;
  railing?: (sink: ConstructionSink, context: WalkwayBuildContext) => void;
  /** Towers, braces, cables or decoration attached to existing/planned solid geometry. */
  details?: (sink: ConstructionSink, context: WalkwayBuildContext) => void;
}>;
export type WalkwaySpec = Readonly<{
  id: string;
  /** Supply an existing road/profile plan, or a route whose declared heights are retained. */
  road?: RoadPlan;
  route?: readonly Vec3[];
  width?: number;
  /** Flat run on each side of a bend; defaults to the walking width. */
  cornerLanding?: number;
  deckThickness?: number;
  headroom?: number;
  supports?: Readonly<{ spacing: number; minY: number }>;
  /** Half-open volumes where edge furniture must leave access clear. */
  openings?: readonly Box[];
  railing?: Readonly<{ height?: number; postEvery?: number }>;
  lights?: Readonly<{ spacing: number }>;
  /** Override component geometry independently; omitted builders retain the defaults. */
  builders?: WalkwayBuilders;
  materials: RoadMaterials &
    Readonly<{
      beam?: (position: Vec3) => State;
      pier?: (position: Vec3, support: WalkwaySupport) => State;
      rail?: (cell: RailCell) => State;
      /** Fixture geometry is recorded once; final checks retain all resolved cells. */
      light?: (sink: ConstructionSink, base: Vec3, context: WalkwayBuildContext) => void;
    }>;
}>;
export type WalkwayPlan = Readonly<{
  id: string;
  road: RoadPlan;
  edges: readonly WalkwayEdge[];
  supports: readonly WalkwaySupport[];
  rails: readonly ConstructionWrite[];
  fixtures: readonly ConstructionWrite[];
  construction: ConstructionPlan;
  headroom: number;
  components: readonly WalkwayComponent[];
  railSites: readonly RailCell[];
  railHeight: number;
  openings: readonly Box[];
}>;
type Options = Pick<ConstructionRequest, 'bounds' | 'rules' | 'protection' | 'excavationAuthorized' | 'overlapAllowed'>;

const neighbours = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const key = (x: number, z: number) => `${x},${z}`;

/** One road footprint drives decking, outside beams, piers, rails and light sites. */
export function planWalkway(world: Structure, spec: WalkwaySpec, options: Options = {}): WalkwayPlan {
  const thickness = spec.deckThickness ?? 2,
    headroom = spec.headroom ?? 3;
  const spacing = spec.supports?.spacing ?? 6,
    lightSpacing = spec.lights?.spacing ?? 8;
  const railHeight = spec.railing?.height ?? 1;
  for (const n of [thickness, headroom, spacing, lightSpacing, railHeight])
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error('Walkway dimensions and intervals must be positive integers');
  const road =
    spec.road ??
    planRoad({
      waypoints: cornerLandings(spec.route ?? [], spec.cornerLanding ?? spec.width ?? 5),
      bounds: options.bounds,
      profile: {
        object: { kind: 'walkway', id: spec.id },
        width: spec.width ?? 5,
        strategy: 'stairs',
        maxStepUp: 1,
        maxStepDown: 1,
      },
    });
  const deck = new Map(road.cells.map((c) => [key(c.x, c.z), c]));
  const edges = new Map<string, WalkwayEdge>();
  for (const c of road.cells)
    for (const [dx, dz] of neighbours) {
      const x = c.x + dx,
        z = c.z + dz;
      if (deck.has(key(x, z))) continue;
      const p: Vec3 = [x, c.y, z];
      if (spec.openings?.some((b) => contains(b, x, c.y + 1, z))) continue;
      const old = edges.get(key(x, z));
      if (!old || old.position[1] < c.y) edges.set(key(x, z), { position: p, step: c.step });
    }
  // Join outside corners; neighbouring outside faces otherwise touch only diagonally.
  for (const c of road.cells)
    for (const dx of [-1, 1])
      for (const dz of [-1, 1]) {
        const x = c.x + dx,
          z = c.z + dz;
        if (deck.has(key(x, z)) || edges.has(key(x, z))) continue;
        const a = edges.get(key(c.x + dx, c.z)),
          b = edges.get(key(c.x, c.z + dz));
        if (!a || !b || spec.openings?.some((box) => contains(box, x, c.y + 1, z))) continue;
        edges.set(key(x, z), { position: [x, Math.max(a.position[1], b.position[1]), z], step: c.step });
      }
  const supports: WalkwaySupport[] = [],
    rails: ConstructionWrite[] = [],
    fixtures: ConstructionWrite[] = [],
    components: WalkwayComponent[] = [];
  const minY = spec.supports?.minY ?? 0;
  const surveys = new Map<number, SurfaceQuery>();
  const railSites = new Map<string, RailCell>();
  // Reuse railing's layout/gap semantics on each straight boundary run. The road's
  // step index controls fixture spacing, so a bend never resets the light rhythm.
  const remaining = new Map(edges);
  while (remaining.size) {
    const first = remaining.values().next().value!;
    const [x, , z] = first.position;
    const axis = remaining.has(key(x + 1, z)) || remaining.has(key(x - 1, z)) ? 0 : 2;
    const at = (offset: number) => remaining.get(key(x + (axis === 0 ? offset : 0), z + (axis === 2 ? offset : 0)));
    let start = 0,
      end = 0;
    while (at(start - 1)) start--;
    while (at(end + 1)) end++;
    const path = Array.from({ length: end - start + 1 }, (_, i) => at(start + i)!.position);
    for (let i = start; i <= end; i++) remaining.delete(key(atPosition(x, axis, i, 0), atPosition(z, axis, i, 2)));
    const cells =
      path.length > 1
        ? planRailing({ path: path.map((p) => [p[0], p[1] + 1, p[2]]), postEvery: spec.railing?.postEvery ?? 4 })
        : [{ position: [x, first.position[1] + 1, z] as Vec3, distance: 0, corner: true, end: true, post: true }];
    for (const c of cells) railSites.set(c.position.join(','), c);
  }
  const sites: WalkwaySupportSite[] = [];
  for (const edge of edges.values()) {
    if (!spec.supports || edge.step % spacing !== 0) continue;
    const [x, y, z] = edge.position,
      bottom = y - thickness;
    let survey = surveys.get(bottom);
    if (!survey) {
      survey = new SurfaceQuery(world, {
        minY,
        maxY: bottom,
        scanLimit: Math.max(1, bottom - minY + 1),
        airStopsTerrain: false,
      });
      surveys.set(bottom, survey);
    }
    let ground = fullSupport(world, x, bottom + 1, z) ? bottom + 1 : survey.terrain(x, z);
    if (ground !== bottom + 1)
      for (let yy = bottom; yy >= (ground ?? minY); yy--)
        if (fullSupport(world, x, yy, z)) {
          ground = yy;
          break;
        }
    sites.push({ x, z, ground, deckY: y - thickness + 1 });
  }
  const top = road.cells.reduce((y, c) => Math.max(y, c.y), minY);
  const context: WalkwayBuildContext = {
    id: spec.id,
    road,
    edges: [...edges.values()],
    supports: sites,
    railSites: [...railSites.values()],
    deckThickness: thickness,
    headroom,
    railHeight,
    openings: spec.openings ?? [],
    surface: new SurfaceQuery(world, {
      minY,
      maxY: top,
      scanLimit: Math.max(1, top - minY + 1),
      airStopsTerrain: false,
    }),
  };
  const construction = planConstruction(world, {
    ...options,
    id: spec.id,
    object: { kind: 'walkway', id: spec.id },
    build: (sink) => {
      for (const d of road.diagnostics) sink.report(d);
      if (!road.feasible) return;
      const record = (
        kind: WalkwayComponent['kind'],
        id: string,
        custom: boolean,
        build: (sink: ConstructionSink) => void,
        anchors: readonly Vec3[] = [],
        contacts: readonly Vec3[] = [],
      ) => {
        const cells = recordWalkwayComponent(sink, build);
        const component: WalkwayComponent = { kind, id, custom, cells, anchors, contacts };
        components.push(component);
        return component;
      };
      // Clearance belongs to the route, including when deck geometry is replaced.
      for (const c of road.cells) for (let y = c.y + 1; y <= c.y + headroom; y++) sink.air(c.x, y, c.z, 'road');
      record('deck', 'deck', !!spec.builders?.deck, (part) => {
        if (spec.builders?.deck) return spec.builders.deck(part, context);
        for (const c of road.cells)
          for (let depth = 1; depth < thickness; depth++)
            part.put(
              c.x,
              c.y - depth,
              c.z,
              requiredMaterial(spec.materials.beam, 'beam')([c.x, c.y - depth, c.z]),
              {},
              'road',
            );
        recordRoadPaving(part, road, spec.materials);
      });
      record(
        'beams',
        'beams',
        !!spec.builders?.beams,
        (part) => {
          if (spec.builders?.beams) return spec.builders.beams(part, context);
          for (const edge of edges.values()) {
            const [x, y, z] = edge.position;
            for (let depth = 0; depth < thickness; depth++)
              part.put(x, y - depth, z, requiredMaterial(spec.materials.beam, 'beam')([x, y - depth, z]), {}, 'road');
          }
        },
        road.cells.map((c) => [c.x, c.y, c.z] as Vec3),
      );
      for (const site of sites) {
        const { x, z, ground, deckY } = site;
        if (spec.builders?.support) {
          let footings: readonly Vec3[] = ground === null ? [] : [[x, ground, z]];
          const part = record(
            'support',
            `support-${x}-${z}`,
            true,
            (part) => {
              const result = spec.builders!.support!(part, site, context);
              if (result) footings = result.footings;
            },
            [],
            [[x, deckY, z]],
          );
          // Roots must already exist in the original terrain, never be invented
          // by the component callback to validate its own floating geometry.
          for (const p of footings) {
            if (!p.every(Number.isSafeInteger)) throw new Error('Support footings need integer coordinates');
            if (!fullSupport(world, ...p))
              sink.report(
                coordinateDiagnostic({
                  rule: 'walkway.support-footing',
                  object: spec.id,
                  position: p,
                  message: '自定义支撑柱脚不是现有实体地面',
                  severity: collisionBoxes(world.get(...p)).kind === 'unknown' ? 'unknown' : 'error',
                  conclusive: collisionBoxes(world.get(...p)).kind !== 'unknown',
                }),
              );
          }
          components[components.indexOf(part)] = { ...part, anchors: footings.map((p) => [...p] as Vec3) };
          continue;
        }
        if (ground === null || !fullSupport(world, x, ground, z)) {
          sink.report(
            coordinateDiagnostic({
              rule: 'walkway.support-unknown',
              object: spec.id,
              position: [x, deckY - 1, z],
              severity: 'unknown',
              conclusive: false,
              message: '声明的支点下方没有确认的实体地面',
            }),
          );
          continue;
        }
        const support = { x, z, ground, deckY };
        supports.push(support);
        for (let yy = ground + 1; yy < support.deckY; yy++)
          sink.put(x, yy, z, requiredMaterial(spec.materials.pier, 'pier')([x, yy, z], support), {}, 'road');
      }
      const railing = record(
        'railing',
        'railing',
        !!spec.builders?.railing,
        (part) => {
          if (spec.builders?.railing) return spec.builders.railing(part, context);
          for (const c of railSites.values())
            for (let h = 0; h < railHeight; h++) {
              const p: Vec3 = [c.position[0], c.position[1] + h, c.position[2]];
              const state = requiredMaterial(spec.materials.rail, 'rail')({ ...c, position: p });
              part.put(...p, state, {}, 'road');
            }
        },
        context.edges.map((e) => e.position),
      );
      rails.push(...railing.cells);
      const lightSites = new Set<string>();
      if (spec.lights && spec.materials.light)
        for (const edge of edges.values()) {
          if (edge.step % lightSpacing !== 0) continue;
          const [x, y, z] = edge.position,
            site = key(x, z);
          if (lightSites.has(site)) continue;
          lightSites.add(site);
          if (!edgeSupport(sink, [x, y, z], !!spec.builders?.beams)) {
            sink.report(
              coordinateDiagnostic({
                rule: 'walkway.light-support',
                object: spec.id,
                position: [x, y, z],
                severity: collisionBoxes(sink.get(x, y, z)).kind === 'unknown' ? 'unknown' : 'error',
                conclusive: collisionBoxes(sink.get(x, y, z)).kind !== 'unknown',
                message: '灯具没有实体边梁支撑',
              }),
            );
            continue;
          }
          const light = record(
            'light',
            `light-${x}-${z}`,
            true,
            (part) => spec.materials.light!(part, [x, y + railHeight + 1, z], context),
            [[x, y, z]],
          );
          fixtures.push(...light.cells);
        }
      if (spec.builders?.details) record('details', 'details', true, (part) => spec.builders!.details!(part, context));
      for (const d of walkwayGeometry(sink, {
        id: spec.id,
        road,
        headroom,
        edges: [...edges.values()],
        supports,
        rails,
        fixtures,
        components,
        railSites: context.railSites,
        railHeight,
        openings: context.openings,
      }))
        sink.report(d);
    },
  });
  return {
    id: spec.id,
    road,
    edges: [...edges.values()],
    supports,
    rails,
    fixtures,
    construction,
    headroom,
    components,
    railSites: context.railSites,
    railHeight,
    openings: context.openings,
  };
}
function atPosition(n: number, axis: number, offset: number, coordinate: number) {
  return n + (axis === coordinate ? offset : 0);
}

/** Keep wide bend footprints at one height, retaining caller-defined waypoints. */
function cornerLandings(route: readonly Vec3[], length: number): Vec3[] {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Corner landing must be a nonnegative integer');
  const turns = route.map((p, i) => {
    const a = route[i - 1],
      b = route[i + 1];
    return (
      !!a &&
      !!b &&
      (Math.sign(p[0] - a[0]) !== Math.sign(b[0] - p[0]) || Math.sign(p[2] - a[2]) !== Math.sign(b[2] - p[2]))
    );
  });
  const result: Vec3[] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!,
      b = route[i]!;
    const dx = b[0] - a[0],
      dz = b[2] - a[2],
      distance = Math.abs(dx) + Math.abs(dz);
    if ((dx && dz) || !distance)
      throw new Error('Walkway route needs nonzero axis-aligned segments; supply a road plan for another corridor');
    const left = turns[i - 1] ? length : 0,
      right = turns[i] ? length : 0;
    if (left + right >= distance && a[1] !== b[1]) throw new Error('Walkway slope has no room between corner landings');
    if (i === 1) result.push([...a]);
    if (left && left < distance) result.push([a[0] + Math.sign(dx) * left, a[1], a[2] + Math.sign(dz) * left]);
    if (right && left + right < distance)
      result.push([b[0] - Math.sign(dx) * right, b[1], b[2] - Math.sign(dz) * right]);
    result.push([...b]);
  }
  return result;
}

export function buildWalkway(world: Structure, plan: WalkwayPlan) {
  if (!plan.construction.feasible) throw new DiagnosticError(plan.construction.diagnostics);
  return commitConstruction(world, plan.construction);
}

/** Re-run after all water, landscaping and decoration have changed the final model. */
export function checkWalkway(world: Pick<Structure, 'get'>, plan: WalkwayPlan): Diagnostic[] {
  return mergeDiagnostics([...plan.construction.diagnostics, ...walkwayGeometry(world, plan)]);
}
function walkwayGeometry(world: Pick<Structure, 'get'>, plan: Omit<WalkwayPlan, 'construction'>): Diagnostic[] {
  const findings = [...roadPassability(world, plan.road, { headroom: plan.headroom })];
  const report = (rule: string, p: Vec3, message: string) => {
    const unknown = collisionBoxes(world.get(...p)).kind === 'unknown';
    findings.push(
      coordinateDiagnostic({
        rule,
        object: { kind: 'walkway', id: plan.id },
        position: p,
        severity: unknown ? 'unknown' : 'error',
        conclusive: !unknown,
        message,
        source: 'walkway-final',
      }),
    );
  };
  for (const s of plan.supports)
    for (let y = s.ground; y <= s.deckY; y++)
      if (!fullSupport(world, s.x, y, s.z)) {
        report('walkway.support-gap', [s.x, y, s.z], '声明的支点未从实际柱脚连续接到桥底');
        break;
      }
  for (const edge of plan.edges)
    if (
      !edgeSupport(
        world,
        edge.position,
        plan.components.some((c) => c.kind === 'beams' && c.custom),
      )
    )
      report('walkway.edge-gap', edge.position, '边梁缺失或不能承托栏杆和设施');
  const deckCells = plan.components.filter((c) => c.kind === 'deck').flatMap((c) => c.cells.map((w) => w.position));
  for (const component of plan.components) {
    if (!component.custom) continue;
    const connectors =
      component.kind === 'beams' ? deckCells : component.kind === 'light' ? plan.rails.map((c) => c.position) : [];
    findings.push(...checkWalkwayComponent(world, plan.id, component, connectors));
    if (component.kind === 'support')
      for (const p of component.anchors)
        if (!fullSupport(world, ...p)) report('walkway.support-gap', p, '自定义支撑的实际柱脚缺失或不能承重');
    if (component.kind !== 'deck')
      for (const c of component.cells)
        if (plan.openings.some((b) => contains(b, ...c.position)))
          report('walkway.opening-blocked', c.position, '自定义构件占用了声明的入口开口');
  }
  if (plan.components.some((c) => c.kind === 'railing' && c.custom))
    for (const site of plan.railSites) {
      const [x, y, z] = site.position;
      const covered = plan.rails.some(
        (c) =>
          c.position[0] === x &&
          c.position[2] === z &&
          c.position[1] >= y &&
          c.position[1] < y + plan.railHeight &&
          hasCollision(world, c.position),
      );
      if (!covered)
        report('walkway.railing-gap', site.position, '自定义栏杆未覆盖声明的边界；留空应通过 openings 声明');
    }
  for (const [cells, rule, message] of [
    [plan.rails, 'walkway.railing-gap', '计划中的栏杆缺失'],
    [plan.fixtures, 'walkway.fixture-gap', '计划中的灯具构件缺失'],
  ] as const)
    for (const c of cells) if (world.get(...c.position)?.name !== c.state.name) report(rule, c.position, message);
  if (plan.fixtures.length)
    findings.push(
      ...checkSupport(world, [
        {
          object: { kind: 'walkway-fixtures', id: plan.id },
          cells: plan.fixtures.map((c) => c.position),
          support: 'ground',
        },
      ]),
    );
  return findings;
}
function edgeSupport(world: Pick<Structure, 'get'>, p: Vec3, custom: boolean): boolean {
  if (!custom) return fullSupport(world, ...p);
  const shape = collisionBoxes(world.get(...p));
  return shape.kind === 'supported' && shape.boxes.some((b) => b[4] >= 1);
}
function hasCollision(world: Pick<Structure, 'get'>, p: Vec3): boolean {
  const shape = collisionBoxes(world.get(...p));
  // Unknown shapes are diagnosed by the component check, not declared a gap.
  return shape.kind === 'unknown' || shape.boxes.length > 0;
}
function requiredMaterial<T>(material: T | undefined, name: string): T {
  if (!material)
    throw new Error(`Default walkway geometry requires materials.${name}; supply that material or replace its builder`);
  return material;
}
