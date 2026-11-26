import type { DiagnosticObject } from '../diagnostic-core.js';
import type { WaterSegmentSpec } from './contracts.js';

export function segmentObject(plan: WaterSegmentSpec): DiagnosticObject {
  return { kind: `water-${plan.kind}`, id: plan.id };
}
