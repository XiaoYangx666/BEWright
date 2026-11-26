import type { Vec3 } from '../core/structure.js';
import { type AuthoringMaterial, type BlockKit } from './kit.js';
import { assertPoint, assertRect, type RectXZ } from './layout.js';

export type RailCell = Readonly<{ position: Vec3; distance: number; corner: boolean; end: boolean; post: boolean }>;
export type RailingSpec = Readonly<{
  /** Axis-aligned XZ segments; Y may slope along each segment. */
  path: readonly Vec3[];
  closed?: boolean;
  postEvery?: number;
  phase?: number;
  cornerPosts?: boolean;
  endPosts?: boolean;
  /** Inclusive distances along the entire path. Gaps do not reset the rhythm. */
  gaps?: readonly (readonly [number, number])[];
  omit?: (cell: RailCell) => boolean;
}>;
export type RailingStyle = Readonly<{
  post: AuthoringMaterial;
  panel: AuthoringMaterial;
  cap?: AuthoringMaterial;
  height?: number;
  /** Replace only the post/panel construction, retaining layout and gaps. */
  place?: (kit: BlockKit, cell: RailCell) => void;
}>;
export function rectanglePath(rect: RectXZ, y: number): Vec3[] {
  assertRect(rect);
  return [
    [rect.x0, y, rect.z0],
    [rect.x1, y, rect.z0],
    [rect.x1, y, rect.z1],
    [rect.x0, y, rect.z1],
  ];
}
export function planRailing(spec: RailingSpec): RailCell[] {
  const every = spec.postEvery ?? 4,
    phase = spec.phase ?? 0;
  if (!Number.isSafeInteger(every) || every < 1 || !Number.isSafeInteger(phase))
    throw new Error('Invalid railing interval/phase');
  if (spec.path.length < 2) throw new Error('Railing needs at least two points');
  spec.path.forEach(assertPoint);
  for (const [a, b] of spec.gaps ?? [])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > b) throw new Error('Invalid railing gap');
  const points = [...spec.path];
  if (spec.closed && points[0].some((v, a) => v !== points.at(-1)![a])) points.push(points[0]);
  const cells: RailCell[] = [],
    seen = new Set<string>();
  // A corner is a change of segment direction at a vertex. Merely arriving
  // at a vertex is insufficient: straight-through control points must retain
  // the regular post rhythm.
  const direction = (a: Vec3, b: Vec3) => {
    const dx = Math.sign(b[0] - a[0]);
    const dz = Math.sign(b[2] - a[2]);
    return `${dx},${dz}`;
  };
  const isCorner = (vertex: number) => {
    if (!spec.closed && (vertex === 0 || vertex === points.length - 1)) return false;
    const previous = vertex === 0 ? points.length - 2 : vertex - 1;
    const next = vertex === points.length - 1 ? 0 : vertex;
    return direction(points[previous]!, points[vertex]!) !== direction(points[vertex]!, points[next + 1]!);
  };
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const dx = b[0] - a[0],
      dz = b[2] - a[2],
      length = Math.abs(dx) + Math.abs(dz);
    if ((dx && dz) || !length) throw new Error('Railing requires nonzero axis-aligned XZ segments');
    if (Math.abs(b[1] - a[1]) > length) throw new Error('Railing rises more than one block per step');
    for (let n = 0; n <= length; n++) {
      const position: Vec3 = [
        a[0] + Math.sign(dx) * n,
        Math.round(a[1] + ((b[1] - a[1]) * n) / length),
        a[2] + Math.sign(dz) * n,
      ];
      const key = position.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const corner = (n === 0 && isCorner(i - 1)) || (n === length && isCorner(i));
      const end = !spec.closed && ((i === 1 && n === 0) || (i === points.length - 1 && n === length));
      const d = distance + n;
      const cell: RailCell = {
        position,
        distance: d,
        corner,
        end,
        post: (d - phase) % every === 0 || (corner && spec.cornerPosts !== false) || (end && spec.endPosts !== false),
      };
      if (!(spec.gaps ?? []).some(([from, to]) => d >= from && d <= to) && !spec.omit?.(cell)) cells.push(cell);
    }
    distance += length;
  }
  return cells;
}
export function railing(kit: BlockKit, spec: RailingSpec, style: RailingStyle) {
  const height = style.height ?? 1;
  if (!Number.isSafeInteger(height) || height < 1) throw new Error('Railing height must be a positive integer');
  const cells = planRailing(spec);
  for (const cell of cells) {
    if (style.place) {
      style.place(kit, cell);
      continue;
    }
    const [x, y, z] = cell.position;
    kit.fill(x, y, z, x, y + height - 1, z, cell.post ? style.post : style.panel);
    if (cell.post && style.cap) kit.put(x, y + height, z, style.cap);
  }
  return cells;
}
