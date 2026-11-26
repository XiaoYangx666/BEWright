import type { Structure } from '../core/structure.js';

const MODEL_IDENTITY = new WeakMap<Structure, number>();
let nextIdentity = 1;

/**
 * Stable identity token for one model **instance**.
 *
 * `revision` alone cannot tell two models apart: two freshly built structures
 * both sit at revision 0, and a plan computed for one of them must not be
 * applied to the other.
 */
export function structureIdentity(world: Structure): number {
  const existing = MODEL_IDENTITY.get(world);
  if (existing !== undefined) return existing;
  const token = nextIdentity++;
  MODEL_IDENTITY.set(world, token);
  return token;
}
