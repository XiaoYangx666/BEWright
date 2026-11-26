import { parseParamFlags, resolveBuildingArgs, type BuildingArgs } from '../content/definition.js';
import type { ContentOptions } from '../content/discover.js';
import type { LoadedBuilding } from '../content/load.js';

export type Triple = [number, number, number];

/** `x,y,z` CLI integer triple. */
export function parseTriple(raw: string, label: string): Triple {
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error(`${label} must be three integers, e.g. "0,64,0"`);
  return parts as Triple;
}

export function contentOptions(values: { content?: string[] }): ContentOptions {
  return values.content?.length ? { roots: values.content } : {};
}

export function buildingArgs(loaded: LoadedBuilding, values: { param?: string[] }): BuildingArgs {
  return resolveBuildingArgs(loaded.definition.params, parseParamFlags(values.param ?? []));
}

export function csv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

export const CONTENT_OPTION = { type: 'string', multiple: true } as const;
export const PARAM_OPTION = { type: 'string', multiple: true } as const;
