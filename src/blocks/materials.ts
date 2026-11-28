import { type State } from '../core/structure.js';
import { registryBlocks, worldReadbackBlocks, registryBlock, minecraftBlock, type RegistryBlock } from './registry.js';
export type GeometryKind =
  | 'cube'
  | 'air'
  | 'slab'
  | 'stairs'
  | 'fence'
  | 'wall'
  | 'lantern'
  | 'flower'
  | 'foliage'
  | 'plant'
  | 'glass'
  | 'water'
  | 'bed'
  | 'bookshelf'
  | 'barrel'
  | 'chain'
  | 'pot'
  | 'shrub'
  | 'crop'
  | 'farmland'
  | 'carpet'
  | 'snow'
  | 'pad'
  | 'trapdoor'
  | 'fence_gate'
  | 'button'
  | 'pressure_plate'
  | 'sapling'
  | 'candle'
  | 'sign'
  | 'door'
  | 'placeholder';
export type Material = Readonly<{
  color: string;
  geometry: GeometryKind;
  opacity?: number;
  colorSource?: string;
  reason?: string;
}>;
const concrete: Record<string, string> = {
  white: '#dbe4e9',
  orange: '#db782c',
  magenta: '#ab469b',
  light_blue: '#72c8e8',
  yellow: '#e4bb35',
  lime: '#77ad36',
  pink: '#d988a2',
  gray: '#46515c',
  light_gray: '#a5acae',
  cyan: '#247b86',
  purple: '#70449b',
  blue: '#244c79',
  brown: '#755138',
  green: '#506a32',
  red: '#a93c3c',
  black: '#172630',
};
/** Explicit supported geometry, separate from the meshing algorithm. No name-based cube fallback. */
const curated: Readonly<Record<string, Material>> = Object.freeze(
  Object.fromEntries([
    [
      'dark_prismarine_slab',
      Object.freeze({ color: '#355f59', geometry: 'slab' as const, colorSource: 'approximate-untextured' }),
    ],
    // Explicit untextured approximations, preserving real foliage and decorative block IDs.
    ...Object.entries({
      azalea_leaves: ['#527348', 'foliage'],
      cherry_leaves: ['#dfaaba', 'foliage'],
      flowering_azalea: ['#8d9a69', 'shrub'],
      chain: ['#494c50', 'chain'],
      flower_pot: ['#995b43', 'pot'],
      dark_prismarine: ['#305b55', 'cube'],
      prismarine_bricks: ['#70a99b', 'cube'],
      stone_bricks: ['#969e98', 'cube'],
      stripped_dark_oak_log: ['#49382a', 'cube'],
      spruce_planks: ['#856342', 'cube'],
      dark_oak_planks: ['#49382a', 'cube'],
      ochre_froglight: ['#e7c590', 'cube'],
    }).map(([name, [color, geometry]]) => [
      name,
      Object.freeze({ color, geometry: geometry as GeometryKind, colorSource: 'approximate-untextured' }),
    ]),
    // Farming and ground decoration: real block IDs with explicit untextured geometry.
    ...Object.entries({
      farmland: ['#6b4a2f', 'farmland'],
      wheat: ['#c9b45e', 'crop'],
      carrots: ['#5f8c3a', 'crop'],
      potatoes: ['#5f8c3a', 'crop'],
      sweet_berry_bush: ['#4e7a3f', 'crop'],
      melon_stem: ['#6f9b4a', 'crop'],
      pumpkin_stem: ['#6f9b4a', 'crop'],
      reeds: ['#8fbf6a', 'crop'],
      bamboo: ['#9cb85a', 'plant'],
      vine: ['#4d7a3f', 'plant'],
      waterlily: ['#3f7a45', 'pad'],
      snow_layer: ['#f2f7fa', 'snow'],
    }).map(([name, [color, geometry]]) => [
      name,
      Object.freeze({ color, geometry: geometry as GeometryKind, colorSource: 'approximate-untextured' }),
    ]),
    ...Object.entries({
      dark_oak_fence: ['#493b30', 'fence'],
      dark_oak_stairs: ['#493b30', 'stairs'],
      dark_oak_slab: ['#493b30', 'slab'],
      polished_blackstone_brick_stairs: ['#34373d', 'stairs'],
      polished_blackstone_brick_slab: ['#34373d', 'slab'],
    }).map(([name, [color, geometry]]) => [
      name,
      Object.freeze({ color, geometry: geometry as GeometryKind, colorSource: 'curated' }),
    ]),
    ...Object.entries({
      cobblestone_wall: ['#89928d', 'wall'],
      lantern: ['#edb960', 'lantern'],
      poppy: ['#d45248', 'flower'],
      dandelion: ['#efcc4d', 'flower'],
      allium: ['#ba8bc8', 'flower'],
      azure_bluet: ['#e9ead7', 'flower'],
      cornflower: ['#668ddd', 'flower'],
      oxeye_daisy: ['#f1eddb', 'flower'],
      white_tulip: ['#e8e8df', 'flower'],
      orange_tulip: ['#e89341', 'flower'],
      pink_tulip: ['#dc8cac', 'flower'],
      red_tulip: ['#bf4545', 'flower'],
      blue_orchid: ['#5baddc', 'flower'],
      lily_of_the_valley: ['#e7e8dc', 'flower'],
    }).map(([name, [color, geometry]]) => [
      name,
      Object.freeze({
        color,
        geometry: geometry as GeometryKind,
        colorSource: 'approximate-untextured-garden-geometry',
      }),
    ]),
    // Explicit additions used by the Qinglan refinement; no name-based model fallback.
    ...Object.entries({
      stone_brick_stairs: ['#a4aaa5', 'stairs'],
      stone_brick_slab: ['#a4aaa5', 'slab'],
      smooth_stone_slab: ['#c6cbd0', 'slab'],
      spruce_stairs: ['#71543a', 'stairs'],
      spruce_slab: ['#71543a', 'slab'],
      spruce_fence: ['#58452f', 'fence'],
      deepslate_tile_stairs: ['#405b61', 'stairs'],
      deepslate_tile_slab: ['#405b61', 'slab'],
      spruce_leaves: ['#365b3b', 'foliage'],
      oak_leaves: ['#597747', 'foliage'],
      fern: ['#628452', 'plant'],
      short_grass: ['#708c55', 'plant'],
    }).map(([name, [color, geometry]]) => [
      name,
      Object.freeze({
        color,
        geometry: geometry as GeometryKind,
        colorSource:
          geometry === 'foliage'
            ? 'approximate-porous-foliage'
            : geometry === 'plant'
              ? 'approximate-crossed-plant'
              : 'curated',
      }),
    ]),
    /**
     * Rock and ground families used by terrain recipes. The name-based fallback in
     * `representativeColor` matches none of these names, so they all collapsed onto
     * the same neutral `#89929b` — which made a rock palette of stone / andesite /
     * tuff indistinguishable in every preview. These are approximate flat colors
     * chosen to stay ordered like the real textures; they are not sampled textures.
     */
    ...Object.entries({
      andesite: ['#8a8d8d', 'cube'],
      polished_andesite: ['#949898', 'cube'],
      tuff: ['#6d6e64', 'cube'],
      cobblestone: ['#7c7c7c', 'cube'],
      mossy_cobblestone: ['#6e7a5e', 'cube'],
      gravel: ['#8b8481', 'cube'],
      podzol: ['#5b3d1e', 'cube'],
      coarse_dirt: ['#7b5c43', 'cube'],
      clay: ['#a4a8b8', 'cube'],
      stone_bricks: ['#7d7d7d', 'cube'],
      chiseled_stone_bricks: ['#7d7d7d', 'cube'],
      mossy_stone_bricks: ['#74806a', 'cube'],
      granite: ['#9a6046', 'cube'],
      diorite: ['#cfcfd0', 'cube'],
      deepslate: ['#4c4c50', 'cube'],
      cobbled_deepslate: ['#4e4e52', 'cube'],
    }).map(([name, [color, geometry]]) => [
      name,
      Object.freeze({ color, geometry: geometry as GeometryKind, colorSource: 'approximate-untextured' }),
    ]),
    ['glass', Object.freeze({ color: '#b9e3ed', geometry: 'glass' as const, opacity: 0.28, colorSource: 'curated' })],
    ...Object.entries(concrete).map(([name, color]) => [
      `${name}_stained_glass`,
      Object.freeze({ color, geometry: 'glass' as const, opacity: 0.45, colorSource: 'approximate-untextured' }),
    ]),
    ['water', Object.freeze({ color: '#327bc1', geometry: 'water' as const, opacity: 0.58, colorSource: 'curated' })],
    ['bed', Object.freeze({ color: '#3d3034', geometry: 'bed' as const, colorSource: 'curated' })],
    ['bedrock', Object.freeze({ color: '#565a5e', geometry: 'cube' as const, colorSource: 'approximate-untextured' })],
    ['bookshelf', Object.freeze({ color: '#79583b', geometry: 'bookshelf' as const, colorSource: 'curated' })],
    ['barrel', Object.freeze({ color: '#765238', geometry: 'barrel' as const, colorSource: 'curated' })],
    ...Object.entries(concrete).map(([name, color]) => [
      `${name}_concrete`,
      Object.freeze({ color, geometry: 'cube' as const }),
    ]),
    ...Object.entries({
      air: ['#ffffff', 'air'],
      stone: ['#89929b', 'cube'],
      smooth_stone: ['#c6cbd0', 'cube'],
      gold_block: ['#dfaf43', 'cube'],
      oak_planks: ['#b28b59', 'cube'],
      oak_stairs: ['#c49a60', 'stairs'],
      oak_slab: ['#c49a60', 'slab'],
      oak_fence: ['#865f3e', 'fence'],
    }).map(([name, [color, geometry]]) => [name, Object.freeze({ color, geometry: geometry as GeometryKind })]),
  ]),
);
/** Corroborated evidence only; dynamic/invisible models stay placeholders. */
function ordinaryCube(name: string) {
  const b = registryBlock(name);
  if (/(piston|moving|barrier|structure_void|invisible|info_update|unknown|jigsaw)/.test(name)) return false;
  if (b.boundingBox !== 'block' || b.transparent) return false;
  if (b.cubeLike && b.filterLight === 15) return true;
  // Stateless full-cube blocks whose collision table is not the plain full box
  // (bedrock and friends) still read as ordinary cubes, not magenta markers.
  return b.variants.length === 1 && Object.keys(b.defaultStates).length === 0;
}
function representativeColor(name: string): string {
  const dye = Object.keys(concrete).find((c) => name.startsWith(c + '_'));
  if (dye) return concrete[dye];
  if (/(leaves|sapling|vine|moss_carpet|fern|grass|nylium|moss)/.test(name)) return '#4d7a3f';
  if (/(button|pressure_plate|trapdoor|fence_gate|sign|door)$/.test(name))
    return /(stone|blackstone|cobbled|polished|deepslate|copper|iron|gold|quartz)/.test(name) ? '#89929b' : '#96724c';
  if (/(oxidized|weathered).*copper/.test(name)) return '#55a58e';
  if (/copper/.test(name)) return '#bc7954';
  if (/(gold|honey|bee)/.test(name)) return '#ceaa45';
  if (/(diamond|prismarine|sea_lantern)/.test(name)) return '#75c9bc';
  if (/(emerald|moss|grass|nylium)/.test(name)) return '#668952';
  if (/(sand|end_stone|birch)/.test(name)) return '#d8c795';
  if (/(quartz|diorite|calcite|snow|iron)/.test(name)) return '#d4d5ce';
  if (/(warped)/.test(name)) return '#357d7c';
  if (/(crimson|nether|magma)/.test(name)) return '#793e43';
  if (/(cherry)/.test(name)) return '#c99ba3';
  if (/(planks|log|wood|stem|hyphae|bookshelf|crafting|barrel|loom)/.test(name)) return '#96724c';
  if (/(dirt|mud|clay|granite)/.test(name)) return '#92715e';
  if (/(obsidian|deepslate|blackstone|coal|sculk)/.test(name)) return '#424953';
  if (/(brick)/.test(name)) return '#a66454';
  if (/(amethyst|purpur)/.test(name)) return '#9a82b6';
  return '#89929b'; // Explicit approximate neutral, not a claim of source texture color.
}
export const PLACEHOLDER_COLOR = '#ff43cb';
/** Admit standard shape families only when the pinned registry confirms their entire state schema. */
export function familyGeometry(b: RegistryBlock): GeometryKind | undefined {
  const keys = Object.keys(b.defaultStates).sort().join(',');
  if (
    b.name.endsWith('_stairs') &&
    keys === 'upside_down_bit,weirdo_direction' &&
    b.variants.every(
      (v) =>
        typeof v.upside_down_bit === 'boolean' &&
        typeof v.weirdo_direction === 'number' &&
        [0, 1, 2, 3].includes(v.weirdo_direction),
    )
  )
    return 'stairs';
  if (
    b.name.endsWith('_slab') &&
    !b.name.includes('double') &&
    keys === 'minecraft:vertical_half' &&
    b.variants.every((v) => ['bottom', 'top'].includes(String(v['minecraft:vertical_half'])))
  )
    return 'slab';
  if (
    /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_fence$/.test(b.name) &&
    keys === ''
  )
    return 'fence';
  if (b.name.endsWith('_carpet') && keys === '') return 'carpet';
  if (/_leaves(_flowered)?$/.test(b.name)) return 'foliage';
  if ((b.name.endsWith('_slab') && b.name.includes('double')) || b.name.endsWith('_double_slab')) return 'cube';
  if (
    b.name.endsWith('_wall') &&
    keys ===
      'wall_connection_type_east,wall_connection_type_north,wall_connection_type_south,wall_connection_type_west,wall_post_bit'
  )
    return 'wall';
  if (b.name.endsWith('_door') && keys === 'door_hinge_bit,minecraft:cardinal_direction,open_bit,upper_block_bit')
    return 'door';
  if (b.name.endsWith('_trapdoor') && keys === 'direction,open_bit,upside_down_bit') return 'trapdoor';
  if (b.name.endsWith('_fence_gate') && keys === 'in_wall_bit,minecraft:cardinal_direction,open_bit')
    return 'fence_gate';
  if (b.name.endsWith('_button') && keys === 'button_pressed_bit,facing_direction') return 'button';
  if (b.name.endsWith('_pressure_plate') && keys === 'redstone_signal') return 'pressure_plate';
  if (b.name.endsWith('_sapling') && keys === 'age_bit') return 'sapling';
  if (b.name.endsWith('_candle') && keys === 'candles,lit') return 'candle';
  if (b.name.endsWith('_standing_sign') && keys === 'ground_sign_direction') return 'sign';
  if (b.name.endsWith('_wall_sign') && keys === 'facing_direction') return 'sign';
  if (b.name.endsWith('_hanging_sign') && keys === 'attached_bit,facing_direction,ground_sign_direction,hanging')
    return 'sign';
  return undefined;
}
const FAMILY_SUFFIXES = [
  '_double_slab',
  '_slab',
  '_stairs',
  '_wall',
  '_fence',
  '_carpet',
  '_button',
  '_pressure_plate',
  '_trapdoor',
] as const;

