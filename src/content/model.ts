import { applyBedrockWallConnections } from '../blocks/connections.js';
import { assertBox, Structure, type Box } from '../core/structure.js';
import { buildingModelWorld, type BuildingArgs, type BuildingDefinition } from './definition.js';

/** Internal model stages; generation never performs checks, rendering or I/O. */
export function buildModel(definition: BuildingDefinition, args: BuildingArgs, build = definition.build) {
  const model = build === definition.build ? definition.build(args) : build(args);
  const { world, components } = buildingModelWorld(model);
  return { model, world, components, sourceRevision: world.revision };
}

/** Target preparation is explicit: Java derives its own states in its encoder. */
export function prepareModel(
  world: Structure,
  region: Box,
  options: { connections: 'bedrock' | 'preserve'; detached?: boolean },
): Structure {
  assertBox(region);
  const prepared = options.detached ? Structure.fromSnapshot(world.snapshot()) : world;
  if (options.connections === 'bedrock') applyBedrockWallConnections(prepared, region);
  return prepared;
}

/** One command, fixed parameters: generate each distinct source once. */
export function modelSession(definition: BuildingDefinition, args: BuildingArgs) {
  const sources = new Map<BuildingDefinition['build'], ReturnType<typeof buildModel>>();
  const prepared = new Map<Structure, Map<string, Structure>>();
  return {
    generate(build = definition.build) {
      let result = sources.get(build);
      if (!result) {
        result = buildModel(definition, args, build);
        sources.set(build, result);
      }
      return result;
    },
    /** Region-specific wall derivation must not contaminate another view's source. */
    preview(world: Structure, region: Box) {
      let regions = prepared.get(world);
      if (!regions) prepared.set(world, (regions = new Map()));
      const key = JSON.stringify([region.min, region.max]);
      let result = regions.get(key);
      if (!result) {
        result = prepareModel(world, region, { connections: 'bedrock', detached: true });
        regions.set(key, result);
      }
      return result;
    },
  };
}
