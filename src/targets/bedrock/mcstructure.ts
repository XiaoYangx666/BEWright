import nbt, { type NBT, type Compound } from 'prismarine-nbt';
import { Structure, assertBox, type Box } from '../../core/structure.js';
import { TARGET } from '../../blocks/target.js';
import { validateBlockState } from '../../blocks/registry.js';
export { TARGET } from '../../blocks/target.js';

/**
 * `.mcstructure` layout versions.
 *
 * - 1: `block_indices` is a list of two lists holding one int tag per cell.
 * - 2 (Bedrock 26.50 / 1.26.50+): the layers are int-array tags, and the
 *   secondary layer is omitted when nothing is stored in it. Version 1 files
 *   still load in that game version and are upgraded on their next save.
 *
 * Version 1 stays the default because a client older than 26.50 cannot be
 * assumed to read version 2; pass `formatVersion: 2` explicitly to opt in.
 */
export type McstructureFormatVersion = 1 | 2;

export const MCSTRUCTURE_FORMAT_VERSIONS: readonly McstructureFormatVersion[] = [1, 2];

/** Version written when the caller does not choose one. */
export const DEFAULT_MCSTRUCTURE_FORMAT_VERSION: McstructureFormatVersion = 1;

export function parseMcstructureFormatVersion(raw: string | number | undefined): McstructureFormatVersion {
  if (raw === undefined || raw === '') return DEFAULT_MCSTRUCTURE_FORMAT_VERSION;
  const version = typeof raw === 'number' ? raw : Number(raw);
  if (version !== 1 && version !== 2) throw new Error(`Structure format version must be 1 or 2, got: ${raw}`);
  return version;
}

export type McstructureExportOptions = Readonly<{
  /** Layout version to write; 1 by default. */
  formatVersion?: McstructureFormatVersion;
}>;

/** Small-file correctness POC. Dense intermediate arrays are NOT the production streaming exporter. */
export function exportMcstructure(world: Structure, region: Box, options: McstructureExportOptions = {}): Buffer {
  assertBox(region);
  const formatVersion = options.formatVersion ?? DEFAULT_MCSTRUCTURE_FORMAT_VERSION;
  if (!MCSTRUCTURE_FORMAT_VERSIONS.includes(formatVersion))
    throw new Error(`Unsupported structure format version: ${formatVersion}`);
  const size = region.max.map((v, i) => v - region.min[i]);
  const volume = size.reduce((a, b) => a * b, 1);
  if (volume > 2_000_000) throw new Error('POC export volume budget exceeded; tile or stream export');
  const used = new Set<number>();
  world.forEach((_x, _y, _z, id) => used.add(id), region);
  const ids = [...used].sort((a, b) => a - b),
    remap = new Map(ids.map((id, i) => [id, i]));
  for (const id of ids) validateBlockState(world.palette[id]!);
  const primary = new Array<number>(volume).fill(-1);
  // This exporter never fills the extra (co-located) layer, so version 2 leaves
  // it out entirely while version 1 keeps the all -1 array the format requires.
  const secondary = formatVersion === 1 ? new Array<number>(volume).fill(-1) : null;
  world.forEach((x, y, z, id) => {
    primary[((x - region.min[0]) * size[1] + y - region.min[1]) * size[2] + z - region.min[2]] = remap.get(id)!;
  }, region);
  const palette: Compound['value'][] = ids.map((id) => {
    const s = world.palette[id]!;
    return {
      name: nbt.string(s!.name),
      states: {
        type: 'compound',
        value: Object.fromEntries(
          Object.entries(s!.states).map(([k, v]) => [
            k,
            typeof v === 'boolean' ? nbt.byte(Number(v)) : typeof v === 'number' ? nbt.int(v) : nbt.string(v),
          ]),
        ),
      },
      version: nbt.int(TARGET.blockVersion),
    };
  });
  // Version 2 elements are the bare index arrays: wrapping them in `nbt.intArray`
  // makes the serializer write an empty int-array tag per layer.
  const blockIndices: Compound['value'][string] =
    secondary === null
      ? { type: 'list', value: { type: 'intArray', value: [primary] } }
      : {
          type: 'list',
          value: {
            type: 'list',
            value: [
              { type: 'int', value: primary },
              { type: 'int', value: secondary },
            ],
          },
        };
  const tree: NBT = {
    name: '',
    type: 'compound',
    value: {
      format_version: nbt.int(formatVersion),
      size: { type: 'list', value: { type: 'int', value: size } },
      structure_world_origin: { type: 'list', value: { type: 'int', value: region.min } },
      structure: {
        type: 'compound',
        value: {
          block_indices: blockIndices,
          entities: { type: 'list', value: { type: 'compound', value: [] } },
          palette: {
            type: 'compound',
            value: {
              default: {
                type: 'compound',
                value: {
                  block_palette: { type: 'list', value: { type: 'compound', value: palette } },
                  block_position_data: { type: 'compound', value: {} },
                },
              },
            },
          },
        },
      },
    },
  };
  return nbt.writeUncompressed(tree, 'little');
}

const unwrapTag = (node: unknown): unknown =>
  node && typeof node === 'object' && !Array.isArray(node) && 'value' in node
    ? (node as { value: unknown }).value
    : node;

/**
 * Block index layers of a parsed structure file, for both layouts and both
 * readers used in this repo:
 *
 * - prismarine-nbt wraps a list tag as `{value}` and a version 1 int tag as
 *   `{type, value}`, so a layer is one or two `{value}` hops deep.
 * - nbtify returns the list as an array and each layer as an array or Int32Array.
 *
 * Version 2 files omit the secondary layer when nothing is stored in it, so the
 * result legitimately holds a single layer.
 */
export function blockIndexLayers(blockIndices: unknown): number[][] {
  const layers = unwrapTag(unwrapTag(blockIndices));
  if (!Array.isArray(layers)) throw new Error('mcstructure block_indices is not a list of layers');
  return layers.map((layer) => Array.from(unwrapTag(layer) as ArrayLike<number>, Number));
}
