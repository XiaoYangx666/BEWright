import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type MinecraftEdition = 'java' | 'bedrock';
export type BlockwrightConfig = Readonly<{
  worldDirectories?: Readonly<Partial<Record<MinecraftEdition, string | null>>>;
  /** Extra building content roots, searched before the default `buildings/`. */
  contentRoots?: readonly string[];
  sourceRoot?: string;
  outputRoot?: string;
}>;

export const DEFAULT_CONFIG_PATH = 'blockwright.config.json';
const LOCAL_CONFIG_PATH = 'blockwright.local.json';

async function readConfig(configPath: string, absolutePaths: boolean): Promise<BlockwrightConfig> {
  const source = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  const config = JSON.parse(source.replace(/^\uFEFF/, '')) as BlockwrightConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error(`Expected a configuration object in ${configPath}`);
  if (
    config.worldDirectories !== undefined &&
    (config.worldDirectories === null || typeof config.worldDirectories !== 'object' || Array.isArray(config.worldDirectories))
  )
    throw new Error(`worldDirectories must be an object in ${configPath}`);
  for (const edition of ['java', 'bedrock'] as const) {
    const value = config.worldDirectories?.[edition];
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value.trim()))
      throw new Error(`worldDirectories.${edition} must be a nonempty path or null in ${configPath}`);
  }
  if (
    config.contentRoots !== undefined &&
    (!Array.isArray(config.contentRoots) ||
      config.contentRoots.some((root) => typeof root !== 'string' || !root.trim()))
  )
    throw new Error(`contentRoots must be an array of nonempty paths in ${configPath}`);
  for (const key of ['sourceRoot', 'outputRoot'] as const) {
    const path = config[key];
    if (path !== undefined && (typeof path !== 'string' || !path.trim()))
      throw new Error(`${key} must be a nonempty path in ${configPath}`);
  }
  if (!absolutePaths) return config;
  const root = dirname(configPath);
  const worldDirectories: Partial<Record<MinecraftEdition, string | null>> = {};
  for (const edition of ['java', 'bedrock'] as const) {
    const path = config.worldDirectories?.[edition];
    if (path !== undefined) worldDirectories[edition] = path === null ? null : resolve(root, path);
  }
  return {
    ...(config.worldDirectories && { worldDirectories }),
    ...(config.contentRoots && { contentRoots: config.contentRoots.map((path) => resolve(root, path)) }),
    ...(config.sourceRoot && { sourceRoot: resolve(root, config.sourceRoot) }),
    ...(config.outputRoot && { outputRoot: resolve(root, config.outputRoot) }),
  };
}

export async function loadBlockwrightConfig(
  path = process.env.BLOCKWRIGHT_CONFIG,
  { absolutePaths = false, root = process.cwd() } = {},
): Promise<BlockwrightConfig> {
  if (path !== undefined) return readConfig(resolve(root, path), absolutePaths);
  const config = await readConfig(resolve(root, DEFAULT_CONFIG_PATH), absolutePaths);
  const local = await readConfig(resolve(root, LOCAL_CONFIG_PATH), absolutePaths);
  return {
    ...config,
    ...local,
    ...(config.worldDirectories || local.worldDirectories
      ? { worldDirectories: { ...config.worldDirectories, ...local.worldDirectories } }
      : {}),
  };
}

export async function configuredWorldsDir(edition: MinecraftEdition): Promise<string | undefined> {
  const environment =
    edition === 'java'
      ? process.env.BLOCKWRIGHT_JAVA_WORLDS_DIR
      : (process.env.BLOCKWRIGHT_BEDROCK_WORLDS_DIR ?? process.env.BLOCKWRIGHT_WORLDS_DIR);
  const configured = environment ?? (await loadBlockwrightConfig(undefined, { absolutePaths: true })).worldDirectories?.[edition];
  return configured ? resolve(configured) : undefined;
}

export async function defaultJavaWorldsDir(): Promise<string> {
  const configured = await configuredWorldsDir('java');
  if (!configured)
    throw new Error('No Java saves directory configured; set worldDirectories.java or BLOCKWRIGHT_JAVA_WORLDS_DIR');
  return configured;
}
