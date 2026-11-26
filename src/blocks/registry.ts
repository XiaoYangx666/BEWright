import { readFileSync } from 'node:fs';
import { block, type State } from '../core/structure.js';
import { TARGET } from './target.js';
export type RegistryBlock = Readonly<{
  name: string;
  defaultStates: State['states'];
  variants: readonly State['states'][];
  transparent: boolean;
  filterLight: number;
  emitLight: number;
  boundingBox: string;
  uniformFullCollision: boolean;
  /** Every variant collides as either a full cube or not at all (data quirk tolerant). */
  cubeLike: boolean;
}>;
/**
 * On-disk form, tuned for size (1.66 MB -> ~265 KB):
 * - `stateKeys` + `domains` once per block, `default`/`variants` as index tuples;
 * - stateless blocks omit all four;
 * - `f` packs [transparent, filterLight, emitLight, boundingBoxIndex,
 *   uniformFullCollision, cubeLike] and `boundingBoxes` is the shared table.
 * The loader expands this into `RegistryBlock`, so nothing else changes.
 */
type CompactBlock = Readonly<{
  name: string;
  stateKeys?: readonly string[];
  domains?: readonly (readonly (string | number | boolean)[])[];
  default?: readonly number[];
  variants?: readonly (readonly number[])[];
  f: readonly [number, number, number, number, number, number];
}>;
type RegistryData = {
  source: {
    package: string;
    packageVersion: string;
    license: string;
    target: typeof TARGET;
    stateCount: number;
    sourceHash: string;
    notes: string;
  };
  boundingBoxes: readonly string[];
  blocks: CompactBlock[];
};
const raw: RegistryData = JSON.parse(
  readFileSync(new URL('./generated/bedrock-registry.json', import.meta.url), 'utf8'),
);
if (JSON.stringify(raw.source.target) !== JSON.stringify(TARGET))
  throw new Error('Generated registry target mismatch; regenerate');
export const registrySource = Object.freeze(raw.source);
const entries = new Map<string, RegistryBlock>(),
  valid = new Map<string, Set<string>>();
const stateKey = (states: State['states']) =>
  JSON.stringify(Object.entries(states).sort(([a], [b]) => a.localeCompare(b)));
const expandStates = (
  keys: readonly string[],
  domains: readonly (readonly (string | number | boolean)[])[],
  indexes: readonly number[],
): State['states'] =>
  Object.freeze(Object.fromEntries(keys.map((key, index) => [key, domains[index]?.[indexes[index]!]])));
for (const compact of raw.blocks) {
  const stateKeys = compact.stateKeys ?? [];
  const domains = compact.domains ?? [];
  const [transparent, filterLight, emitLight, boundingBox, uniformFullCollision, cubeLike] = compact.f;
  const b: RegistryBlock = Object.freeze({
    name: compact.name,
    defaultStates: expandStates(stateKeys, domains, compact.default ?? []),
    variants: Object.freeze((compact.variants ?? [[]]).map((indexes) => expandStates(stateKeys, domains, indexes))),
    transparent: transparent === 1,
    filterLight,
    emitLight,
    boundingBox: raw.boundingBoxes[boundingBox] ?? 'block',
    uniformFullCollision: uniformFullCollision === 1,
    cubeLike: cubeLike === 1,
  });
  entries.set(b.name, b);
  valid.set(b.name, new Set(b.variants.map(stateKey)));
}
export const registryBlocks: readonly RegistryBlock[] = Object.freeze([...entries.values()]);
export function registryBlock(name: string): RegistryBlock {
  const key = name.replace(/^minecraft:/, '');
  const b = entries.get(key);
  if (!b) throw new Error(`Unknown Bedrock ${TARGET.gameVersion} block: ${name}`);
  return b;
}
const checked = new WeakSet<State>();
/** Exact types, complete key set and combination. Numeric 0 is not a byte boolean. */
export function validateBlockState(s: State): void {
  if (checked.has(s)) return;
  const b = registryBlock(s.name);
  if (!valid.get(b.name)!.has(stateKey(s.states)))
    throw new Error(
      `Invalid Bedrock state for ${s.name}: ${JSON.stringify(s.states)} — incomplete or illegal. ` +
        `Use minecraftBlock('${b.name}', overrides) to fill the pinned defaults, or pass the complete typed state set.`,
    );
  if (Object.isFrozen(s) && Object.isFrozen(s.states)) checked.add(s);
}
const blockCache = new Map<string, State>();
/**
 * Fill missing states from the pinned default, then validate the whole combination.
 * Results are cached per (name, overrides): scene code calls this per placed block,
 * and every cached hit skips the registry lookup, default expansion and validation.
 */
export function minecraftBlock(name: string, overrides: State['states'] = {}): State {
  const key = Object.keys(overrides).length ? `${name}|${stateKey(overrides)}` : name;
  const cached = blockCache.get(key);
  if (cached) return cached;
  const b = registryBlock(name),
    s = block(b.name, { ...b.defaultStates, ...overrides });
  validateBlockState(s);
  blockCache.set(key, s);
  return s;
}
