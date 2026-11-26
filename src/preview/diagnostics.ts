import type { Box } from '../core/structure.js';
import type { Diagnostic } from '../authoring/diagnostic-core.js';

export type DiagnosticMarker = Readonly<{ bounds: Box; color: string; rule: string; object: string }>;
/** Read-only overlays; diagnostic coordinates never become voxel geometry. */
export function diagnosticMarkers(findings: readonly Diagnostic[], region: Box): DiagnosticMarker[] {
  return findings.flatMap((d) => {
    if (d.severity === 'info') return [];
    const p = d.target.position;
    const bounds = d.target.region ?? (p ? { min: p, max: p.map((v) => v + 1) as Box['max'] } : null);
    if (!bounds || bounds.min.some((v, axis) => v >= region.max[axis] || bounds.max[axis]! <= region.min[axis]!))
      return [];
    return [
      {
        bounds,
        color: d.severity === 'error' ? '#ff3159' : '#ffb32c',
        rule: d.rule,
        object: `${d.object.kind}:${d.object.id}`,
      },
    ];
  });
}
