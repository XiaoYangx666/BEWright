import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertBox, type Box, Structure, type Vec3 } from '../../core/structure.js';
import { applyConnectionState, isConnectionBlock, toJavaBlockState, type JavaBlockState } from './blocks.js';
import { defaultJavaWorldsDir } from '../../project/config.js';
import { validateWorldFolderName } from '../../project/paths.js';
import { requireSidecar, runSidecarJson, sidecarBinary } from '../../project/sidecar.js';

export const JAVA_TARGET = Object.freeze({ gameVersion: '26.1.2', dataVersion: 4790, minY: -64, maxY: 320 });

export type JavaWorldOptions = {
  output?: string;
  worldsDir?: string;
  folderName?: string;
  name: string;
  spawn?: Vec3;
  seed?: number;
  binary?: string;
};

type JavaWorldPayload = {
  version: 1;
  name: string;
  gameVersion: string;
  dataVersion: number;
  seed: number;
  spawn: Vec3;
  palette: JavaBlockState[];
  blocks: Array<[number, number, number, number]>;
};

const executableName = 'blockwright-java-export';
export function defaultJavaExporterBinary() {
  return sidecarBinary(executableName);
}

export function encodeJavaWorld(
  structure: Structure,
  region: Box,
  options: Pick<JavaWorldOptions, 'name' | 'spawn' | 'seed'>,
): Buffer {
  assertBox(region);
  if (region.min[1] < JAVA_TARGET.minY || region.max[1] > JAVA_TARGET.maxY)
    throw new Error(`Java ${JAVA_TARGET.gameVersion} export Y range is ${JAVA_TARGET.minY}..${JAVA_TARGET.maxY - 1}`);
  // Connection-typed blocks (fences, walls, bars/panes) get a distinct palette
  // entry per unique neighbour-derived connection state, so the palette index
  // alone must not be the key. Otherwise a fence's missing north/east/south/west
  // defaults to false and every fence appears as an isolated post.
  const sourceBlocks: Array<[number, number, number, number]> = [];
  structure.forEach((x, y, z, id) => {
    sourceBlocks.push([x, y, z, id]);
  }, region);
  const palette: JavaBlockState[] = [];
  const keyIndex = new Map<string, number>();
  const blocks: Array<[number, number, number, number]> = [];
  for (const [x, y, z, id] of sourceBlocks) {
    const state = structure.palette[id];
    if (!state) throw new Error(`Missing palette state ${id}`);
    let key = String(id);
    let java: JavaBlockState | null = null;
    if (isConnectionBlock(state.name)) {
      java = toJavaBlockState(state);
      const props = { ...java.properties };
      applyConnectionState(structure, state.name, x, y, z, props);
      java = Object.freeze({ name: java.name, properties: Object.freeze(props) });
      key = `${id}|${JSON.stringify(java.properties)}`;
    }
    let index = keyIndex.get(key);
    if (index === undefined) {
      const entry = java ?? toJavaBlockState(state);
      index = palette.length;
      keyIndex.set(key, index);
      palette.push(entry);
    }
    blocks.push([x, y, z, index]);
  }
  const spawn = options.spawn ?? [region.min[0], Math.max(0, region.min[1]), region.min[2]];
  if (![...spawn, options.seed ?? 0].every(Number.isSafeInteger))
    throw new Error('Java world spawn and seed must be safe integers');
  const payload: JavaWorldPayload = {
    version: 1,
    name: options.name,
    gameVersion: JAVA_TARGET.gameVersion,
    dataVersion: JAVA_TARGET.dataVersion,
    seed: options.seed ?? 0,
    spawn,
    palette,
    blocks,
  };
  return Buffer.from(JSON.stringify(payload));
}

export async function exportJavaWorld(structure: Structure, region: Box, options: JavaWorldOptions) {
  const output = options.output
    ? resolve(options.output)
    : join(resolve(options.worldsDir ?? (await defaultJavaWorldsDir())), validateWorldFolderName(options.folderName ?? options.name.trim()));
  if (existsSync(output)) throw new Error(`Refusing to overwrite Java world: ${output}`);
  const binary = options.binary ? resolve(options.binary) : requireSidecar(executableName);
  const input = encodeJavaWorld(structure, region, options);
  const report = await runSidecarJson<{
    ok: boolean;
    chunks: number;
    regions: number;
    blocks: number;
    dataVersion: number;
  }>(binary, ['--output', output], 'Java exporter', input);
  return { ...report, world: output } as {
    ok: true;
    world: string;
    chunks: number;
    regions: number;
    blocks: number;
    dataVersion: number;
  };
}
