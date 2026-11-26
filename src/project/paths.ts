import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_PROJECT, type ProjectContext } from './context.js';

export const PROJECT_ROOT = DEFAULT_PROJECT.root;
export const ARTIFACT_ROOT = DEFAULT_PROJECT.artifacts;
export const CACHE_ROOT = DEFAULT_PROJECT.cache;
export const WORLD_ROOT = DEFAULT_PROJECT.worlds;

export function within(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

export function validateWorldFolderName(name: string) {
  if (
    !name ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) throw new Error(`Invalid world folder name: ${name}`);
  return name;
}

export async function atomicWrite(path: string, data: string | Uint8Array) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function fileRecord(path: string, project: ProjectContext = DEFAULT_PROJECT) {
  const target = resolve(project.root, path);
  const bytes = await import('node:fs/promises').then((fs) => fs.readFile(target));
  return {
    path: relative(project.root, target).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function manifest(
  scene: string,
  parameters: Record<string, unknown>,
  files: string[],
  validation: Record<string, unknown>,
  project: ProjectContext = DEFAULT_PROJECT,
) {
  const packageJson = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')),
  );
  const records = [];
  for (const file of files)
    if ((await stat(resolve(project.root, file)).catch(() => undefined))?.isFile()) records.push(await fileRecord(file, project));
  return {
    schemaVersion: 1,
    scene,
    source: { package: packageJson.name, version: packageJson.version, node: process.version },
    parameters,
    generatedAt: new Date().toISOString(),
    files: records,
    validation,
  };
}
