import type { State } from '../core/structure.js';

/** Transport contracts shared by block inspection and preview; no adapter dependencies. */
export type BlockSupportGate = {
  status: 'supported' | 'unsupported' | 'unknown' | 'mapped';
  detail: string;
};
export type BlockSupportReport = {
  name: string;
  states: State['states'];
  registry: BlockSupportGate;
  materialHelper: BlockSupportGate;
  preview: BlockSupportGate;
  collision: BlockSupportGate;
  bedrock: BlockSupportGate;
  javaMapping: BlockSupportGate;
};
export type BuildingBlockSupportReport = (BlockSupportReport & { count: number; sample: number[] })[];
