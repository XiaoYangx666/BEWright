import { parseArgs } from 'node:util';
import { discoverBuildings } from '../../content/discover.js';
import { loadBuilding } from '../../content/load.js';
import { describeBuilding } from '../../content/pipeline.js';
import { CONTENT_OPTION, contentOptions } from '../args.js';

export const LIST_HELP = `bewright list [--content DIR]... [--detailed] [--json]

  --detailed   load each entry module and show params/views/editions
  --json       machine-readable output`;

/** List buildings discovered across every content root. */
export async function listCommand(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      content: CONTENT_OPTION,
      detailed: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    strict: true,
  });

  const discovered = await discoverBuildings(contentOptions(values));
  const status = (building: { status: string }) => (building.status === 'wip' ? '[wip] ' : '');
  if (!values.detailed) {
    if (values.json) {
      console.log(JSON.stringify(discovered, null, 2));
      return;
    }
    if (!discovered.length) {
      console.log('No buildings found. Add a content root or create buildings/<id>/blockwright.building.json.');
      return;
    }
    for (const building of discovered)
      console.log(
        `${status(building)}${building.id.padEnd(14)} ${building.name.padEnd(28)} [${building.editions.join(',')}] ${building.source}  ${building.root}`,
      );
    return;
  }

  const detailed = [];
  for (const building of discovered)
    detailed.push({ ...describeBuilding(await loadBuilding(building)), status: building.status });
  if (values.json) {
    console.log(JSON.stringify(detailed, null, 2));
    return;
  }
  for (const item of detailed)
    console.log(
      `${status(item)}${item.id.padEnd(14)} ${item.name.padEnd(28)} [${item.editions.join(',')}] views=${item.views.join('/') || '-'} params=${Object.keys(item.params).join(',') || '-'}`,
    );
}
