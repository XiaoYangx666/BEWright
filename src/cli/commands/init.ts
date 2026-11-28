import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUILDING_MANIFEST, DEFAULT_CONTENT_ROOT, isBuildingId } from '../../content/discover.js';
import { BEWRIGHT_PACKAGE } from '../../content/package-name.js';
import { loadBlockwrightConfig } from '../../project/config.js';

export const INIT_HELP = `bewright init [id] [--name NAME]

  Create a starter building under the configured sourceRoot (default: buildings/).
  The default id is starter. Creates a workspace .gitignore if one is missing.`;

const WORKSPACE_IGNORE = [
  '/node_modules/',
  '/artifacts/',
  '/dist/',
  '**/buildings/*/output/',
  '/cache/',
  '/worlds/',
  '/blockwright.local.json',
  '/.bewright/',
  '',
].join('\n');

export async function initCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: 'string' } },
  });
  const id = positionals[0] ?? 'starter';
  if (positionals.length > 1 || !isBuildingId(id)) throw new Error('Building id must be a lowercase slug');
  const name = values.name?.trim() ?? (id === 'starter' ? 'Starter Arch' : id);
  if (!name) throw new Error('Building name cannot be blank');

  const { sourceRoot } = await loadBlockwrightConfig(undefined, { absolutePaths: true });
  const root = resolve(sourceRoot ?? DEFAULT_CONTENT_ROOT, id);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error(`Building directory already exists: ${root}`);
    throw error;
  });

  const entry = './building.mts';
  const editions = ['bedrock', 'java'];
  const manifest = { schemaVersion: 1, id, name, entry, editions };
  await writeFile(
    join(root, entry),
    `import { block, defineBuilding, Structure } from '${BEWRIGHT_PACKAGE}';

export default defineBuilding({
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  editions: ${JSON.stringify(editions)},
  bounds: { min: [0, 0, 0], max: [9, 6, 7] },
  spawn: [4, 1, 1],
  build() {
    const world = new Structure();
    const stone = block('stone');
    world.fill({ min: [0, 0, 0], max: [9, 1, 7] }, stone);
    world.fill({ min: [2, 1, 3], max: [3, 5, 4] }, stone);
    world.fill({ min: [6, 1, 3], max: [7, 5, 4] }, stone);
    world.fill({ min: [2, 5, 3], max: [7, 6, 4] }, stone);
    return world;
  },
  check({ world }) {
    if (!world.get(4, 0, 1)) throw new Error('Missing floor below the spawn point');
  },
});
`,
    { flag: 'wx' },
  );
  await writeFile(join(root, BUILDING_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve('.gitignore'), WORKSPACE_IGNORE, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  console.log(`Created ${root}\nNext: bewright build ${id}`);
}
