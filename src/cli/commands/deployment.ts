import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isWorldCoordinate, normalizePlacementIds, readWorldLayout } from '../../content/world-layout.js';
import { assertBox } from '../../core/structure.js';
import {
  deploymentTarget,
  deploymentTargets,
  readDeploymentBase,
  registerDeploymentTarget,
  withDeploymentLock,
  writeDeploymentBase,
} from '../../project/deployment-target.js';
import { atomicWrite, within } from '../../project/paths.js';
import {
  applyDeployment,
  diffDeployment,
  generateDeploymentLayers,
  planDeployment,
  selectInstances,
} from '../../targets/bedrock/deployment.js';
import { exportWorldTiles, readbackTiles } from '../../targets/bedrock/readback.js';
import { CONTENT_OPTION, contentOptions, parseTriple } from '../args.js';
import { EXIT, UsageError } from '../errors.js';

export const TARGET_HELP = `bewright target list [--json]
bewright target add NAME --layout FILE --world PATH

Register a local Bedrock development target once. When only one target exists, other commands can omit its name.`;

export const DEPLOY_HELP = `bewright deploy [TARGET] --adopt [--content DIR]
bewright deploy [TARGET] [--only ID[,ID]] [--dry-run] [--on-conflict stop|keep-world|use-source]
                        [--clear-removed] [--backup-dir DIR] [--limit N] [--report FILE] [--json]

Adopt current sources as a starting baseline without writing the world. Later deploys apply source changes
and preserve unrelated world edits. Conflicts stop the whole plan by default. Close the world before deploying.`;

export const DIFF_HELP = `bewright diff [TARGET] [--only ID[,ID]] [--limit N] [--report FILE] [--json]

Read the live save and compare it to current sources, including explicit air and unowned blocks.
Samples include world and source-local coordinates. --limit is the number of samples per category (default 12).`;

export const REGION_EXPORT_HELP = `bewright export region [TARGET] --output DIR [--only ID[,ID] | --min X,Y,Z --max X,Y,Z]

Read primary blocks into tiled .mcstructure files with a manifest. Coordinates use half-open world bounds.`;

const json = { type: 'boolean' } as const;
const text = { type: 'string' } as const;
const scopeOptions = { only: { type: 'string', multiple: true }, content: CONTENT_OPTION } as const;
const reportOptions = { limit: text, report: text, json } as const;

