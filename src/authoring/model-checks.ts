import { AIR, block, type State, type Structure, type Vec3 } from '../core/structure.js';
import {
  coordinateDiagnostic,
  mergeDiagnostics,
  DiagnosticError,
  type Diagnostic,
  type DiagnosticObject,
} from './diagnostic-core.js';
import type { ProtectionRegistry } from './protection.js';
import { matchesRecordedState } from './recorded-geometry.js';
import type { ConstructionRole } from './construction.js';

export type AuthoringCheck = (world: Structure) => readonly Diagnostic[];
type Claim = Readonly<{ position: Vec3; state: State; object: DiagnosticObject; role: ConstructionRole }>;
type Checks = {
  protection: ProtectionRegistry;
  callbacks: Map<string, AuthoringCheck>;
  claims: Map<string, Claim>;
  diagnostics: Diagnostic[];
};
const records = new WeakMap<Structure, Checks>();

/** Metadata and assertions attached to the one authoritative voxel model. */
export function attachAuthoringChecks(world: Structure, protection: ProtectionRegistry): void {
  if (records.has(world)) throw new Error('This structure already belongs to an authoring scene');
  records.set(world, { protection, callbacks: new Map(), claims: new Map(), diagnostics: [] });
}

export function authoredProtection(world: Structure): ProtectionRegistry | undefined {
  return records.get(world)?.protection;
}

export function hasAuthoringChecks(world: Structure): boolean {
  return records.has(world);
}

/** Ownership distinguishes authored stonework from natural stone. */
export function authoredCellRole(world: Structure, position: Vec3): ConstructionRole | undefined {
  return records.get(world)?.claims.get(position.join(','))?.role;
}

export function registerAuthoringCheck(world: Structure, id: string, check: AuthoringCheck): void {
  const entry = records.get(world);
  if (!entry) throw new Error('Register checks through an authoring scene');
  if (entry.callbacks.has(id)) throw new Error(`Duplicate authoring check: ${id}`);
  entry.callbacks.set(id, check);
}

/** Later intentional scene operations acquire the cells they replace. Semantic checks remain. */
export function recordAuthoringPlan(
  world: Structure,
  plan: Readonly<{
    object: DiagnosticObject;
    writes: readonly Readonly<{ position: Vec3; state: State; role?: ConstructionRole }>[];
    carves: readonly Readonly<{ position: Vec3 }>[];
    diagnostics: readonly Diagnostic[];
  }>,
): void {
  const entry = records.get(world);
  if (!entry) throw new Error('Record plans through an authoring scene');
  const object = Object.freeze({ ...plan.object });
  const snapshots = new Map<State, State>();
  for (const cell of [...plan.writes, ...plan.carves.map((carve) => ({ ...carve, state: AIR }))]) {
    let state = snapshots.get(cell.state);
    if (!state) {
      state =
        Object.isFrozen(cell.state) && Object.isFrozen(cell.state.states)
          ? cell.state
          : block(cell.state.name, cell.state.states);
      snapshots.set(cell.state, state);
    }
    entry.claims.set(cell.position.join(','), {
      position: [...cell.position] as Vec3,
      state,
      object,
      role: 'role' in cell ? (cell.role ?? 'object') : 'object',
    });
  }
  entry.diagnostics.push(...plan.diagnostics.filter((d) => d.severity === 'warning' || d.severity === 'info'));
}

/** Final checks never regenerate geometry or execute material callbacks. */
export function checkAuthoredModel(world: Structure): Diagnostic[] {
  const entry = records.get(world);
  if (!entry) return [];
  const findings = [...entry.diagnostics];
  for (const cell of entry.claims.values()) {
    if (!matchesRecordedState(world, cell.position, cell.state))
      findings.push(
        coordinateDiagnostic({
          rule: 'authoring.changed-cell',
          object: cell.object,
          position: cell.position,
          message: `最终模型与构件记录不符，期望 ${cell.state.name} 及其状态`,
          source: 'authoring-final',
        }),
      );
  }
  for (const [id, check] of entry.callbacks) {
    try {
      findings.push(...check(world));
    } catch (error) {
      if (error instanceof DiagnosticError) findings.push(...error.diagnostics);
      else
        findings.push(
          coordinateDiagnostic({
            rule: 'authoring.check-failed',
            object: id,
            message: error instanceof Error ? error.message : String(error),
            source: 'authoring-final',
          }),
        );
    }
  }
  return mergeDiagnostics(findings);
}