const baseMaterials: Record<string, Material> = Object.fromEntries(
  [...registryBlocks, ...worldReadbackBlocks.filter(({ name }) => !registryBlocks.some((b) => b.name === name))].map((b) => {
    const old = curated[b.name];
    const family = familyGeometry(b);
    const geometry = old?.geometry ?? family ?? (ordinaryCube(b.name) ? 'cube' : 'placeholder');
    return [
      b.name,
      Object.freeze({
        color: geometry === 'placeholder' ? PLACEHOLDER_COLOR : (old?.color ?? representativeColor(b.name)),
        geometry,
        opacity: old?.opacity,
        colorSource: old
          ? 'curated'
          : geometry === 'placeholder'
            ? 'diagnostic'
            : family
              ? 'registry-validated-shape-family'
              : 'estimated-family-swatch',
        reason: geometry === 'placeholder' ? 'Visual geometry not confirmed for this block' : undefined,
      }) as Material,
    ];
  }),
);

/** Base block of a shape family, e.g. deepslate_tile_stairs -> deepslate_tiles. */
function familyRoot(name: string): string {
  for (const suffix of FAMILY_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const stem = name.slice(0, -suffix.length);
    for (const candidate of [stem, `${stem}s`])
      if (candidate !== name && Object.hasOwn(baseMaterials, candidate)) return candidate;
    return stem;
  }
  return name;
}

