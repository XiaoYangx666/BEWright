import { parseArgs } from 'node:util';
import { findBuilding } from '../../content/discover.js';
import { loadBuilding } from '../../content/load.js';
import { runBuild } from '../../content/pipeline.js';
import { parseMcstructureFormatVersion } from '../../targets/bedrock/mcstructure.js';
import { formatDiagnostics } from '../../authoring/diagnostics.js';
import { buildingArgs, CONTENT_OPTION, PARAM_OPTION, contentOptions } from '../args.js';
import { EXIT, UsageError } from './check.js';

export const BUILD_HELP = `bewright build <building> [options]

Generates and checks the model. --export writes Bedrock structure files to
the building's output/bedrock/ directory.
The check runs on the very model this build produced (same mechanism as bewright check).

  --param k=v      override a building parameter (repeatable)
  --out DIR        artifact directory override
  --cache DIR      mesh cache directory override
  --export         also write Bedrock .mcstructure / tile files
  --structure-version 1|2
                   .mcstructure layout version (default 1). Version 2 uses int-array
                   block layers and drops the empty secondary layer (~50% smaller);
                   it needs Bedrock 26.50 (1.26.50) or newer to load.
  --no-check       skip authoring and building checks
  --strict         treat check warnings (unconfirmed preview geometry) as failure
  --json           print the full build report
  --report         save scenes.json, report.json and manifest.json

Exit codes: 0 build and check passed, 1 check failed or reported errors, 2 usage/config error.`;

export async function buildCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      content: CONTENT_OPTION,
      param: PARAM_OPTION,
      out: { type: 'string' },
      cache: { type: 'string' },
      export: { type: 'boolean' },
      'structure-version': { type: 'string' },
      'no-check': { type: 'boolean' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      report: { type: 'boolean' },
    },
    strict: true,
  });

  const id = positionals[0];
  if (!id) throw new UsageError('Usage: bewright build <building> [--param k=v] [--out DIR]');
  if (values['structure-version'] !== undefined && !values.export)
    throw new UsageError('--structure-version requires --export (it only affects the written structure files)');
  let loaded, args;
  try {
    loaded = await loadBuilding(await findBuilding(id, contentOptions(values)));
    args = buildingArgs(loaded, values);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const result = await runBuild(loaded, {
    args,
    artifactDir: values.out,
    buildingOutput: true,
    writeMetadata: values.report === true,
    cacheDir: values.cache,
    export: Boolean(values.export),
    structureVersion: parseMcstructureFormatVersion(values['structure-version']),
    check: !values['no-check'],
  });

  const counts = result.check.counts;
  const failed =
    counts.error > 0 ||
    counts.unknown > 0 ||
    (Boolean(values.strict) && counts.warning > 0) ||
    (result.check.executed && result.check.status === 'failed');

  if (values.json) {
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    console.log(`${result.definition.id}：${result.inspect.occupied} 格，检查 ${result.check.status}`);
    if (result.exported || values.report) console.log(result.artifactDir);
    if (result.check.message) console.error(`检查失败：${result.check.message}`);
    for (const line of formatDiagnostics(
      result.diagnostics.filter((item) => item.severity !== 'info'),
      8,
    ))
      console.error(line);
  }
  return failed ? EXIT.failed : EXIT.ok;
}
