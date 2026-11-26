import type { Vec3 } from './structure.js';

/** Preview geometry report shape, also carried by legacy building checks. */
export type GeometryDiagnostic = {
  code: 'placeholder';
  name: string;
  states: Readonly<Record<string, string | number | boolean>>;
  reason: string;
  count: number;
  samples: Vec3[];
};
