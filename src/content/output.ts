import { join } from 'node:path';
import { loadBlockwrightConfig } from '../project/config.js';
import { DEFAULT_PROJECT, type ProjectContext } from '../project/context.js';
import type { LoadedBuilding } from './load.js';

export async function buildingOutputDir(
  building: LoadedBuilding,
  kind: 'bedrock' | 'previews' | 'diagnostics' | 'bedrock-worlds' | 'java-worlds',
  project: ProjectContext = DEFAULT_PROJECT,
) {
  const { outputRoot } = await loadBlockwrightConfig(undefined, { absolutePaths: true, root: project.root });
  if (outputRoot) return join(outputRoot, kind, building.definition.id);
  return join(building.discovered.root, 'output', kind);
}
