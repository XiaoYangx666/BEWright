import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { read as readNbt } from 'nbtify';
import { minecraftBlock, registryBlocks, registrySource } from '../../blocks/registry.js';
import { materials } from '../../blocks/materials.js';
import { TARGET } from '../../blocks/target.js';
import { exportMcstructure, MCSTRUCTURE_FORMAT_VERSIONS, blockIndexLayers } from '../../targets/bedrock/mcstructure.js';
import { Structure, type Box } from '../../core/structure.js';
import { PROJECT_ROOT } from '../../project/paths.js';
import { blockGallery } from '../fixtures/block-gallery.js';

export const REGISTRY_HELP = `bewright registry generate|verify

  generate   rebuild src/blocks/generated/bedrock-registry.json from minecraft-data
  verify     export the gallery plus every default state and re-read it independently`;

async function generate() {
  const require = createRequire(import.meta.url);
  // minecraft-data is a devDependency (447 MB): load it only for this command
  // so a production install can still run the rest of the CLI.
  const { default: minecraftData } = await import('minecraft-data').catch(() => {
    throw new Error('bewright registry generate needs the minecraft-data devDependency; run npm ci');
  });
  const data: any = minecraftData('bedrock_' + TARGET.gameVersion);
  const decode = (states: any) =>
    Object.fromEntries(
      Object.entries(states).map(([key, value]: [string, any]) => {
        if (!['int', 'string', 'byte'].includes(value.type) || (value.type === 'byte' && ![0, 1].includes(value.value)))
          throw new Error('Unsupported state tag');
        return [key, value.type === 'byte' ? Boolean(value.value) : value.value];
      }),
    );
  const FULL_SHAPE = '[[0.5,0.5,0.5,1,1,1]]';
  const records = data.blocksArray
    .map((block: any) => {
      const states = data.blockStates.slice(block.minStateId, block.maxStateId + 1);
      if (states.some((state: any) => state.name !== block.name || state.version !== TARGET.blockVersion))
        throw new Error('Registry version/range mismatch');
      const shapes = data.blockCollisionShapes.blocks[block.name];
      const shapeJson = (id: number) => JSON.stringify(data.blockCollisionShapes.shapes[id]);
      const aligned = Array.isArray(shapes) && shapes.length === states.length;
      const uniformFullCollision = aligned && shapes.every((id: number) => shapeJson(id) === FULL_SHAPE);
      // Some visually cubic blocks (bone_block, double slabs, ...) mix full and
      // empty collision shapes across variants, so uniformFullCollision is false.
      const cubeLike = aligned && shapes.every((id: number) => shapeJson(id) === FULL_SHAPE || shapeJson(id) === '[]');
      const defaultStates = decode(data.blockStates[block.defaultState].states);
      // Compact on-disk form: one shared key list, a value domain per key and
      // index tuples for the variants. Stateless blocks omit all four fields.
      const stateKeys = Object.keys(defaultStates).sort();
      const stateObjects: Record<string, string | number | boolean>[] = states.map((state: any) =>
        decode(state.states),
      );
      const domains = stateKeys.map((key) => [...new Set(stateObjects.map((values) => values[key]!))]);
      const toIndexes = (values: Record<string, string | number | boolean>) =>
        stateKeys.map((key, index) => domains[index]!.indexOf(values[key]!));
      return {
        name: block.name,
        ...(stateKeys.length
          ? { stateKeys, domains, default: toIndexes(defaultStates), variants: stateObjects.map(toIndexes) }
          : {}),
        transparent: block.transparent,
        filterLight: block.filterLight,
        emitLight: block.emitLight,
        boundingBox: block.boundingBox,
        uniformFullCollision,
        cubeLike,
      };
    })
    .sort((a: any, b: any) => a.name.localeCompare(b.name, 'en'));
  // Flags are packed into one tuple per block; bounding boxes share a table.
  const boundingBoxes = [...new Set(records.map((record: any) => record.boundingBox))].sort();
  const blocks = records.map((record: any) => ({
    name: record.name,
    ...(record.stateKeys
      ? { stateKeys: record.stateKeys, domains: record.domains, default: record.default, variants: record.variants }
      : {}),
    f: [
      record.transparent ? 1 : 0,
      record.filterLight,
      record.emitLight,
      boundingBoxes.indexOf(record.boundingBox),
      record.uniformFullCollision ? 1 : 0,
      record.cubeLike ? 1 : 0,
    ],
  }));
  const source = {
    package: 'minecraft-data',
    packageVersion: require('minecraft-data/package.json').version,
    license: 'MIT',
    target: TARGET,
    stateCount: data.blockStates.length,
    sourceHash: createHash('sha256')
      .update(JSON.stringify({ blocks: data.blocksArray, states: data.blockStates, shapes: data.blockCollisionShapes }))
      .digest('hex'),
    notes:
      'Collision evidence includes Java-derived data; never use it alone as visual geometry. Source has no per-block representative colors.',
  };
  const dir = join(PROJECT_ROOT, 'src', 'blocks', 'generated');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'bedrock-registry.json'), JSON.stringify({ source, boundingBoxes, blocks }) + '\n');
  console.log(
    JSON.stringify({
      blocks: blocks.length,
      states: source.stateCount,
      uniformFullCollision: records.filter((record: any) => record.uniformFullCollision).length,
    }),
  );
}

