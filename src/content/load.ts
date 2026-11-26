import { pathToFileURL } from 'node:url';
import { defineBuilding, type BuildingDefinition } from './definition.js';
import type { DiscoveredBuilding } from './discover.js';

export type LoadedBuilding = Readonly<{
  discovered: DiscoveredBuilding;
  definition: BuildingDefinition;
}>;

/**
 * Execute a building entry module and validate its definition against the
 * manifest. Entry modules are loaded dynamically, so the tool never imports
 * building code statically.
 */
export async function loadBuilding(discovered: DiscoveredBuilding): Promise<LoadedBuilding> {
  let module: { default?: unknown; building?: unknown };
  try {
    module = (await import(pathToFileURL(discovered.entry).href)) as { default?: unknown; building?: unknown };
  } catch (error) {
    throw new Error(`Failed to load building "${discovered.id}" from ${discovered.entry}: ${(error as Error).message}`);
  }
  const candidate = module.default ?? module.building;
  if (!candidate || typeof candidate !== 'object')
    throw new Error(`${discovered.entry}: expected "export default defineBuilding({...})"`);
  const definition = defineBuilding(candidate as BuildingDefinition);
  if (definition.id !== discovered.id)
    throw new Error(`Building id mismatch: manifest says "${discovered.id}", definition says "${definition.id}"`);
  // The manifest and the definition must agree on name and editions: `list`
  // reports the manifest values while export honors the definition's, so a
  // silent divergence would show one edition list and enforce another.
  if (definition.name !== discovered.name)
    throw new Error(`Building name mismatch: manifest says "${discovered.name}", definition says "${definition.name}"`);
  const definitionEditions = definition.editions ?? ['bedrock'];
  const editionsMatch =
    definitionEditions.length === discovered.editions.length &&
    definitionEditions.every((edition) => discovered.editions.includes(edition));
  if (!editionsMatch)
    throw new Error(
      `Building editions mismatch for "${discovered.id}": manifest says [${discovered.editions.join(', ')}], definition says [${definitionEditions.join(', ')}]`,
    );
  return Object.freeze({ discovered, definition });
}

export async function loadBuildings(buildings: readonly DiscoveredBuilding[]): Promise<LoadedBuilding[]> {
  const loaded: LoadedBuilding[] = [];
  for (const building of buildings) loaded.push(await loadBuilding(building));
  return loaded;
}
