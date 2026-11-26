import type { State, Structure } from '../../core/structure.js';

export type JavaBlockState = Readonly<{ name: string; properties: Readonly<Record<string, string>> }>;

const fenceRe = /_fence$/;
const fenceGateRe = /_fence_gate$/;
const wallRe = /_wall$/;
const barPaneRe = /(_bars|_pane)$/;

function shortName(name: string) {
  return name.replace(/^minecraft:/, '');
}

/**
 * Whether a block's Java directional connection state (north/east/south/west/up)
 * depends on its neighbours rather than the IR state alone. Fences, walls and
 * bars/panes are connection-typed: Minecraft Java stores the connection
 * explicitly per block, so the exporter must compute it from the surrounding
 * blocks. Fence gates are excluded (they use facing/in_wall instead).
 */
export function isConnectionBlock(name: string): boolean {
  const n = shortName(name);
  return fenceRe.test(n) || wallRe.test(n) || barPaneRe.test(n);
}

/** Blocks a fence/wall connects to horizontally (fences, walls, fence gates). */
function connectsTo(name: string): boolean {
  const n = shortName(name);
  return fenceRe.test(n) || wallRe.test(n) || fenceGateRe.test(n);
}

/** Transparent / non-full blocks that never anchor a fence post or a bar/pane. */
const nonSolidRe =
  /(air|water|lava|_glass$|_pane$|_bars$|_leaves$|_slab$|_stairs$|torch|_torch$|lantern|flower|tall_grass|_grass$|vine|rail|ladder|_sign$|_button$|lever|_door$|_trapdoor$|_fence$|_fence_gate$|_wall$|_chain$|flower_pot|cactus|sugar_cane|bamboo|kelp|seagrass|snow|_sapling$|mushroom|redstone_wire|repeater|comparator|carpet|_plate$)/;

function isOpaque(name: string | null): boolean {
  if (!name) return false;
  const n = shortName(name);
  if (n === 'air') return false;
  return !nonSolidRe.test(n);
}

function isLeaf(name: string): boolean {
  return /_leaves$/.test(name) || name === 'leaves';
}

const horizontal = [
  ['north', 0, -1],
  ['east', 1, 0],
  ['south', 0, 1],
  ['west', -1, 0],
] as const;

/**
 * Fills in the directional connection properties for a connection-typed block
 * based on its neighbours. Only sets a side when the IR state did not already
 * specify it, so scenes that manually wire connections keep their intent.
 */
export function applyConnectionState(
  structure: Structure,
  name: string,
  x: number,
  y: number,
  z: number,
  props: Record<string, string>,
): void {
  const n = shortName(name);
  if (wallRe.test(n)) {
    // A wall connects horizontally to any non-air, non-leaves block. Its `up`
    // is only low (a connector mid-span of a straight railing) when exactly two
    // of the four horizontal sides connect; posts, ends and corners stay high.
    // This fully derives from the actual neighbours, ignoring any hard-coded
    // wall_connection_type/wall_post_bit from the scene.
    let connectedSides = 0;
    for (const [side, dx, dz] of horizontal) {
      const neighbour = structure.get(x + dx, y, z + dz)?.name ?? null;
      const connected = neighbour ? shortName(neighbour) !== 'air' && !isLeaf(shortName(neighbour)) : false;
      if (connected) connectedSides++;
      props[side] = connected ? 'low' : 'none';
    }
    props.up = connectedSides === 2 ? 'false' : 'true';
  } else if (fenceRe.test(n)) {
    let hasHorizontal = false;
    for (const [side, dx, dz] of horizontal) {
      if (props[side] !== undefined) {
        if (props[side] !== 'false' && props[side] !== 'none') hasHorizontal = true;
        continue;
      }
      const neighbour = structure.get(x + dx, y, z + dz)?.name ?? null;
      const connected = neighbour ? connectsTo(neighbour) : false;
      if (connected) hasHorizontal = true;
      props[side] = String(connected);
    }
    if (props.up === undefined) {
      const below = structure.get(x, y - 1, z)?.name ?? null;
      const belowSolid = isOpaque(below) || (below ? connectsTo(below) : false);
      props.up = belowSolid || !hasHorizontal ? 'true' : 'false';
    }
  } else if (barPaneRe.test(n)) {
    for (const [side, dx, dz] of horizontal) {
      if (props[side] !== undefined) continue;
      const neighbour = structure.get(x + dx, y, z + dz)?.name ?? null;
      const connected = neighbour ? barPaneRe.test(shortName(neighbour)) || isOpaque(neighbour) : false;
      props[side] = String(connected);
    }
  }
}

const renamed: Readonly<Record<string, string>> = Object.freeze({
  bed: 'red_bed',
  lit_pumpkin: 'jack_o_lantern',
  melon_block: 'melon',
  reeds: 'sugar_cane',
  web: 'cobweb',
  wooden_button: 'oak_button',
  wooden_door: 'oak_door',
  wooden_pressure_plate: 'oak_pressure_plate',
});

