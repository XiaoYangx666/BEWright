import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { Structure } from '../core/structure.js';
import { atomicWrite } from '../project/paths.js';
import { LightField, type LightFieldSnapshot } from './light.js';

export const LIGHT_CACHE_FILE = 'light.bin';
export type LightCacheRef = Readonly<{ world: string; checksum: string }>;

export function lightWorldHash(signature: { palette: string; chunks: Record<string, string> }): string {
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex');
}

export async function readLightCache(cacheDir: string, reference: LightCacheRef, world: Structure, expectedWorld: string) {
  if (reference.world !== expectedWorld) return null;
  try {
    const bytes = await readFile(join(cacheDir, LIGHT_CACHE_FILE));
    if (createHash('sha256').update(bytes).digest('hex') !== reference.checksum) return null;
    return LightField.fromSnapshot(world, deserialize(bytes) as LightFieldSnapshot);
  } catch {
    // Missing, damaged, or incompatible cache: rebuild authoritative lighting.
    return null;
  }
}

export async function writeLightCache(cacheDir: string, light: LightField, world: string): Promise<LightCacheRef> {
  const bytes = serialize(light.snapshot());
  await atomicWrite(join(cacheDir, LIGHT_CACHE_FILE), bytes);
  return { world, checksum: createHash('sha256').update(bytes).digest('hex') };
}
