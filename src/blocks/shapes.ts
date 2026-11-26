import { validateBlockState } from './registry.js';
import { type State, type Vec3 } from '../core/structure.js';
export type Cuboid = [number, number, number, number, number, number];
import { materials, materialName } from './materials.js';
export { colors } from './materials.js';
export const kind = materialName;
export function fullCube(s: State | null) {
  return !!s && materials[kind(s)]?.geometry === 'cube';
}
/** High-level quarter added to a stair that meets a perpendicular stair. */
function stairWing(d: number, nd: number, y0: number, y1: number): Cuboid {
  if (d === 0) return [0, y0, nd === 2 ? 0.5 : 0, 0.5, y1, nd === 2 ? 1 : 0.5];
  if (d === 1) return [0.5, y0, nd === 2 ? 0.5 : 0, 1, y1, nd === 2 ? 1 : 0.5];
  if (d === 2) return [nd === 0 ? 0.5 : 0, y0, 0, nd === 0 ? 1 : 0.5, y1, 0.5];
  return [nd === 0 ? 0.5 : 0, y0, 0.5, nd === 0 ? 1 : 0.5, y1, 1];
}
/** Supported models only; visualGeometry handles explicit diagnostic placeholders. */
function supportedBoxes(s: State, neighbor: (delta: Vec3) => State | null): Cuboid[] {
  const k = kind(s);
  validateVisual(s);
  if (k === 'air') return [];
  if (fullCube(s)) return [[0, 0, 0, 1, 1, 1]];
  if (materials[k].geometry === 'chain') {
    const axis = s.states.pillar_axis;
    return [
      axis === 'x'
        ? [0, 0.40625, 0.40625, 1, 0.59375, 0.59375]
        : axis === 'z'
          ? [0.40625, 0.40625, 0, 0.59375, 0.59375, 1]
          : [0.40625, 0, 0.40625, 0.59375, 1, 0.59375],
    ];
  }
  if (materials[k].geometry === 'pot')
    return [
      [0.3125, 0, 0.3125, 0.6875, 0.0625, 0.6875],
      [0.3125, 0.0625, 0.3125, 0.375, 0.375, 0.6875],
      [0.625, 0.0625, 0.3125, 0.6875, 0.375, 0.6875],
      [0.375, 0.0625, 0.3125, 0.625, 0.375, 0.375],
      [0.375, 0.0625, 0.625, 0.625, 0.375, 0.6875],
    ];
  if (materials[k].geometry === 'shrub')
    return [
      [0.375, 0, 0.375, 0.625, 0.5, 0.625],
      [0, 0.5, 0, 1, 1, 1],
    ];
  if (materials[k].geometry === 'flower')
    return [
      [0.46, 0, 0.46, 0.54, 0.55, 0.54],
      [0.22, 0.32, 0.44, 0.5, 0.4, 0.56],
      [0.3, 0.48, 0.3, 0.7, 0.65, 0.7],
    ];
  if (materials[k].geometry === 'lantern') {
    const lift = s.states.hanging === true ? 0.125 : 0;
    return [
      [0.3125, lift, 0.3125, 0.6875, lift + 0.125, 0.6875],
      [0.3125, lift + 0.125, 0.3125, 0.6875, lift + 0.5, 0.6875],
      [0.3125, lift + 0.5, 0.3125, 0.6875, lift + 0.5625, 0.6875],
      [0.4375, lift + 0.5625, 0.4375, 0.5625, s.states.hanging === true ? 1 : 0.75, 0.5625],
    ];
  }
  if (materials[k].geometry === 'wall') {
    const result: Cuboid[] = [];
    if (s.states.wall_post_bit === true) result.push([0.25, 0, 0.25, 0.75, 1, 0.75]);
    for (const [direction, dx, dz] of [
      ['east', 1, 0],
      ['west', -1, 0],
      ['south', 0, 1],
      ['north', 0, -1],
    ] as const) {
      const value = s.states[`wall_connection_type_${direction}`];
      if (value === 'none') continue;
      const h = value === 'tall' ? 1 : 0.875;
      result.push(
        dx
          ? [dx < 0 ? 0 : 0.5, 0, 0.3125, dx < 0 ? 0.5 : 1, h, 0.6875]
          : [0.3125, 0, dz < 0 ? 0 : 0.5, 0.6875, h, dz < 0 ? 0.5 : 1],
      );
    }
    return result;
  }
  if (materials[k].geometry === 'foliage')
    return [
      [0.08, 0.08, 0.08, 0.92, 0.92, 0.92],
      [0, 0.3, 0.32, 1, 0.7, 0.68],
      [0.32, 0, 0.3, 0.68, 1, 0.7],
      [0.3, 0.32, 0, 0.7, 0.68, 1],
    ];
  if (materials[k].geometry === 'plant')
    return [
      [0.1, 0, 0.46, 0.9, 0.7, 0.54],
      [0.46, 0, 0.1, 0.54, 0.7, 0.9],
    ];
  if (materials[k].geometry === 'crop') {
    const growth = Number(s.states.growth ?? s.states.age ?? 0);
    const h = 0.2 + (Math.min(7, Math.max(0, growth)) / 7) * 0.8;
    return [
      [0.1, 0, 0.46, 0.9, h, 0.54],
      [0.46, 0, 0.1, 0.54, h, 0.9],
    ];
  }
  if (materials[k].geometry === 'farmland') return [[0, 0, 0, 1, 0.9375, 1]];
  if (materials[k].geometry === 'carpet') return [[0, 0, 0, 1, 0.0625, 1]];
  if (materials[k].geometry === 'snow') {
    const height = Math.min(7, Math.max(0, Number(s.states.height ?? 0)));
    return [[0, 0, 0, 1, (height + 1) / 8, 1]];
  }
  if (materials[k].geometry === 'pad') return [[0, 0, 0, 1, 0.0625, 1]];
  if (materials[k].geometry === 'door') {
    const dir = String(s.states['minecraft:cardinal_direction']);
    const open = s.states.open_bit === true;
    const hinge = s.states.door_hinge_bit === true;
    const T = 0.1875; // 3/16 panel thickness
    // Closed: the panel sits against the facing edge. Open: it swings 90°
    // onto the hinge side.
    const axis: 0 | 2 = open
      ? dir === 'north' || dir === 'south'
        ? 0
        : 2
      : dir === 'north' || dir === 'south'
        ? 2
        : 0;
    const side = open ? (hinge ? 1 : 0) : dir === 'north' || dir === 'west' ? 0 : 1;
    const slab: Cuboid =
      axis === 2
        ? [0, 0, side === 0 ? 0 : 1 - T, 1, 1, side === 0 ? T : 1]
        : [side === 0 ? 0 : 1 - T, 0, 0, side === 0 ? T : 1, 1, 1];
    if (s.states.upper_block_bit !== true) return [slab];
    // Upper half reads as a glazed panel: hollow frame inside the same slab.
    const [x0, , z0, x1, , z1] = slab,
      rail = 0.1875;
    return axis === 2
      ? [
          [x0, 0, z0, x1, rail, z1],
          [x0, 1 - rail, z0, x1, 1, z1],
          [x0, rail, z0, rail, 1 - rail, z1],
          [1 - rail, rail, z0, x1, 1 - rail, z1],
        ]
      : [
          [x0, 0, z0, x1, rail, z1],
          [x0, 1 - rail, z0, x1, 1, z1],
          [x0, rail, z0, x1, 1 - rail, rail],
          [x0, rail, 1 - rail, x1, 1 - rail, z1],
        ];
  }
  if (materials[k].geometry === 'trapdoor') {
    if (s.states.open_bit === true) {
      const d = Number(s.states.direction);
      return [
        d === 0
          ? [0, 0, 0.8125, 1, 1, 1]
          : d === 1
            ? [0, 0, 0, 1, 1, 0.1875]
            : d === 2
              ? [0.8125, 0, 0, 1, 1, 1]
              : [0, 0, 0, 0.1875, 1, 1],
      ];
    }
    return s.states.upside_down_bit === true ? [[0, 0.8125, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.1875, 1]];
  }
  if (materials[k].geometry === 'fence_gate') {
    const dir = String(s.states['minecraft:cardinal_direction']);
    let alongX = dir === 'east' || dir === 'west';
    if (s.states.open_bit === true) alongX = !alongX;
    return alongX
      ? [
          [0, 0, 0.375, 0.125, 1, 0.625],
          [0.875, 0, 0.375, 1, 1, 0.625],
          [0, 0.375, 0.4375, 1, 0.5, 0.5625],
          [0, 0.75, 0.4375, 1, 0.875, 0.5625],
        ]
      : [
          [0.375, 0, 0, 0.625, 1, 0.125],
          [0.375, 0, 0.875, 0.625, 1, 1],
          [0.4375, 0.375, 0, 0.5625, 0.5, 1],
          [0.4375, 0.75, 0, 0.5625, 0.875, 1],
        ];
  }
  if (materials[k].geometry === 'button') {
    switch (Number(s.states.facing_direction)) {
      case 0:
        return [[0.375, 0, 0.375, 0.625, 0.125, 0.625]];
      case 1:
        return [[0.375, 0.875, 0.375, 0.625, 1, 0.625]];
      case 2:
        return [[0.375, 0.375, 0, 0.625, 0.625, 0.125]];
      case 3:
        return [[0.375, 0.375, 0.875, 0.625, 0.625, 1]];
      case 4:
        return [[0, 0.375, 0.375, 0.125, 0.625, 0.625]];
      default:
        return [[0.875, 0.375, 0.375, 1, 0.625, 0.625]];
    }
  }
  if (materials[k].geometry === 'pressure_plate') return [[0.0625, 0, 0.0625, 0.9375, 0.0625, 0.9375]];
  if (materials[k].geometry === 'sapling')
    return [
      [0.25, 0, 0.25, 0.75, 0.5, 0.75],
      [0.44, 0, 0.44, 0.56, 0.75, 0.56],
    ];
  if (materials[k].geometry === 'candle') {
    const count = Math.min(4, Math.max(1, Number(s.states.candles ?? 1)));
    const r = 0.125,
      at = (x: number, z: number): Cuboid => [x - r, 0, z - r, x + r, 0.375, z + r];
    if (count === 1) return [at(0.5, 0.5)];
    if (count === 2) return [at(0.375, 0.375), at(0.625, 0.625)];
    if (count === 3) return [at(0.375, 0.375), at(0.625, 0.375), at(0.5, 0.625)];
    return [at(0.375, 0.375), at(0.625, 0.375), at(0.375, 0.625), at(0.625, 0.625)];
  }
  if (materials[k].geometry === 'sign') {
    if (s.states.ground_sign_direction !== undefined) {
      const quadrant = Math.floor(Number(s.states.ground_sign_direction ?? 0) / 4) % 4;
      const board: Cuboid =
        quadrant % 2 === 0
          ? [0.0625, 0.4375, 0.4375, 0.9375, 0.9375, 0.5625]
          : [0.4375, 0.4375, 0.0625, 0.5625, 0.9375, 0.9375];
      return [[0.4375, 0, 0.4375, 0.5625, 0.4375, 0.5625], board];
    }
    if (s.states.hanging !== undefined)
      return [
        [0.0625, 0.375, 0.4375, 0.9375, 0.875, 0.5625],
        [0.4375, 0.875, 0.4375, 0.5625, 1, 0.5625],
      ];
    switch (Number(s.states.facing_direction)) {
      case 2:
        return [[0.0625, 0.25, 0, 0.9375, 0.75, 0.125]];
      case 3:
        return [[0.0625, 0.25, 0.875, 0.9375, 0.75, 1]];
      case 4:
        return [[0, 0.25, 0.0625, 0.125, 0.75, 0.9375]];
      default:
        return [[0.875, 0.25, 0.0625, 1, 0.75, 0.9375]];
    }
  }
  if (materials[k].geometry === 'glass') return [[0.04, 0.04, 0.04, 0.96, 0.96, 0.96]];
  if (materials[k].geometry === 'water') {
    const depth = Number(s.states.liquid_depth ?? 0);
    // Depth 8 and above denotes falling water, which fills the vertical cell.
    const height = depth >= 8 ? 1 : Math.max(0.125, 1 - (depth / 8) * 0.75);
    return [[0, 0, 0, 1, height, 1]];
  }
  if (materials[k].geometry === 'bed') {
    const boxes: Cuboid[] = [[0, 0, 0, 1, 0.5625, 1]];
    if (s.states.head_piece_bit === true) {
      const d = Number(s.states.direction),
        pillow: Cuboid =
          d === 0
            ? [0.08, 0.5625, 0.12, 0.42, 0.7, 0.88]
            : d === 1
              ? [0.58, 0.5625, 0.12, 0.92, 0.7, 0.88]
              : d === 2
                ? [0.12, 0.5625, 0.08, 0.88, 0.7, 0.42]
                : [0.12, 0.5625, 0.58, 0.88, 0.7, 0.92];
      boxes.push(pillow);
    }
    return boxes;
  }
  if (materials[k].geometry === 'bookshelf')
    return [
      [0, 0, 0, 1, 0.12, 1],
      [0, 0.44, 0, 1, 0.56, 1],
      [0, 0.88, 0, 1, 1, 1],
      [0, 0, 0, 0.12, 1, 1],
      [0.88, 0, 0, 1, 1, 1],
      [0.31, 0.12, 0.08, 0.4, 0.88, 0.92],
      [0.62, 0.12, 0.08, 0.71, 0.88, 0.92],
    ];
  if (materials[k].geometry === 'barrel')
    return [
      [0.08, 0, 0.08, 0.92, 1, 0.92],
      [0, 0.1, 0, 1, 0.23, 1],
      [0, 0.77, 0, 1, 0.9, 1],
    ];
  if (materials[k].geometry === 'slab')
    return s.states['minecraft:vertical_half'] === 'top' ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.5, 1]];
  if (materials[k].geometry === 'stairs') {
    const up = s.states.upside_down_bit === true;
    const y0 = up ? 0 : 0.5,
      y1 = up ? 0.5 : 1;
    const result: Cuboid[] = [[0, up ? 0.5 : 0, 0, 1, up ? 1 : 0.5, 1]];
    const d = Number(s.states.weirdo_direction);
    const high: Cuboid =
      d === 0
        ? [0.5, y0, 0, 1, y1, 1]
        : d === 1
          ? [0, y0, 0, 0.5, y1, 1]
          : d === 2
            ? [0, y0, 0.5, 1, y1, 1]
            : d === 3
              ? [0, y0, 0, 1, y1, 0.5]
              : (() => {
                  throw new Error('Invalid stair direction');
                })();
    result.push(high);
    // A perpendicular stair in front/behind turns this step into an L: extend
    // the high surface onto the neighbour's side so corners stop being markers.
    const axis = d < 2 ? 0 : 2;
    for (const sign of [-1, 1] as const) {
      const delta: Vec3 = [0, 0, 0];
      delta[axis] = sign;
      const n = neighbor(delta);
      if (!n || materials[kind(n)].geometry !== 'stairs') continue;
      if (n.states.upside_down_bit !== s.states.upside_down_bit) continue;
      const nd = Number(n.states.weirdo_direction);
      if ((nd < 2 ? 0 : 2) === axis) continue;
      result.push(stairWing(d, nd, y0, y1));
    }
    return result;
  }
  if (materials[k].geometry === 'fence') {
    const result: Cuboid[] = [[0.375, 0, 0.375, 0.625, 1, 0.625]];
    for (const [dx, dz] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const n = neighbor([dx, 0, dz]);
      if (!n || !(fullCube(n) || kind(n) === k)) continue;
      for (const y of [0.375, 0.75])
        result.push(
          dx
            ? [dx < 0 ? 0 : 0.5, y, 0.4375, dx < 0 ? 0.5 : 1, y + 0.125, 0.5625]
            : [0.4375, y, dz < 0 ? 0 : 0.5, 0.5625, y + 0.125, dz < 0 ? 0.5 : 1],
        );
    }
    return result;
  }
  throw new Error(`No POC visual model: ${s.name}`);
}