const stairFacing = ['east', 'west', 'south', 'north'] as const;
const facing = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
const javaProperties = new Set([
  'age',
  'axis',
  'bites',
  'candles',
  'delay',
  'distance',
  'down',
  'east',
  'enabled',
  'extended',
  'eye',
  'face',
  'facing',
  'half',
  'hanging',
  'has_book',
  'hatch',
  'hinge',
  'in_wall',
  'layers',
  'level',
  'lit',
  'locked',
  'mode',
  'north',
  'occupied',
  'open',
  'part',
  'persistent',
  'power',
  'powered',
  'rotation',
  'shape',
  'short',
  'signal_fire',
  'snowy',
  'south',
  'stage',
  'thickness',
  'triggered',
  'type',
  'unstable',
  'up',
  'waterlogged',
  'west',
]);

function bool(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Java conversion expected boolean ${key}`);
  return value;
}

function integer(value: unknown, key: string): number {
  if (!Number.isInteger(value)) throw new Error(`Java conversion expected integer ${key}`);
  return value as number;
}

/** Converts the Bedrock-oriented IR state into a Java block-state palette entry. */
export function toJavaBlockState(state: State): JavaBlockState {
  const bedrockName = state.name.replace(/^minecraft:/, '');
  const name = `minecraft:${renamed[bedrockName] ?? bedrockName}`;
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(state.states)) {
    if (javaProperties.has(key)) {
      properties[key] = String(value);
      continue;
    }
    switch (key) {
      case 'deprecated':
        // The pinned Bedrock registry adds a legacy discriminator to bone blocks.
        // Its default 0 has no Java property; preserve the separately mapped axis.
        if (bedrockName !== 'bone_block' || value !== 0)
          throw new Error(`Java conversion does not support Bedrock state ${key}=${value} on ${state.name}`);
        break;
      case 'minecraft:vertical_half':
        properties.type = String(value);
        break;
      case 'upside_down_bit':
        properties.half = bool(value, key) ? 'top' : 'bottom';
        break;
      case 'weirdo_direction': {
        const direction = stairFacing[integer(value, key)];
        if (!direction) throw new Error(`Java conversion cannot map ${key}=${value}`);
        properties.facing = direction;
        properties.shape ??= 'straight';
        properties.waterlogged ??= 'false';
        break;
      }
      case 'minecraft:cardinal_direction':
        properties.facing = String(value);
        break;
      case 'facing_direction': {
        const direction = facing[integer(value, key)];
        if (!direction) throw new Error(`Java conversion cannot map ${key}=${value}`);
        properties.facing = direction;
        break;
      }
      case 'pillar_axis':
        properties.axis = String(value);
        break;
      case 'persistent_bit':
        properties.persistent = String(bool(value, key));
        break;
      case 'update_bit':
        break;
      case 'infiniburn_bit':
        break;
      case 'liquid_depth':
        properties.level = String(integer(value, key));
        break;
      case 'open_bit':
        properties.open = String(bool(value, key));
        break;
      case 'door_hinge_bit':
        properties.hinge = bool(value, key) ? 'right' : 'left';
        break;
      case 'upper_block_bit':
        properties.half = bool(value, key) ? 'upper' : 'lower';
        break;
      case 'ground_sign_direction':
        properties.rotation = String(integer(value, key));
        break;
      case 'head_piece_bit':
        properties.part = bool(value, key) ? 'head' : 'foot';
        break;
      case 'occupied_bit':
        properties.occupied = String(bool(value, key));
        break;
      case 'powered_bit':
        properties.powered = String(bool(value, key));
        break;
      case 'wall_post_bit':
        properties.up = String(bool(value, key));
        break;
      case 'wall_connection_type_north':
      case 'wall_connection_type_south':
      case 'wall_connection_type_east':
      case 'wall_connection_type_west': {
        const side = key.slice('wall_connection_type_'.length);
        properties[side] = value === 'short' ? 'low' : String(value);
        break;
      }
      default:
        throw new Error(`Java conversion does not support Bedrock state ${key} on ${state.name}`);
    }
  }
  if (bedrockName.endsWith('_slab') && !bedrockName.includes('double_')) properties.waterlogged ??= 'false';
  if (bedrockName.endsWith('_stairs')) properties.waterlogged ??= 'false';
  if (bedrockName.endsWith('_wall')) properties.waterlogged ??= 'false';
  if (bedrockName.endsWith('_leaves')) {
    properties.distance ??= '7';
    properties.waterlogged ??= 'false';
  }
  if (bedrockName === 'lantern') properties.waterlogged ??= 'false';
  if (bedrockName === 'water') properties.level ??= '0';
  return Object.freeze({ name, properties: Object.freeze(properties) });
}
