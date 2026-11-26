import { contains, type Box, type Vec3 } from '../core/structure.js';
import type { DiagnosticObject } from './diagnostics.js';
import { IDENTITY_TRANSFORM, inverseTransformPosition, transformDirection, transformPosition, type BlockTransform, type FacingIndex } from './transform.js';

/**
 * 场地 / 地块 / 锚点：让建筑用**局部坐标**表达自己，由场地负责换算。
 *
 * 刻意保持轻量——这里不是通用场景图：没有父子层级、没有继承、没有事件，
 * 只有"一个原点 + 一个变换 + 若干地块 + 入口连接"四件事。
 * 局部坐标（0,0,0）永远对应该地块的原点，`localToWorld` 是唯一换算入口。
 */

export type Anchor = Readonly<{
  /** Local position of the anchor (before the lot transform). */
  local: Vec3;
  /** Facing of the anchored edge, in the lot's local frame. */
  facing: FacingIndex;
  /** Human-readable purpose, e.g. `entrance`, `spawn`, `sign`. */
  role: string;
}>;

export type LotInput = Readonly<{
  id: string;
  kind?: string;
  /** Local half-open box, usually negative-to-positive around the origin. */
  bounds: Box;
  /** World position of local (0,0,0). */
  origin: Vec3;
  transform?: BlockTransform;
  /** Owner identity used by protection and diagnostics. */
  owner?: string;
  /** Anchors declared in local coordinates. */
  anchors?: readonly Anchor[];
  note?: string;
}>;

export type Lot = Readonly<{
  id: string;
  kind: string;
  owner: string;
  bounds: Box;
  origin: Vec3;
  transform: BlockTransform;
  anchors: readonly Anchor[];
  note?: string;
  /** Local position -> world position. */
  localToWorld(local: Vec3): Vec3;
  /** World position -> local position (inverse of `localToWorld`). */
  worldToLocal(world: Vec3): Vec3;
  /** Local box -> world box. */
  boundsToWorld(bounds?: Box): Box;
  /** World box -> whether it stays inside this lot. */
  containsLocal(local: Vec3): boolean;
  anchor(role: string): Anchor | null;
  /** Facing after the lot transform: what a neighbouring road must aim at. */
  worldFacing(localFacing: FacingIndex): FacingIndex;
  /**
   * World-space entrance point together with both facings: `facing` is the
   * anchor's local facing as declared, `worldFacing` has the lot transform
   * applied. Keeping both means a rotated lot cannot silently connect in the
   * wrong direction — the caller must state which one it means.
   */
  entrance(): Readonly<{ position: Vec3; facing: FacingIndex; worldFacing: FacingIndex }> | null;
  object(): DiagnosticObject;
}>;

