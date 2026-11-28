import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { exportJavaWorld, JAVA_TARGET } from '../../targets/java/world.js';
import { buildModel, prepareModel } from '../../content/model.js';
import { findBuilding } from '../../content/discover.js';
import { loadBuilding } from '../../content/load.js';
import { runBuild } from '../../content/pipeline.js';
import { buildingOutputDir } from '../../content/output.js';
import { parseMcstructureFormatVersion } from '../../targets/bedrock/mcstructure.js';
import { buildingArgs, CONTENT_OPTION, PARAM_OPTION, contentOptions, parseTriple } from '../args.js';
import { exportRegionCommand, REGION_EXPORT_HELP } from './deployment.js';

export const EXPORT_HELP = `bewright export <building> --edition bedrock|java [options]

  --edition bedrock   write structure(s) to output/bedrock/
  --structure-version 1|2
                      .mcstructure layout version (default 1). Version 2 uses int-array
                      block layers and drops the empty secondary layer (~50% smaller);
                      it needs Bedrock 26.50 (1.26.50) or newer to load.
  --edition java      write an Anvil world via the sidecar
  --output PATH       explicit output file (bedrock) or world directory (java)
  --name NAME         world name (java)
  --worlds-dir DIR    Java saves directory (java)
  --folder NAME       world folder name (java)
  --spawn x,y,z       Java spawn point
  --seed N            world seed
  --param k=v         building parameter override
  --report            save Bedrock build metadata
  --json              print machine-readable results
  --no-check          skip the building's own check()

Advanced save export:
${REGION_EXPORT_HELP}`;

export async function exportCommand(argv: string[]) {
  if (argv[0] === 'region' && !argv.some((arg) => arg === '--edition' || arg.startsWith('--edition=')))
    return exportRegionCommand(argv.slice(1));
  if (argv.includes('--help')) return console.log(EXPORT_HELP);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      content: CONTENT_OPTION,
      param: PARAM_OPTION,
      edition: { type: 'string' },
      'structure-version': { type: 'string' },
      output: { type: 'string' },
      name: { type: 'string' },
      'worlds-dir': { type: 'string' },
      folder: { type: 'string' },
      spawn: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      'no-check': { type: 'boolean' },
      json: { type: 'boolean' },
      report: { type: 'boolean' },
    },
    strict: true,
  });

  const id = positionals[0];
  if (!id) throw new Error('Usage: bewright export <building> --edition bedrock|java');
  const edition = values.edition;
  if (edition !== 'bedrock' && edition !== 'java') throw new Error('--edition must be bedrock or java');

  const loaded = await loadBuilding(await findBuilding(id, contentOptions(values)));
  if (!(loaded.definition.editions ?? ['bedrock']).includes(edition))
    throw new Error(`Building "${id}" does not declare the ${edition} edition`);
  const args = buildingArgs(loaded, values);

  if (edition === 'java') {
    if (values['structure-version'] !== undefined)
      throw new Error('--structure-version only applies to --edition bedrock');
    const { world: source } = buildModel(loaded.definition, args);
    const world = prepareModel(source, loaded.definition.bounds, { connections: 'preserve' });
    const spawn = values.spawn ? parseTriple(values.spawn, 'spawn') : loaded.definition.spawn;
    const seed = values.seed === undefined ? 0 : Number(values.seed);
    if (!Number.isSafeInteger(seed)) throw new Error('--seed must be an integer');
    const report = await exportJavaWorld(world, loaded.definition.bounds, {
      name: values.name ?? loaded.definition.name,
      output: values.output,
      worldsDir: values['worlds-dir'] ?? buildingOutputDir(loaded, 'java-worlds'),
      folderName: values.folder ?? (values['worlds-dir'] ? undefined : loaded.definition.id),
      spawn,
      seed,
    });
    console.log(values.json ? JSON.stringify({ edition, target: JAVA_TARGET, ...report }, null, 2) : report.world);
    return;
  }

  const result = await runBuild(loaded, {
    args,
    artifactDir: values.out,
    buildingOutput: true,
    writeMetadata: values.report === true,
    structurePath: values.output === undefined ? undefined : resolve(values.output),
    check: !values['no-check'],
    export: true,
    structureVersion: parseMcstructureFormatVersion(values['structure-version']),
  });
  if (values.json) {
    console.log(JSON.stringify({ ...result.report, output: result.structureFile ?? result.artifactDir }, null, 2));
    return;
  }
  console.log(result.structureFile ?? result.artifactDir);
}
