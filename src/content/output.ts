import { join } from 'node:path';
import type { LoadedBuilding } from './load.js';

export function buildingOutputDir(
  building: LoadedBuilding,
  kind: 'bedrock' | 'previews' | 'diagnostics' | 'bedrock-worlds' | 'java-worlds',
) {
  return join(building.discovered.root, 'output', kind);
}