/** One colour per family so a roof never mixes two greys for the same material. */
const familyColor = new Map<string, string>();
for (const [name, m] of Object.entries(baseMaterials))
  if (m.colorSource === 'curated' && familyRoot(name) !== name && !familyColor.has(familyRoot(name)))
    familyColor.set(familyRoot(name), m.color);
for (const [name, m] of Object.entries(baseMaterials))
  if (m.colorSource === 'curated' && familyRoot(name) === name) familyColor.set(name, m.color);
for (const [name, m] of Object.entries(baseMaterials)) {
  if (m.geometry === 'placeholder') continue;
  const color = familyColor.get(familyRoot(name));
  if (color && color !== m.color) baseMaterials[name] = Object.freeze({ ...m, color });
}
export const materials: Readonly<Record<string, Material>> = Object.freeze(baseMaterials);
export const colors: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(materials).map(([k, v]) => [k, v.color])),
);
export const materialName = (s: State) => s.name.replace(/^minecraft:/, '');
export function material(name: string, states: State['states'] = {}): State {
  const state = minecraftBlock(name, states),
    entry = materials[materialName(state)];
  if (entry.geometry !== 'cube')
    throw new Error(
      `Expected a supported full-cube material: ${name}; use minecraftBlock for a diagnostic placeholder`,
    );
  return state;
}
/** Preview-only overrides never alter block IDs, geometry or exported materials. */
export function colorProfile(overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, hex] of Object.entries(overrides)) {
    const key = name.replace(/^minecraft:/, '');
    if (!Object.hasOwn(materials, key)) throw new Error(`Unknown preview material: ${name}`);
    if (materials[key].geometry === 'placeholder') throw new Error(`Cannot recolor diagnostic placeholder: ${name}`);
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected #RRGGBB for ${name}`);
    result[key] = hex;
  }
  return Object.freeze(result);
}
export const previewStyles = Object.freeze({
  natural: colorProfile(),
  contrast: colorProfile({
    white_concrete: '#c7d8e2',
    smooth_stone: '#97adbe',
    stone: '#687d94',
    black_concrete: '#374862',
    gray_concrete: '#59697e',
    light_gray_concrete: '#9aafbe',
    light_blue_concrete: '#51dce5',
    blue_concrete: '#416dbd',
    gold_block: '#ffbc47',
  }),
});
