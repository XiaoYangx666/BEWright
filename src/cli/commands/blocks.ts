import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { minecraftBlock, registryBlock, registryBlocks, registrySource } from '../../blocks/registry.js';
import { block } from '../../core/structure.js';
import { materials } from '../../blocks/materials.js';
import { PROJECT_ROOT } from '../../project/paths.js';
import { blockSupport, buildingBlockSupport } from '../../content/block-support.js';
import { findBuilding } from '../../content/discover.js';
import { loadBuilding } from '../../content/load.js';
import { buildingModelWorld } from '../../content/definition.js';
import { CONTENT_OPTION, PARAM_OPTION, contentOptions, buildingArgs } from '../args.js';

export const BLOCKS_HELP = `bewright blocks [--search TEXT] [--limit N] [--report]

Searches the pinned Bedrock block registry and reports preview geometry coverage.

  --search TEXT   substring match on block names
  --limit N       number of matches to print (default 30)
  --report        write artifacts/block-coverage.json
  --name NAME     check one block, filling pinned default states
  --states JSON   typed state overrides with --name (e.g. '{"hanging":true}')
  --building ID   check every placed state in a building, with counts and coordinates
  --content DIR   additional building content root
  --param k=v     building parameter override (repeatable)`;

export async function blocksCommand(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      search: { type: 'string', default: '' },
      limit: { type: 'string', default: '30' },
      report: { type: 'boolean' },
      name: { type: 'string' },
      states: { type: 'string' },
      building: { type: 'string' },
      content: CONTENT_OPTION,
      param: PARAM_OPTION,
    },
    strict: true,
  });

  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('--limit must be 1..2000');
  if (values.name && values.building) throw new Error('Choose --name or --building');
  if (values.states && !values.name) throw new Error('--states requires --name');
  if (values.name || values.building) {
    let matches;
    if (values.name) {
      const overrides = JSON.parse(values.states ?? '{}');
      if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object')
        throw new Error('--states must be a JSON object');
      let defaults = {};
      try {
        defaults = registryBlock(values.name).defaultStates;
      } catch {
        /* Report an unknown name through the unified gates. */
      }
      matches = [blockSupport(block(values.name, { ...defaults, ...overrides }))];
    } else {
      const loaded = await loadBuilding(await findBuilding(values.building!, contentOptions(values)));
      const { world } = buildingModelWorld(loaded.definition.build(buildingArgs(loaded, values)));
      matches = buildingBlockSupport(world);
    }
    const result = {
      source: registrySource,
      scope: values.building ? 'placed-states' : 'state-with-defaults',
      matches,
    };
    if (values.report) {
      await mkdir(join(PROJECT_ROOT, 'artifacts'), { recursive: true });
      await writeFile(join(PROJECT_ROOT, 'artifacts', 'block-coverage.json'), JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const describe = (block: (typeof registryBlocks)[number]) => ({
    name: block.name,
    defaultStates: minecraftBlock(block.name).states,
    states: block.variants.length,
    geometry: materials[block.name].geometry,
    color: materials[block.name].color,
    colorSource: materials[block.name].colorSource,
    reason: materials[block.name].reason,
    transparent: block.transparent,
    emitLight: block.emitLight,
    filterLight: block.filterLight,
    support: blockSupport(minecraftBlock(block.name)),
  });
  const counts: Record<string, number> = {};
  for (const material of Object.values(materials)) counts[material.geometry] = (counts[material.geometry] ?? 0) + 1;
  if (values.report) {
    await mkdir(join(PROJECT_ROOT, 'artifacts'), { recursive: true });
    await writeFile(
      join(PROJECT_ROOT, 'artifacts', 'block-coverage.json'),
      JSON.stringify({ source: registrySource, counts, blocks: registryBlocks.map(describe) }, null, 2),
    );
  }
  console.log(
    JSON.stringify(
      {
        source: registrySource,
        counts,
        matches: registryBlocks
          .filter((block) => block.name.includes(values.search!))
          .slice(0, limit)
          .map(describe),
      },
      null,
      2,
    ),
  );
}
