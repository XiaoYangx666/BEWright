import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { findBuilding } from '../../content/discover.js';
import { loadBuilding } from '../../content/load.js';
import { runModelBuild } from '../../content/check.js';
import { PROJECT_ROOT, atomicWrite, within } from '../../project/paths.js';
import { formatDiagnostics, type Severity } from '../../authoring/diagnostics.js';
import { hasAuthoringChecks } from '../../authoring/model-checks.js';
import { buildingArgs, CONTENT_OPTION, PARAM_OPTION, contentOptions } from '../args.js';

export const CHECK_HELP = `bewright check <building> [options]

Generates the model and checks it. Nothing is meshed, screenshotted, exported
or read back, so this is the fast static gate that \`bewright build\` also runs.

  --param k=v      override a building parameter (repeatable)
  --no-check       skip authoring and building checks (standard model rules still run)
  --strict         treat warnings (e.g. unconfirmed preview geometry) as failure
  --json           print the machine-readable report
  --report FILE    also write the JSON report to FILE (inside the project)
  --outline        print one line per building rule instead of the summary

Exit codes: 0 passed, 1 failed, unavailable or skipped checks, 2 usage/config error.`;

/** Exit codes are part of the CLI contract; keep them in one place. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** Usage/configuration problems must not be reported as a failed check. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function countsLine(counts: Readonly<Record<Severity, number>>): string {
  return `error ${counts.error} / warning ${counts.warning} / unknown ${counts.unknown} / info ${counts.info}`;
}

export async function checkCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      content: CONTENT_OPTION,
      param: PARAM_OPTION,
      'no-check': { type: 'boolean' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      report: { type: 'string' },
      outline: { type: 'boolean' },
    },
    strict: true,
  });

  const id = positionals[0];
  if (!id) throw new UsageError('Usage: bewright check <building> [--param k=v] [--json]');

  let loaded;
  let args;
  try {
    loaded = await loadBuilding(await findBuilding(id, contentOptions(values)));
    args = buildingArgs(loaded, values);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const started = Date.now();
  const { generated, check } = await runModelBuild(loaded, {
    args,
    check: !values['no-check'],
    label: loaded.definition.name,
  });

  const counts = check.counts;
  const errors = counts.error;
  const warnings = counts.warning;
  const unknowns = counts.unknown;
  const strict = Boolean(values.strict);
  // A check that never ran is never a pass; the CLI says so explicitly.
  const outcome: 'passed' | 'failed' | 'unknown' | 'none' | 'not-run' =
    errors > 0
      ? 'failed'
      : unknowns > 0
        ? 'unknown'
        : strict && warnings > 0
          ? 'failed'
          : !check.executed
            ? check.status === 'none'
              ? 'none'
              : 'not-run'
            : 'passed';

  const report = {
    id: loaded.definition.id,
    name: loaded.definition.name,
    kind: 'check' as const,
    /** What actually executed in this run — nothing else is implied. */
    stages: {
      generate: true,
      model: true,
      buildingCheck: check.executed,
      mesh: false,
      screenshot: false,
      export: false,
      readback: false,
      world: false,
    },
    outcome,
    status: check.status,
    checkExecuted: check.executed,
    severity: check.severity,
    counts,
    bounds: loaded.definition.bounds,
    args,
    occupied: generated.inspect.occupied,
    explicitAir: generated.inspect.explicitAir,
    surfaces: generated.surfaces.stats(),
    protection: generated.protection.list().map((zone) => ({
      id: zone.id,
      kind: zone.kind,
      owner: zone.owner,
      region: zone.region,
      ...(zone.clearance ? { clearance: zone.clearance } : {}),
      ...(zone.openSky ? { openSky: true } : {}),
    })),
    diagnostics: check.diagnostics,
    generateMs: Math.round(generated.generateMs),
    checkMs: Math.round(check.ms),
    totalMs: Date.now() - started,
    gameVerified: false,
  };

  if (values.report) {
    const target = resolve(PROJECT_ROOT, values.report);
    if (!within(PROJECT_ROOT, target)) throw new UsageError(`--report must stay inside the project: ${target}`);
    await atomicWrite(target, JSON.stringify(report, null, 2));
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (values.outline) {
    for (const line of formatDiagnostics(check.diagnostics, 500)) console.log(line);
    console.log(`# ${outcome} ${countsLine(counts)}`);
  } else {
    const lines = [
      `${loaded.definition.id} 生成完成：${generated.inspect.occupied} 格（${Math.round(generated.generateMs)}ms）`,
      `检查：${
        check.executed
          ? hasAuthoringChecks(generated.world)
            ? loaded.definition.check
              ? '构件检查与建筑 check() 已执行'
              : '自动构件检查已执行'
            : '建筑 check() 已执行'
          : check.status === 'none'
            ? '未声明检查'
            : '已跳过检查'
      }`,
      `诊断：${countsLine(counts)} → ${outcome}`,
    ];
    if (check.message) lines.push(`失败原因：${check.message}`);
    lines.push(...formatDiagnostics(check.diagnostics, 8));
    console.log(lines.join('\n'));
  }

  return outcome === 'passed' ? EXIT.ok : EXIT.failed;
}
