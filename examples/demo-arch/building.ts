import { block, Components, defineBuilding, Structure } from 'bewright';

export default defineBuilding({
  id: 'demo-arch',
  name: 'Demo Arch',
  editions: ['bedrock', 'java'],
  bounds: { min: [0, 0, 0], max: [9, 8, 7] },
  spawn: [4, 1, 1],
  params: { height: { type: 'int', default: 5, min: 4, max: 7 } },
  views: [{ name: 'front', view: 'front' }],
  build({ height }) {
    const openingTop = Number(height);
    const model = new Components();
    const base = new Structure();
    base.fill({ min: [0, 0, 0], max: [9, 1, 7] }, block('stone'));
    model.replace('base', base);

    const arch = new Structure();
    const brick = block('stone_bricks');
    arch.fill({ min: [2, 1, 3], max: [3, openingTop, 4] }, brick);
    arch.fill({ min: [6, 1, 3], max: [7, openingTop, 4] }, brick);
    arch.fill({ min: [2, openingTop, 3], max: [7, openingTop + 1, 4] }, brick);
    model.replace('arch', arch);
    return model;
  },
  check({ world }) {
    if (!world.get(4, 0, 3) || world.get(4, 1, 3) || world.get(4, 2, 3)) {
      throw new Error('The passage needs a floor and two blocks of headroom');
    }
  },
});