export const validateVisual = validateBlockState;
/** Diagnostic glyph, not a visual approximation or collision box. */
const marker: Cuboid[] = [
  [0.05, 0.42, 0.42, 0.95, 0.58, 0.58],
  [0.42, 0.05, 0.42, 0.58, 0.95, 0.58],
  [0.42, 0.42, 0.05, 0.58, 0.58, 0.95],
  [0.3, 0.3, 0.3, 0.7, 0.7, 0.7],
];
export function visualGeometry(
  s: State,
  neighbor: (delta: Vec3) => State | null,
): { boxes: Cuboid[]; placeholder?: string; boxColors?: readonly string[] } {
  validateVisual(s);
  const reason = materials[kind(s)].geometry === 'placeholder' ? materials[kind(s)].reason : undefined;
  if (reason) return { boxes: marker.map((b) => [...b]), placeholder: reason };
  const result = { boxes: supportedBoxes(s, neighbor) } as { boxes: Cuboid[]; boxColors?: readonly string[] };
  if (materials[kind(s)].geometry === 'flower') result.boxColors = ['#518445', '#518445', materials[kind(s)].color];
  if (materials[kind(s)].geometry === 'lantern') result.boxColors = ['#514a40', '#edbb68', '#514a40', '#514a40'];
  if (materials[kind(s)].geometry === 'bookshelf')
    result.boxColors = ['#68472f', '#68472f', '#68472f', '#704a30', '#704a30', '#8e3e35', '#3f587a'];
  if (materials[kind(s)].geometry === 'barrel') result.boxColors = ['#765238', '#3f3935', '#3f3935'];
  if (materials[kind(s)].geometry === 'bed') result.boxColors = result.boxes.map((_, i) => (i ? '#d8d5c9' : '#3d3034'));
  return result;
}
export function boxes(s: State, neighbor: (delta: Vec3) => State | null): Cuboid[] {
  return visualGeometry(s, neighbor).boxes;
}
