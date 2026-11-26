import { performance } from 'node:perf_hooks';
import { buildModel, prepareModel } from './model.js';
import type { Components } from '../core/components.js';
import type { Box } from '../core/structure.js';
import {
  DiagnosticSink,
  countSeverities,
  coordinateDiagnostic,
  isDiagnosticError,
  mergeDiagnostics,
  normalizeCheckResult,
  worstSeverity,
  type BuildingCheckResult,
  type Diagnostic,
  type Severity,
} from '../authoring/diagnostics.js';
import { toLegacyMeshDiagnostics } from '../authoring/diagnostic-adapters.js';
import { ProtectionRegistry } from '../authoring/protection.js';
import { SurfaceQuery } from '../authoring/surface.js';
import { modelIssues } from '../authoring/reachability.js';
import { authoredProtection, hasAuthoringChecks, checkAuthoredModel } from '../authoring/model-checks.js';
import { resolveBuildingArgs, type BuildingArgs, type BuildingDefinition, type BuildingModel } from './definition.js';
import type { LoadedBuilding } from './load.js';

/**
 * 生成模型并跑诊断。`bewright check` 与 `bewright build` 都走这一条路径，
 * 保证"检查的就是这一次生成的模型"，不做二次生成、不依赖生成时的乐观判断。
 */

export type GeneratedModel = Readonly<{
  model: BuildingModel;
  world: import('../core/structure.js').Structure;
  components: Components | null;
  args: BuildingArgs;
  bounds: Box;
  inspect: ReturnType<import('../core/structure.js').Structure['inspect']>;
  surfaces: SurfaceQuery;
  protection: ProtectionRegistry;
  /** Model-stage diagnostics: standard invariants + whatever generation reported. */
  diagnostics: readonly Diagnostic[];
  generateMs: number;
}>;

export type ModelCheckRequest = Readonly<{
  args?: BuildingArgs;
  /** Run registered authoring checks and the building's own check(); on by default. */
  check?: boolean;
  /** Weights are for diagnostics only; nothing is thrown out of here. */
  minOccupied?: number;
  label?: string;
  /** Replaces the declared protection contracts (rarely needed). */
  protection?: ProtectionRegistry;
}>;

export type ModelCheckSummary = Readonly<{
  /** `not-run` means the check never executed — never report that as a pass. */
  status: 'passed' | 'failed' | 'none' | 'not-run';
  executed: boolean;
  severity: Severity | null;
  rule: string | null;
  message: string | null;
  counts: Readonly<Record<Severity, number>>;
  diagnostics: readonly Diagnostic[];
  ms: number;
}>;

/** Strings the framework itself emits for "cannot decide" conditions. */
const UNKNOWN_HINTS = [/collision shape not supported/, /unknown/i, /无法判定/, /not supported/];

/**
 * Classify a thrown building check failure.
 *
 * A failure means the check **ran and reported a problem**, so the default is
 * `error`. It only becomes `unknown` when the message itself says the framework
 * could not decide (unsupported collision geometry, unknown block state) — the
 * distinction matters because "could not determine" must not read as "failed".
 */
export function severityFromError(error: unknown): Severity {
  const message = error instanceof Error ? error.message : String(error);
  return UNKNOWN_HINTS.some((pattern) => pattern.test(message)) ? 'unknown' : 'error';
}

/** Standard model invariants for one generated world (rule ids prefixed `model.`). */
export function modelDiagnostics(
  world: import('../core/structure.js').Structure,
  bounds: Box,
  options: Readonly<{ minOccupied?: number; label?: string }> = {},
): Diagnostic[] {
  return modelIssues(world, bounds, {
    ...(options.minOccupied === undefined ? {} : { minOccupied: options.minOccupied }),
    ...(options.label ? { label: options.label } : {}),
  });
}

export function createProtection(_world: import('../core/structure.js').Structure, bounds: Box) {
  return new ProtectionRegistry(bounds, {});
}

export function createSurfaces(world: import('../core/structure.js').Structure) {
  return new SurfaceQuery(world);
}

