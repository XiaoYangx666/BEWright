import { block, defineBuilding, Structure } from 'bewright';

export default defineBuilding({
  id: "starter-arch",
  name: "starter-arch",
  editions: ["bedrock","java"],
  bounds: { min: [0, 0, 0], max: [9, 6, 7] },
  spawn: [4, 1, 1],
  build() {
    const world = new Structure();
    const stone = block('stone');
    world.fill({ min: [0, 0, 0], max: [9, 1, 7] }, stone);
    world.fill({ min: [2, 1, 3], max: [3, 5, 4] }, stone);
    world.fill({ min: [6, 1, 3], max: [7, 5, 4] }, stone);
    world.fill({ min: [2, 5, 3], max: [7, 6, 4] }, stone);
    return world;
  },
  check({ world }) {
    if (!world.get(4, 0, 1)) throw new Error('Missing floor below the spawn point');
  },
});
