import type { State, Structure, Vec3 } from '../../core/structure.js';
import type { DiagnosticObject } from '../diagnostic-core.js';
import type { ProtectionRegistry, ProtectionViolation } from '../protection.js';
import { matchProtectionRules, type ProtectionRuleSet } from '../rules.js';

/** Framework rule ids; listed in `docs/authoring.md`. */
export const PLACEMENT_RULES = {
  untransformableState: 'placement.untransformable-state',
  outOfBounds: 'placement.out-of-bounds',
  noSurface: 'placement.no-surface',
  steep: 'placement.slope',
  excavation: 'placement.excavation-too-deep',
  foundation: 'placement.foundation-too-deep',
  overlap: 'placement.occupied',
  protection: 'protection.occupied',
  nothingToPlace: 'placement.empty-candidate',
} as const;

/**
 * The one implementation of "may this operation touch these cells".
 *
 * Placement and the construction plan both call it, so ownership, framework
 * rules and declared protection zones are judged exactly once — a second,
 * independent transaction system would be free to disagree with this one.
 */
export function auditOperationCells(
  world: Structure,
  options: Readonly<{
    object: DiagnosticObject;
    /** Cells the operation writes, in order. */
    writes: readonly { position: Vec3; state: State }[];
    /** Cells the operation clears. */
    carves: readonly Vec3[];
    rules?: ProtectionRuleSet;
    protection?: ProtectionRegistry;
    overlapAllowed?: (existing: State | null, position: Vec3) => boolean;
    /** When supplied, carves obey this ownership predicate too. */
    carveAllowed?: (existing: State | null, position: Vec3) => boolean;
    /** The operation holds excavation authority, so occupied cells are its own cut. */
    excavationAuthorized?: boolean;
  }>,
): Readonly<{ violations: ProtectionViolation[]; overlaps: Vec3[] }> {
  const object = options.object;
  const overlaps: Vec3[] = [];
  if (!options.excavationAuthorized)
    for (const write of options.writes) {
      const existing = world.get(write.position[0], write.position[1], write.position[2]);
      if (!existing || existing.name === 'minecraft:air') continue;
      if (
        existing.name === write.state.name &&
        Object.keys(existing.states).length === Object.keys(write.state.states).length &&
        Object.entries(existing.states).every(([key, value]) => write.state.states[key] === value)
      )
        continue;
      if (options.overlapAllowed?.(existing, write.position)) continue;
      overlaps.push(write.position);
    }
  if (!options.excavationAuthorized && options.carveAllowed)
    for (const position of options.carves) {
      const existing = world.get(...position);
      if (existing && existing.name !== 'minecraft:air' && !options.carveAllowed(existing, position))
        overlaps.push(position);
    }

  const violations: ProtectionViolation[] = [];
  if (options.rules?.length) {
    const rule = matchProtectionRules(options.rules, object);
    if (rule) {
      for (const entry of [...options.writes.map((write) => write.position), ...options.carves]) {
        const existing = world.get(entry[0], entry[1], entry[2]);
        if (!rule.blocks(existing, entry)) continue;
        violations.push({
          cell: [...entry] as Vec3,
          reason: 'not-allowed',
          zone: {
            id: `rule:${object.id}`,
            kind: 'rule',
            owner: rule.owner ?? 'framework',
            region: { min: [...entry] as Vec3, max: [entry[0] + 1, entry[1] + 1, entry[2] + 1] as Vec3 },
            note: rule.reason,
          },
          block: existing,
        });
      }
    }
  }
  if (options.protection) {
    // A component may contain both allowed and forbidden materials. Each
    // occupation must carry its own state; the first block cannot speak for all.
    const groups = new Map<State, Vec3[]>();
    for (const write of options.writes) {
      const cells = groups.get(write.state) ?? [];
      cells.push(write.position);
      groups.set(write.state, cells);
    }
    for (const [state, cells] of groups)
      violations.push(...options.protection.check(world, { kind: 'object', object, state, cells }));
    if (options.carves.length)
      violations.push(
        ...options.protection.check(world, { kind: 'terrain', object, state: null, cells: options.carves }),
      );
  }
  return { violations, overlaps };
}