/** 生成模型：只做生成、连接状态推导与诊断，不网格化、不导出、不写世界。 */
export function generateModel(
  definition: BuildingDefinition,
  request: ModelCheckRequest = {},
  /** Internal per-command source reuse; the ordinary public two-argument call is unchanged. */
  generate: typeof buildModel = buildModel,
): GeneratedModel {
  const args = request.args ?? resolveBuildingArgs(definition.params);
  const bounds = definition.bounds;
  const started = performance.now();
  const { model, world, components } = generate(definition, args);
  // Wall connection state is derived before anything reads geometry: the check
  // must see the same model the export would see.
  prepareModel(world, bounds, { connections: 'bedrock' });
  const inspect = world.inspect();
  const surfaces = createSurfaces(world);
  const protection = request.protection ?? authoredProtection(world) ?? createProtection(world, bounds);
  const diagnostics = modelDiagnostics(world, bounds, {
    ...(request.minOccupied === undefined ? {} : { minOccupied: request.minOccupied }),
    ...(request.label ? { label: request.label } : {}),
  });
  return {
    model,
    world,
    components,
    args,
    bounds,
    inspect,
    surfaces,
    protection,
    diagnostics,
    generateMs: performance.now() - started,
  };
}

/** 执行场景构件检查与建筑自有 check；抛错、返回诊断或无返回值都能被归一。 */
export async function runModelCheck(
  loaded: LoadedBuilding,
  generated: GeneratedModel,
  request: ModelCheckRequest = {},
): Promise<ModelCheckSummary> {
  const { definition } = loaded;
  const started = performance.now();
  const sink = new DiagnosticSink();
  sink.addAll(generated.diagnostics);
  const finish = (
    status: ModelCheckSummary['status'],
    executed: boolean,
    rule: string | null,
    message: string | null,
  ) => {
    const diagnostics = mergeDiagnostics(sink.list());
    return {
      status,
      executed,
      severity: worstSeverity(diagnostics),
      rule,
      message,
      counts: countSeverities(diagnostics),
      diagnostics,
      ms: performance.now() - started,
    } satisfies ModelCheckSummary;
  };

  const authored = hasAuthoringChecks(generated.world);
  if (request.check === false || (!definition.check && !authored)) {
    return finish(
      definition.check || authored ? 'not-run' : 'none',
      false,
      null,
      definition.check || authored ? 'check skipped by request' : null,
    );
  }
  const collect = (diagnostic: Diagnostic) => sink.add(diagnostic);
  try {
    if (authored) sink.addAll(checkAuthoredModel(generated.world));
    const result = definition.check
      ? ((await definition.check({
          world: generated.world,
          model: generated.components,
          args: generated.args,
          inspect: generated.inspect,
          diagnostics: toLegacyMeshDiagnostics(generated.diagnostics),
          bounds: generated.bounds,
          surfaces: generated.surfaces,
          protection: generated.protection,
          collect,
          report: collect,
        })) as BuildingCheckResult)
      : undefined;
    sink.addAll(normalizeCheckResult(result));
  } catch (error) {
    if (isDiagnosticError(error)) {
      sink.addAll(error.diagnostics);
      const diagnostics = mergeDiagnostics(sink.list());
      return {
        status: 'failed',
        executed: true,
        severity: worstSeverity(diagnostics),
        rule: error.diagnostics[0]?.rule ?? 'building.check',
        message: error.message.split('\n')[0] ?? error.message,
        counts: countSeverities(diagnostics),
        diagnostics,
        ms: performance.now() - started,
      } satisfies ModelCheckSummary;
    }
    const severity = severityFromError(error);
    const message = error instanceof Error ? error.message : String(error);
    sink.add(
      coordinateDiagnostic({
        rule: 'building.check',
        severity,
        object: { kind: 'building', id: definition.id },
        region: generated.bounds,
        message,
        source: 'building-check',
        ...(severity === 'unknown' ? { conclusive: false } : {}),
      }),
    );
    const diagnostics = mergeDiagnostics(sink.list());
    return {
      status: 'failed',
      executed: true,
      severity,
      rule: 'building.check',
      message,
      counts: countSeverities(diagnostics),
      diagnostics,
      ms: performance.now() - started,
    } satisfies ModelCheckSummary;
  }
  const diagnostics = mergeDiagnostics(sink.list());
  const severity = worstSeverity(diagnostics);
  return {
    status: severity === 'error' || severity === 'unknown' ? 'failed' : 'passed',
    executed: true,
    severity,
    rule: null,
    message: null,
    counts: countSeverities(diagnostics),
    diagnostics,
    ms: performance.now() - started,
  } satisfies ModelCheckSummary;
}

/** `bewright check`: generate, then check. Nothing is meshed, exported or read back. */
export async function runModelBuild(
  loaded: LoadedBuilding,
  request: ModelCheckRequest = {},
): Promise<{ generated: GeneratedModel; check: ModelCheckSummary }> {
  const generated = generateModel(loaded.definition, request);
  const check = await runModelCheck(loaded, generated, request);
  return { generated, check };
}
