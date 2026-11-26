import type { State, Vec3 } from '../core/structure.js';
import type { DiagnosticObject } from './diagnostics.js';

/**
 * 保护区规则：保护区契约的**可复用判据**，而不是保护区本身。
 *
 * 契约回答"这段空间属于谁、必须满足什么"；规则回答"哪些方块算这个对象的"。
 * 关键约束来自架构要求：替换规则必须结合方块属性、对象归属、保护区和操作权限，
 * **不能仅凭材料判断**——同样是石头，天然岩壁与人工石径必须能区分。
 */

export type StatePattern = Readonly<{
  /** Exact block name; `minecraft:` prefix optional. */
  name?: string;
  /** Any-of block names. */
  names?: readonly string[];
  /** Suffix test on the short name, e.g. `_leaves`. */
  suffix?: string;
  /**
   * State key test. Every entry must match; a `RegExp` is tested against the
   * stringified value. This is how "block properties" enter the judgement.
   */
  states?: Readonly<Record<string, string | number | boolean | RegExp>>;
}>;

/** Object patterns match a diagnostic object's kind, id or owner. */
export type ObjectPattern = Readonly<{
  kind?: string | RegExp;
  id?: string | RegExp;
  owner?: string | RegExp;
}>;

export type ProtectionRule = Readonly<{
  /** What this rule is about; used to select which rules apply to an operation. */
  object: ObjectPattern;
  /** True when the block belongs to the protected object. */
  blocks: (block: State | null, position: Vec3) => boolean;
  /** Human-readable reason, carried into diagnostics. */
  reason: string;
  /** Who declared the rule. */
  owner?: string;
  note?: string;
}>;

export type ProtectionRuleSet = readonly ProtectionRule[];

const short = (name: string) => name.replace(/^minecraft:/, '');

/** Whole-state block predicate; matches on name, suffix and state keys. */
export function blockPattern(pattern: StatePattern): (block: State | null) => boolean {
  if (!pattern.name && !pattern.names && !pattern.suffix && !pattern.states)
    throw new Error('Empty state pattern would match every block; be explicit');
  const names = new Set([...(pattern.names ?? []), ...(pattern.name ? [pattern.name] : [])].map(short));
  const entries = Object.entries(pattern.states ?? {});
  return (block) => {
    if (!block) return false;
    const name = short(block.name);
    if (names.size && !names.has(name)) return false;
    if (pattern.suffix && !name.endsWith(pattern.suffix)) return false;
    for (const [key, expected] of entries) {
      const value = block.states[key];
      if (expected instanceof RegExp) {
        if (value === undefined || !expected.test(String(value))) return false;
      } else if (value !== expected) return false;
    }
    return true;
  };
}

/** Negation, for "natural terrain" = terrain-like minus what buildings placed. */
export function notPattern(pattern: (block: State | null) => boolean): (block: State | null) => boolean {
  return (block) => !pattern(block);
}

export function anyPattern(...patterns: readonly ((block: State | null) => boolean)[]): (block: State | null) => boolean {
  return (block) => patterns.some((pattern) => pattern(block));
}

function matchesObject(pattern: ObjectPattern, object: DiagnosticObject): boolean {
  const test = (value: string | RegExp | undefined, actual: string) =>
    value === undefined ? true : value instanceof RegExp ? value.test(actual) : value === actual;
  return test(pattern.kind, object.kind) && test(pattern.id, object.id) && test(pattern.owner, object.owner ?? '');
}

/** First rule whose object pattern matches; `null` means no rule claims this object. */
export function matchProtectionRules(rules: ProtectionRuleSet, object: DiagnosticObject | string): ProtectionRule | null {
  const resolved: DiagnosticObject = typeof object === 'string' ? { kind: object, id: object } : object;
  for (const rule of rules) if (matchesObject(rule.object, resolved)) return rule;
  return null;
}

export function formatRulePattern(pattern: ObjectPattern): string {
  const part = (value: string | RegExp | undefined) =>
    value === undefined ? '*' : value instanceof RegExp ? value.source : value;
  return `${part(pattern.kind)}:${part(pattern.id)}${pattern.owner ? `@${part(pattern.owner)}` : ''}`;
}

/** `minecraft:`-optional name list helper used by the default packs. */
export function names(...list: readonly string[]): (block: State | null) => boolean {
  const set = new Set(list.map(short));
  return (block) => !!block && set.has(short(block.name));
}

export function suffix(value: string): (block: State | null) => boolean {
  return (block) => !!block && short(block.name).endsWith(value);
}

/** Terrain-ish names; used to tell "natural ground" apart from constructed paths. */
export const TERRAIN_NAMES = [
  'stone',
  'andesite',
  'granite',
  'diorite',
  'tuff',
  'deepslate',
  'calcite',
  'dirt',
  'coarse_dirt',
  'grass_block',
  'podzol',
  'moss_block',
  'gravel',
  'clay',
  'sand',
  'sandstone',
  'cobblestone',
  'mossy_cobblestone',
  'snow_block',
  'water',
  'bedrock',
] as const;

/**
 * Constructed paving, dressed stone and timber. None of it is "natural terrain":
 * these are the names that must never answer a terrain query, and the blocks a
 * terrain-protection rule may therefore let a road or a foundation touch.
 */
export const CONSTRUCTED_NAMES = [
  'stone_bricks',
  'mossy_stone_bricks',
  'cracked_stone_bricks',
  'chiseled_stone_bricks',
  'smooth_stone',
  'smooth_stone_slab',
  'polished_diorite',
  'polished_andesite',
  'polished_granite',
  'polished_deepslate',
  'smooth_sandstone',
  'cut_sandstone',
  'bricks',
  'stone_brick_slab',
  'stone_brick_stairs',
  'deepslate_tiles',
  'deepslate_bricks',
  'dark_prismarine',
  'prismarine_bricks',
  'nether_bricks',
  'quartz_block',
  'smooth_quartz',
  'sea_lantern',
  'glowstone',
  'glass',
] as const;

/** Suffixes that always describe a crafted building material, never ground. */
export const CONSTRUCTED_SUFFIXES = [
  '_planks',
  '_bricks',
  '_tiles',
  '_glass',
  '_wool',
  '_concrete',
  '_terracotta',
  '_glazed',
  '_slab',
  '_stairs',
  '_fence',
  '_wall',
  '_door',
  '_trapdoor',
  '_carpet',
  '_pane',
  '_button',
  '_pressure_plate',
  '_sign',
] as const;

const CONSTRUCTED_SET = new Set<string>(CONSTRUCTED_NAMES);

/** True when a block name is a built material rather than natural ground. */
export function isConstructedName(name: string): boolean {
  const short = name.replace(/^minecraft:/, '');
  if (CONSTRUCTED_SET.has(short)) return true;
  return CONSTRUCTED_SUFFIXES.some((suffix) => short.endsWith(suffix));
}
