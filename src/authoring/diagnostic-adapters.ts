import type { Vec3 } from '../core/structure.js';
import type { GeometryDiagnostic as MeshDiagnostic } from '../core/geometry-diagnostic.js';
import { coordinateDiagnostic, type Diagnostic } from './diagnostic-core.js';

/** Compatibility conversions, used at model-check and preview-report boundaries. */
/** 预览网格诊断（洋红占位几何）→ 诊断。它只说明预览不可信，不代表模型错误。 */
export function fromMeshDiagnostic(diagnostic: MeshDiagnostic, view?: string): Diagnostic {
  const first = diagnostic.samples[0];
  return coordinateDiagnostic({
    rule: 'model.placeholder-geometry',
    severity: 'warning',
    object: { kind: 'geometry', id: diagnostic.name },
    message: `${diagnostic.name} 没有确认的视觉几何（${diagnostic.count} 格，预览显示为占位色）`,
    ...(first ? { position: first } : {}),
    source: 'mesh',
    data: { meshCode: diagnostic.code, reason: diagnostic.reason, count: diagnostic.count, ...(view ? { view } : {}) },
  });
}

export function fromMeshDiagnostics(diagnostics: readonly MeshDiagnostic[], view?: string): Diagnostic[] {
  return diagnostics.map((diagnostic) => fromMeshDiagnostic(diagnostic, view));
}

/**
 * 统一诊断 → 旧的预览网格诊断形状。
 *
 * 只为兼容既有建筑的 `check({ diagnostics })`（它们靠 `code === 'placeholder'`
 * 判断"预览几何未确认"）。字段名刻意保持一致，`code` 用规则编号。
 */
export function toLegacyMeshDiagnostics(diagnostics: readonly Diagnostic[]): MeshDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: (diagnostic.rule === 'model.placeholder-geometry'
      ? 'placeholder'
      : diagnostic.rule) as MeshDiagnostic['code'],
    name: diagnostic.object.id,
    states:
      diagnostic.data?.states && typeof diagnostic.data.states === 'object'
        ? (diagnostic.data.states as MeshDiagnostic['states'])
        : {},
    reason: diagnostic.message,
    count: typeof diagnostic.data?.count === 'number' ? diagnostic.data.count : 1,
    samples: diagnostic.target.position ? [[...diagnostic.target.position] as Vec3] : [],
  }));
}