function parse<const T extends Parameters<typeof parseArgs>[0]>(args: string[], config: T) {
  try {
    return parseArgs({ ...config, args, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function targetFor(positionals: string[]) {
  if (positionals.length > 1) throw new UsageError('Expected at most one target name');
  if (positionals.length) return deploymentTarget(positionals[0]);
  const configured = await deploymentTargets();
  if (configured.length === 1) return configured[0];
  throw new UsageError('Specify a target name. Run "bewright target list" or "bewright target add".');
}

function sampleLimit(value?: string) {
  const limit = value === undefined ? 12 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100_000)
    throw new UsageError('--limit must be an integer from 0 to 100000');
  return limit;
}

async function report(result: unknown, values: { json?: boolean; report?: string }, summary: string) {
  const encoded = JSON.stringify(result, null, 2);
  if (values.report) await atomicWrite(resolve(values.report), encoded + '\n');
  console.log(values.json ? encoded : summary);
}

function checkReportPath(world: string, path?: string) {
  if (path && within(world, resolve(path))) throw new UsageError('The report must be outside the target world');
}

export async function targetCommand(args: string[]) {
  if (args.includes('--help') || args.length === 0) return console.log(TARGET_HELP);
  const [action, ...rest] = args;
  if (action === 'list') {
    const { values, positionals } = parse(rest, { options: { json } });
    if (positionals.length) throw new UsageError(TARGET_HELP);
    const targets = await deploymentTargets();
    console.log(
      values.json
        ? JSON.stringify(targets, null, 2)
        : targets.map(({ name, world, layout }) => `${name}\t${world}\t${layout}`).join('\n') ||
            'No development targets registered',
    );
    return;
  }
  if (action !== 'add') throw new UsageError(TARGET_HELP);
  const { values, positionals } = parse(rest, { options: { layout: text, world: text } });
  if (positionals.length !== 1 || !values.layout || !values.world) throw new UsageError(TARGET_HELP);
  await readWorldLayout(values.layout);
  const target = await registerDeploymentTarget(positionals[0], values.layout, values.world);
  console.log(
    `Registered ${target.name} → ${target.world}. Run "bewright deploy ${target.name} --adopt" to record the starting source baseline.`,
  );
}

export async function deployCommand(args: string[]) {
  if (args.includes('--help')) return console.log(DEPLOY_HELP);
  const { values, positionals } = parse(args, {
    options: {
      ...scopeOptions,
      ...reportOptions,
      adopt: json,
      'dry-run': json,
      'clear-removed': json,
      'on-conflict': text,
      'backup-dir': text,
    },
  });
  const policy = values['on-conflict'] ?? 'stop';
  if (policy !== 'stop' && policy !== 'keep-world' && policy !== 'use-source')
    throw new UsageError('--on-conflict must be stop, keep-world, or use-source');
  const ids = normalizePlacementIds(values.only);
  if (
    values.adopt &&
    (ids.length || values['dry-run'] || values['clear-removed'] || values['on-conflict'] || values['backup-dir'])
  )
    throw new UsageError('--adopt records the full layout and cannot be combined with write planning options');
  const limit = sampleLimit(values.limit);
  const target = await targetFor(positionals);
  checkReportPath(target.world, values.report);
  return await withDeploymentLock(target, async () => {
    const layout = await readWorldLayout(target.layout);
    const selected = selectInstances(layout, ids);
    const base = await readDeploymentBase(target);
    if (values.adopt) {
      if (base) throw new Error(`Target "${target.name}" already has a baseline`);
      const next = await generateDeploymentLayers(layout, contentOptions(values), selected);
      await writeDeploymentBase(target, next);
      await report(
        { target: target.name, world: target.world, adopted: true, instances: selected },
        values,
        `Recorded the source baseline for ${target.name} (${selected.length} placements). The world was not written.`,
      );
      return EXIT.ok;
    }
    if (!base) throw new Error(`Run "bewright deploy ${target.name} --adopt" with the starting sources first.`);
    const next = await generateDeploymentLayers(layout, contentOptions(values), selected, base);
    const plan = await planDeployment(target, base, next, { policy, clearRemoved: !!values['clear-removed'], limit });
    const result = {
      target: target.name,
      world: target.world,
      instances: selected,
      policy,
      dryRun: !!values['dry-run'],
      counts: plan.counts,
      conflicts: plan.conflicts,
      blocked: plan.blocked,
    };
    const { write, alreadyApplied, conflicts, released } = plan.counts;
    const summary = `${target.name} · ${write} to write, ${alreadyApplied} already applied, ${released} released, ${conflicts} conflicts`;
    if (plan.blocked || values['dry-run']) {
      const details = plan.conflicts
        .slice(0, 8)
        .map(
          ({ position, before, source, world }) =>
            `  ${position.join(',')}  ${before?.name ?? 'VOID'} → ${source.name}  (world: ${world.name})`,
        );
      await report(
        result,
        values,
        [
          summary,
          ...details,
          ...(plan.blocked ? ['Deployment blocked by conflicts. Use --json for block states.'] : []),
        ].join('\n'),
      );
      return plan.blocked ? EXIT.failed : EXIT.ok;
    }
    const applied = await applyDeployment(target, plan, values['backup-dir']);
    try {
      await writeDeploymentBase(target, next);
    } catch (error) {
      const backup = 'backupPath' in applied ? ` Pre-deployment backup: ${applied.backupPath}.` : '';
      throw new Error(`Could not update the deployment baseline.${backup} ${String(error)}`, { cause: error });
    }
    const backup = 'backupPath' in applied ? `\nBackup: ${applied.backupPath}` : '';
    await report(
      { ...result, applied, gameVerified: false },
      values,
      `${target.name} · wrote and verified ${applied.checkedBlocks} blocks, kept ${policy === 'keep-world' ? conflicts : 0} conflicts, released ${released} cells${backup}`,
    );
    return EXIT.ok;
  });
}

export async function diffCommand(args: string[]) {
  if (args.includes('--help')) return console.log(DIFF_HELP);
  const { values, positionals } = parse(args, { options: { ...scopeOptions, ...reportOptions } });
  const target = await targetFor(positionals);
  checkReportPath(target.world, values.report);
  const layout = await readWorldLayout(target.layout);
  const selected = selectInstances(layout, normalizePlacementIds(values.only));
  const limit = sampleLimit(values.limit);
  const layers = await generateDeploymentLayers(layout, contentOptions(values), selectInstances(layout, []));
  const result = await diffDeployment(target, layers, selected, limit);
  const { same, changed, missing, filled, unowned } = result.counts;
  const groups = result.groups
    .slice(0, 10)
    .map((group) => `  ${group.cells}  ${group.kind}  ${group.source ?? 'VOID'} → ${group.world}`);
  await report(
    result,
    values,
    [
      `${target.name} · ${same} matching, ${changed} changed, ${missing} missing, ${filled} filled air, ${unowned} unowned`,
      ...groups,
    ].join('\n'),
  );
}

export async function exportRegionCommand(args: string[]) {
  if (args.includes('--help')) return console.log(REGION_EXPORT_HELP);
  const { values, positionals } = parse(args, {
    options: { ...scopeOptions, output: text, min: text, max: text, json },
  });
  if (!values.output || !!values.min !== !!values.max || (values.min && values.only?.length))
    throw new UsageError(REGION_EXPORT_HELP);
  const target = await targetFor(positionals);
  const output = resolve(values.output);
  if (within(target.world, output)) throw new Error('The readback output must be outside the target world');
  const regions = await (async () => {
    if (values.min && values.max) {
      const min = parseTriple(values.min, '--min');
      const max = parseTriple(values.max, '--max');
      if (![...min, ...max].every(isWorldCoordinate) || min[1] < -64 || max[1] > 320)
        throw new UsageError('Readback bounds must fit the Bedrock Overworld');
      const bounds = { min, max };
      assertBox(bounds);
      return [bounds];
    }
    const layout = await readWorldLayout(target.layout);
    const selected = selectInstances(layout, normalizePlacementIds(values.only));
    return (await generateDeploymentLayers(layout, contentOptions(values), selected)).map(({ bounds }) => bounds);
  })();
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  try {
    const tiles = await exportWorldTiles(target.world, output, readbackTiles(regions));
    const result = { target: target.name, world: target.world, layer: 'primary', tiles };
    await atomicWrite(join(output, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(values.json ? JSON.stringify(result, null, 2) : `Read ${tiles.length} tiles into ${output}`);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
