import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { Structure, type StructureSnapshot } from '../core/structure.js';
import { CACHE_ROOT, PROJECT_ROOT, within } from '../project/paths.js';
import { TOOL_ROOT } from '../project/context.js';

const VERSION = 2;
type CachedStage = { version: number; fingerprint: string; checksum: string; payload: Uint8Array };

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) files.push(...sourceFiles(path));
    else if (item.isFile() && /\.(?:ts|js|json|mjs)$/.test(item.name) && !item.name.endsWith('.d.ts'))
      files.push(path);
  }
  return files;
}

function dependencies(sources: readonly string[]): string[] {
  return [
    ...sourceFiles(fileURLToPath(new URL('../', import.meta.url))),
    join(TOOL_ROOT, 'package.json'),
    ...[join(TOOL_ROOT, 'package-lock.json'), join(PROJECT_ROOT, 'package-lock.json')].filter(existsSync),
    ...sources,
  ];
}

function fingerprint(files: readonly string[], inputs: Readonly<Record<string, string | number | boolean>>): string {
  const hash = createHash('sha256');
  hash.update(`generation-stage-v${VERSION}|node-${process.version}\n`);
  hash.update(JSON.stringify(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))));
  for (const file of [...new Set(files.map((path) => resolve(PROJECT_ROOT, path)))].sort()) {
    hash.update(file.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

/**
 * Cache a self-contained, deterministic generation stage. `sources` must list
 * every building file that can affect this stage. The active framework runtime
 * and available npm lockfiles are included automatically. Edits to later building
 * stages do not invalidate this stage. Corrupt or stale cache data is rebuilt.
 */
export function cachedStructureStage(request: Readonly<{
  key: string;
  sources: readonly string[];
  /** Every non-file input read by build(), including parameters and seeds. */
  inputs: Readonly<Record<string, string | number | boolean>>;
  build: () => Structure;
  cacheDir?: string;
}>): { world: Structure; source: 'built' | 'cached' } {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(request.key)) throw new Error('Invalid generation cache key');
  const cacheDir = resolve(PROJECT_ROOT, request.cacheDir ?? join(CACHE_ROOT, 'generation'));
  if (!within(PROJECT_ROOT, cacheDir)) throw new Error(`Generation cache outside project: ${cacheDir}`);
  const files = dependencies(request.sources);
  const digest = fingerprint(files, request.inputs);
  const file = join(cacheDir, `${request.key}.bin`);
  try {
    const packet = deserialize(readFileSync(file)) as CachedStage;
    if (packet.version === VERSION && packet.fingerprint === digest &&
      createHash('sha256').update(packet.payload).digest('hex') === packet.checksum)
      return { world: Structure.fromSnapshot(deserialize(packet.payload) as StructureSnapshot), source: 'cached' };
  } catch {
    // A missing or damaged cache is a normal miss; the generator is authoritative.
  }
  const world = request.build();
  // If source files changed during generation, do not publish a cache that
  // could attach the old in-memory module to the new source fingerprint.
  if (fingerprint(files, request.inputs) === digest) {
    let temporary = '';
    try {
      const payload = serialize(world.snapshot());
      const packet: CachedStage = {
        version: VERSION,
        fingerprint: digest,
        checksum: createHash('sha256').update(payload).digest('hex'),
        payload,
      };
      mkdirSync(dirname(file), { recursive: true });
      temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(temporary, serialize(packet));
      renameSync(temporary, file);
    } catch {
      // Cache storage failure cannot prevent a correct build.
      try {
        if (temporary) rmSync(temporary, { force: true });
      } catch {
        // Best effort: a temporary file is safe to leave for cleanup.
      }
    }
  }
  return { world, source: 'built' };
}