async function verify() {
  const artifacts = join(PROJECT_ROOT, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const all = new Structure();
  registryBlocks.forEach((block, index) => all.set(index % 50, 0, Math.floor(index / 50), minecraftBlock(block.name)));
  const files = [];
  for (const [name, world, region] of [
    ['block-gallery', blockGallery().world, { min: [0, 0, 0], max: [15, 4, 11] }],
    ['registry-defaults', all, { min: [0, 0, 0], max: [50, 1, 26] }],
  ] as [string, Structure, Box][]) {
    // Both layout versions are exported and independently re-read (nbtify), so a
    // version 2 file (int-array layers, empty secondary layer omitted) is covered.
    for (const formatVersion of MCSTRUCTURE_FORMAT_VERSIONS) {
      const bytes = exportMcstructure(world, region, { formatVersion });
      const parsed: any = (
        await readNbt(bytes, { endian: 'little', compression: null, bedrockLevel: false, strict: true })
      ).data;
      const [sx, sy, sz] = parsed.size.map(Number);
      const layers = blockIndexLayers(parsed.structure.block_indices);
      if (layers.length < 1) throw new Error('Export is missing its primary block layer');
      const indices = layers[0]!;
      const palette = parsed.structure.palette.default.block_palette;
      for (let x = 0; x < sx; x++)
        for (let y = 0; y < sy; y++)
          for (let z = 0; z < sz; z++) {
            const expected = world.get(x + region.min[0], y + region.min[1], z + region.min[2]);
            const id = Number(indices[(x * sy + y) * sz + z]);
            if ((expected?.name ?? null) !== (id < 0 ? null : palette[id].name)) throw new Error('Export mismatch');
            if ((layers[1]?.[(x * sy + y) * sz + z] ?? -1) !== -1) throw new Error('Unexpected secondary layer');
          }
      const file = formatVersion === 1 ? `${name}.mcstructure` : `${name}-v2.mcstructure`;
      await writeFile(join(artifacts, file), bytes);
      files.push({
        name: file,
        formatVersion,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: parsed.size.map(Number),
        independentNBTVerified: true,
        occupied: world.inspect().occupied,
      });
    }
  }
  const counts: Record<string, number> = {};
  for (const material of Object.values(materials)) counts[material.geometry] = (counts[material.geometry] ?? 0) + 1;
  await writeFile(
    join(artifacts, 'registry-validation.json'),
    JSON.stringify(
      {
        source: registrySource,
        counts,
        files,
        exportScope:
          'Names and typed states only; no block entities, inventories, entities, secondary fluid layers, multiblock or simulation validation.',
        gameVerified: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(files, null, 2));
}

export async function registryCommand(argv: string[]) {
  const action = argv[0];
  if (action === 'generate') {
    await generate();
    return;
  }
  if (action === 'verify') {
    await verify();
    return;
  }
  throw new Error('Usage: bewright registry generate|verify');
}
