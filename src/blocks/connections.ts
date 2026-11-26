import { block, type Box, type Structure } from '../core/structure.js';

const wallRe = /_wall$/;
const leavesRe = /_leaves$/;
const horizontal = [
  ['north', 0, -1],
  ['east', 1, 0],
  ['south', 0, 1],
  ['west', -1, 0],
] as const;
const connectionSides = ['north', 'east', 'south', 'west'] as const;

export type WallConnections = Readonly<{
  north: boolean;
  east: boolean;
  south: boolean;
  west: boolean;
  post: boolean;
}>;

export function isWallBlock(name: string): boolean {
  return wallRe.test(name.replace(/^minecraft:/, ''));
}

function isLeaf(name: string): boolean {
  return leavesRe.test(name) || name === 'leaves';
}

/**
 * Neighbour-derived wall connections, the Bedrock counterpart of the Java
 * exporter's wall rule in targets/java/blocks.ts: a wall connects to any
 * non-air, non-leaf horizontal neighbour, and only a straight two-sided span
 * drops its full-height post (corners, ends and T-junctions keep the post,
 * which is what both games render for a stored wall_post_bit=false only on
 * straight runs).
 */
export function wallConnectionsAt(structure: Pick<Structure, 'get'>, x: number, y: number, z: number): WallConnections {
  const sides = { north: false, east: false, south: false, west: false };
  for (const [side, dx, dz] of horizontal) {
    const neighbour = structure.get(x + dx, y, z + dz)?.name ?? null;
    sides[side] = neighbour !== null && neighbour !== 'minecraft:air' && !isLeaf(neighbour.replace(/^minecraft:/, ''));
  }
  const straightSpan =
    (sides.north && sides.south && !sides.east && !sides.west) ||
    (sides.east && sides.west && !sides.north && !sides.south);
  return { ...sides, post: !straightSpan };
}

/**
 * Rewrites wall connection states in place from the surrounding blocks.
 * Bedrock walls carry their connections as stored states and direct world
 * writes never trigger the in-game neighbour updates that would derive them,
 * so the IR must hold the derived states before mcstructure export or world
 * placement — otherwise every imported wall renders as an isolated post.
 * Hard-coded wall_connection_type/wall_post_bit are replaced (same policy as
 * the Java exporter). Idempotent; returns the number of changed walls.
 */
export function applyBedrockWallConnections(structure: Structure, region: Box): number {
  const walls: [number, number, number][] = [];
  structure.forEach((x, y, z, id) => {
    if (isWallBlock(structure.palette[id]!.name)) walls.push([x, y, z]);
  }, region);
  let changed = 0;
  for (const [x, y, z] of walls) {
    const state = structure.get(x, y, z)!;
    const connections = wallConnectionsAt(structure, x, y, z);
    const states: Record<string, string | number | boolean> = { ...state.states };
    for (const side of connectionSides) states[`wall_connection_type_${side}`] = connections[side] ? 'short' : 'none';
    states.wall_post_bit = connections.post;
    const unchanged =
      Object.keys(states).length === Object.keys(state.states).length &&
      Object.entries(states).every(([key, value]) => state.states[key] === value);
    if (unchanged) continue;
    structure.set(x, y, z, block(state.name, states));
    changed++;
  }
  return changed;
}
