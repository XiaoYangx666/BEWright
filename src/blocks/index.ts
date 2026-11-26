export { TARGET } from './target.js';
export { registrySource, registryBlocks, registryBlock, validateBlockState, minecraftBlock } from './registry.js';
export type { RegistryBlock } from './registry.js';
export { applyBedrockWallConnections, isWallBlock, wallConnectionsAt } from './connections.js';
export type { WallConnections } from './connections.js';
export {
  PLACEHOLDER_COLOR,
  familyGeometry,
  materials,
  colors,
  materialName,
  material,
  colorProfile,
  previewStyles,
} from './materials.js';
export type { GeometryKind, Material } from './materials.js';
export { kind, fullCube, validateVisual, visualGeometry, boxes } from './shapes.js';
export type { Cuboid } from './shapes.js';
