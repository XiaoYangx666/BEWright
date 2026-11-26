import type { State, Structure, Vec3 } from '../core/structure.js';
import { isWallBlock, wallConnectionsAt } from '../blocks/connections.js';

/** Match a resolved block, allowing only connection states derived by model preparation. */
export function matchesRecordedState(world: Pick<Structure, 'get'>, position: Vec3, expected: State): boolean {
  const actual = world.get(...position);
  if (!actual || actual.name !== expected.name) return false;
  const same = (states: State['states']) =>
    Object.keys(actual.states).length === Object.keys(states).length &&
    Object.entries(states).every(([key, value]) => actual.states[key] === value);
  if (same(expected.states)) return true;
  if (!isWallBlock(actual.name)) return false;
  const connections = wallConnectionsAt(world, ...position);
  const states = { ...expected.states };
  for (const side of ['north', 'east', 'south', 'west'] as const)
    states[`wall_connection_type_${side}`] = connections[side] ? 'short' : 'none';
  states.wall_post_bit = connections.post;
  return same(states);
}