function createLot(input: LotInput): Lot {
  if (!input.id) throw new Error('Lot requires an id');
  if (input.bounds.min.some((value, axis) => value >= input.bounds.max[axis]))
    throw new Error(`Lot ${input.id} has an empty local bounds`);
  const transform = input.transform ?? IDENTITY_TRANSFORM;
  const origin: Vec3 = [...input.origin] as Vec3;
  const kind = input.kind ?? 'lot';
  const owner = input.owner ?? input.id;
  const localToWorld = (local: Vec3): Vec3 => {
    const turned = transformPosition(local, transform);
    return [turned[0] + origin[0], turned[1] + origin[1], turned[2] + origin[2]];
  };
  const worldToLocal = (world: Vec3): Vec3 => {
    // The inverse composes in the opposite order and swaps the mirror axis on a
    // quarter turn; a hand-rolled inverse that kept the mirror silently sent
    // mirrored lots to the wrong quadrant.
    const shifted: Vec3 = [world[0] - origin[0], world[1] - origin[1], world[2] - origin[2]];
    return inverseTransformPosition(shifted, transform);
  };
  const boundsToWorld = (bounds: Box = input.bounds): Box => {
    const corners: Vec3[] = [];
    for (const x of [bounds.min[0], bounds.max[0] - 1])
      for (const y of [bounds.min[1], bounds.max[1] - 1])
        for (const z of [bounds.min[2], bounds.max[2] - 1]) corners.push(localToWorld([x, y, z]));
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const corner of corners)
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], corner[axis]);
        max[axis] = Math.max(max[axis], corner[axis] + 1);
      }
    return { min, max };
  };
  const anchors = Object.freeze((input.anchors ?? []).map((anchor) => Object.freeze({ ...anchor, local: [...anchor.local] as Vec3 })));
  const lot: Lot = {
    id: input.id,
    kind,
    owner,
    bounds: input.bounds,
    origin,
    transform,
    anchors,
    ...(input.note ? { note: input.note } : {}),
    localToWorld,
    worldToLocal,
    boundsToWorld,
    containsLocal: (local) => contains(input.bounds, local[0], local[1], local[2]),
    anchor: (role) => anchors.find((anchor) => anchor.role === role) ?? null,
    worldFacing: (localFacing) => (transformDirection(localFacing, transform) ?? localFacing) as FacingIndex,
    entrance: () => {
      const anchor = anchors.find((candidate) => candidate.role === 'entrance') ?? anchors[0] ?? null;
      if (!anchor) return null;
      return {
        position: localToWorld(anchor.local),
        facing: anchor.facing,
        worldFacing: (transformDirection(anchor.facing, transform) ?? anchor.facing) as FacingIndex,
      };
    },
    object: () => ({ kind, id: input.id, owner }),
  };
  return Object.freeze(lot);
}

export type SiteInput = Readonly<{
  id: string;
  /** Local half-open box of the whole site. */
  bounds: Box;
  /** World origin of the site's local (0,0,0). */
  origin: Vec3;
  transform?: BlockTransform;
  lots?: readonly LotInput[];
  note?: string;
}>;

/**
 * A site is a named frame plus its lots. It carries no geometry of its own —
 * the authoritative voxel model stays in `Structure`.
 */
export class Site {
  readonly id: string;
  readonly bounds: Box;
  readonly origin: Vec3;
  readonly transform: BlockTransform;
  readonly note?: string;
  private readonly lots = new Map<string, Lot>();

  constructor(input: SiteInput) {
    if (!input.id) throw new Error('Site requires an id');
    this.id = input.id;
    this.bounds = input.bounds;
    this.origin = [...input.origin] as Vec3;
    this.transform = input.transform ?? IDENTITY_TRANSFORM;
    this.note = input.note;
    for (const lot of input.lots ?? []) this.addLot({ ...lot, transform: lot.transform ?? this.transform });
  }

  addLot(input: LotInput): Lot {
    if (this.lots.has(input.id)) throw new Error(`Duplicate lot: ${input.id}`);
    const lot = createLot(input);
    this.lots.set(lot.id, lot);
    return lot;
  }

  lot(id: string): Lot | null {
    return this.lots.get(id) ?? null;
  }

  listLots(): Lot[] {
    return [...this.lots.values()];
  }

  /** Local site position -> world position. */
  localToWorld(local: Vec3): Vec3 {
    const turned = transformPosition(local, this.transform);
    return [turned[0] + this.origin[0], turned[1] + this.origin[1], turned[2] + this.origin[2]];
  }

  /** World box of a local site box (defaults to the whole site). */
  boundsToWorld(bounds: Box = this.bounds): Box {
    const corners: Vec3[] = [];
    for (const x of [bounds.min[0], bounds.max[0] - 1])
      for (const y of [bounds.min[1], bounds.max[1] - 1])
        for (const z of [bounds.min[2], bounds.max[2] - 1]) corners.push(this.localToWorld([x, y, z]));
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const corner of corners)
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], corner[axis]);
        max[axis] = Math.max(max[axis], corner[axis] + 1);
      }
    return { min, max };
  }

  /** Lots whose local box covers a local point. */
  lotsAt(local: Vec3): Lot[] {
    return this.listLots().filter((lot) => lot.containsLocal(local));
  }
}

export function site(input: SiteInput): Site {
  return new Site(input);
}
