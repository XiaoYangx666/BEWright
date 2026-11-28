import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, join, resolve } from 'node:path';
import { loadBlockwrightConfig } from '../project/config.js';
import { PROJECT_ROOT, within } from '../project/paths.js';
import type { BuildingEdition } from './definition.js';

export const BUILDING_MANIFEST = 'blockwright.building.json';
export const DEFAULT_CONTENT_ROOT = 'buildings';

export type BuildingStatus = 'stable' | 'wip';

export type BuildingManifest = Readonly<{
  schemaVersion: number;
  id: string;
  name: string;
  entry: string;
  editions?: readonly BuildingEdition[];
  /** `wip` content is skipped by the all-buildings test gate but still buildable by id. */
  status?: BuildingStatus;
}>;

/** A building as found on disk, before its entry module is executed. */
export type DiscoveredBuilding = Readonly<{
  id: string;
  name: string;
  root: string;
  entry: string;
  manifestPath: string;
  editions: readonly BuildingEdition[];
  status: BuildingStatus;
  source: string;
}>;

export type ContentRoot = Readonly<{ path: string; source: string }>;

export type ContentOptions = Readonly<{ roots?: readonly string[] }>;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const isBuildingId = (id: unknown): id is string => typeof id === 'string' && ID_PATTERN.test(id);

/**
 * Content roots in precedence order: explicit `--content`, then the
 * BLOCKWRIGHT_CONTENT_PATH list, then configured content roots, then sourceRoot or `buildings/`.
 */
export async function resolveContentRoots(options: ContentOptions = {}): Promise<ContentRoot[]> {
  const roots: ContentRoot[] = [];
  const push = (path: string, source: string) => {
    if (!path.trim()) return;
    const resolved = resolve(PROJECT_ROOT, path);
    if (!roots.some((root) => root.path === resolved)) roots.push({ path: resolved, source });
  };
  for (const root of options.roots ?? []) push(root, '--content');
  for (const root of (process.env.BLOCKWRIGHT_CONTENT_PATH ?? '').split(delimiter))
    push(root, 'BLOCKWRIGHT_CONTENT_PATH');
  const config = await loadBlockwrightConfig(undefined, { absolutePaths: true });
  for (const root of config.contentRoots ?? [])
    push(root, 'blockwright.config.json');
  push(config.sourceRoot ?? DEFAULT_CONTENT_ROOT, config.sourceRoot ? 'sourceRoot' : 'default');
  return roots;
}

function parseManifest(manifestPath: string, source: string, raw: string): DiscoveredBuilding {
  const manifest = JSON.parse(raw.replace(/^\uFEFF/, '')) as BuildingManifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error(`${manifestPath}: expected a building manifest object`);
  if (manifest.schemaVersion !== 1)
    throw new Error(`${manifestPath}: unsupported schemaVersion ${manifest.schemaVersion}`);
  if (!isBuildingId(manifest.id))
    throw new Error(`${manifestPath}: id must be a lowercase slug`);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error(`${manifestPath}: name is required`);
  if (typeof manifest.entry !== 'string' || !manifest.entry.trim())
    throw new Error(`${manifestPath}: entry is required`);
  const root = resolve(manifestPath, '..');
  const entry = resolve(root, manifest.entry);
  if (!within(root, entry)) throw new Error(`${manifestPath}: entry must stay inside the building folder`);
  const editions = manifest.editions ?? ['bedrock'];
  if (!Array.isArray(editions) || editions.length === 0 || new Set(editions).size !== editions.length)
    throw new Error(`${manifestPath}: editions must be a nonempty array without duplicates`);
  for (const edition of editions)
    if (edition !== 'bedrock' && edition !== 'java') throw new Error(`${manifestPath}: unknown edition ${edition}`);
  const status = manifest.status ?? 'stable';
  if (status !== 'stable' && status !== 'wip') throw new Error(`${manifestPath}: status must be stable or wip`);
  return Object.freeze({
    id: manifest.id,
    name: manifest.name,
    root,
    entry,
    manifestPath,
    editions: Object.freeze([...editions]),
    status,
    source,
  });
}

/** Scan every content root for building manifests, rejecting duplicate ids. */
export async function discoverBuildings(options: ContentOptions = {}): Promise<DiscoveredBuilding[]> {
  const found: DiscoveredBuilding[] = [];
  const seen = new Map<string, DiscoveredBuilding>();
  for (const root of await resolveContentRoots(options)) {
    const info = await stat(root.path).catch(missingFile);
    if (!info && root.source === '--content') throw new Error(`Content path not found: ${root.path}`);
    if (!info) continue;
    let candidates: string[];
    const manifest = join(root.path, BUILDING_MANIFEST);
    if (info.isFile() && basename(root.path) === BUILDING_MANIFEST) candidates = [root.path];
    else if (!info.isDirectory()) throw new Error(`Expected a content directory or ${BUILDING_MANIFEST}: ${root.path}`);
    else if ((await stat(manifest).catch(missingFile))?.isFile()) candidates = [manifest];
    else {
      const entries = await readdir(root.path, { withFileTypes: true });
      candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root.path, entry.name, BUILDING_MANIFEST));
    }
    for (const candidate of candidates) {
      const raw = await readFile(candidate, 'utf8').catch(missingFile);
      if (raw === undefined) continue;
      const manifestPath = await realpath(candidate);
      const building = parseManifest(manifestPath, root.source, raw);
      const existing = seen.get(building.id);
      if (existing?.manifestPath === manifestPath) continue;
      if (existing)
        throw new Error(
          `Duplicate building id "${building.id}": ${existing.manifestPath} and ${building.manifestPath}`,
        );
      seen.set(building.id, building);
      found.push(building);
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function missingFile(error: NodeJS.ErrnoException) {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
}

export async function findBuilding(id: string, options: ContentOptions = {}): Promise<DiscoveredBuilding> {
  if (id === '.' || id === '..' || /[\\/]/.test(id) || id === BUILDING_MANIFEST) {
    const path = resolve(id);
    const manifest = basename(path) === BUILDING_MANIFEST ? path : join(path, BUILDING_MANIFEST);
    const manifestPath = await realpath(manifest);
    return parseManifest(manifestPath, 'path', await readFile(manifestPath, 'utf8'));
  }
  const buildings = await discoverBuildings(options);
  const building = buildings.find((candidate) => candidate.id === id);
  if (!building) {
    const known = buildings.map((candidate) => candidate.id).join(', ') || '(none)';
    throw new Error(`Unknown building "${id}". Discovered: ${known}`);
  }
  return building;
}
