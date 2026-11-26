import { Structure } from '../../core/structure.js';
import { Components } from '../../core/components.js';
import { minecraftBlock } from '../../blocks/registry.js';

export const blockSamples = [
  'dirt',
  'grass_block',
  'oak_log',
  'copper_block',
  'sea_lantern',
  'basalt',
  'glass',
  'oak_leaves',
  'chest',
  'wooden_door',
  'spruce_stairs',
  'redstone_wire',
];

/** Engine fixture: one plinth per representative block, used by registry verification. */
export function blockGallery() {
  const components = new Components(),
    base = new Structure(),
    samples = new Structure();
  for (let i = 0; i < blockSamples.length; i++) {
    const x = (i % 4) * 4,
      z = Math.floor(i / 4) * 4;
    base.fill({ min: [x, 0, z], max: [x + 3, 1, z + 3] }, minecraftBlock('smooth_stone'));
    samples.set(x + 1, 1, z + 1, minecraftBlock(blockSamples[i]));
    if (blockSamples[i] === 'wooden_door')
      samples.set(x + 1, 2, z + 1, minecraftBlock('wooden_door', { upper_block_bit: true }));
  }
  components.replace('display-plinths', base);
  components.replace('block-samples', samples);
  return components;
}
