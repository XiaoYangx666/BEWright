import type { Box, Vec3 } from '../core/structure.js';
import type { Components } from '../core/components.js';
import type { GeometryDiagnostic } from '../core/geometry-diagnostic.js';

/**
 * 统一诊断：框架里所有"生成后发现问题"的出口都归一到这一种形状。
 *
 * 强制字段是**规则编号 + 严重度 + 对象 + 位置**：没有这四样，报告就无法被机器
 * 消费，也无法定位到具体格。原因文本只用于人读。判不了的检查保留
 * `severity: 'unknown'` 并写清为什么判不了，绝不把"没跑"或"判不了"当成通过。
 */
export const SEVERITIES = ['error', 'warning', 'unknown', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type DiagnosticObject = Readonly<{
  /** Object kind, e.g. `start-pad`, `road`, `tree`, `waterfall`, `model`. */
  kind: string;
  /** Stable identity inside that kind, e.g. `A01`. */
  id: string;
  /** Who owns the object; buildings use this to scope avoidance and protection. */
  owner?: string;
}>;

export type DiagnosticTarget = Readonly<{
  /** Cell, inclusive point, or region. Half-open, matching core `Box`. */
  kind: 'cell' | 'region';
  /** Present for `cell`; the integer block coordinate (not the cell corner). */
  position?: Vec3;
  /** Present for `region`. */
  region?: Box;
}>;

export type Diagnostic = Readonly<{
  rule: string;
  severity: Severity;
  object: DiagnosticObject;
  target: DiagnosticTarget;
  /** Human-readable, localized reason. */
  message: string;
  /** Provenance, e.g. `check`, `surface`, `road-plan`, `building-check`. */
  source?: string;
  /** `false`means the rule ran and could not decide; surfaced as `unknown`. */
  conclusive?: boolean;
  data?: Readonly<Record<string, unknown>>;
}>;

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 3, warning: 2, unknown: 1, info: 0 };

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/** Highest severity present, or `null` for an empty list. */
export function worstSeverity(diagnostics: readonly Diagnostic[]): Severity | null {
  return diagnostics.reduce<Severity | null>(
    (worst, item) => (worst === null || severityRank(item.severity) > severityRank(worst) ? item.severity : worst),
    null,
  );
}

export type CoordinateDiagnosticInput = Readonly<{
  rule: string;
  message: string;
  object?: DiagnosticObject | string;
  /** Shorthand for `{ kind: 'model' }`. */
  severity?: Severity;
  position?: Vec3;
  region?: Box;
  source?: string;
  conclusive?: boolean;
  data?: Readonly<Record<string, unknown>>;
}>;

export function diagnosticObject(object: DiagnosticObject | string | undefined): DiagnosticObject {
  if (object === undefined) return { kind: 'model', id: 'model' };
  return typeof object === 'string' ? { kind: object, id: object } : object;
}

/** Build one diagnostic. Prefer `{ position }`; a region is for area-wide rules. */
export function coordinateDiagnostic(input: CoordinateDiagnosticInput): Diagnostic {
  return {
    rule: input.rule,
    severity: input.severity ?? 'error',
    object: diagnosticObject(input.object),
    target: input.position
      ? { kind: 'cell', position: input.position }
      : { kind: 'region', region: input.region ?? { min: [0, 0, 0], max: [0, 0, 0] } },
    message: input.message,
    ...(input.source ? { source: input.source } : {}),
    ...(input.conclusive === undefined ? {} : { conclusive: input.conclusive }),
    ...(input.data ? { data: input.data } : {}),
  };
}

export function regionDiagnostic(
  rule: string,
  message: string,
  region: Box,
  options: Omit<CoordinateDiagnosticInput, 'rule' | 'message' | 'region' | 'position'> = {},
): Diagnostic {
  return coordinateDiagnostic({ ...options, rule, message, region });
}

export function cellDiagnostic(
  rule: string,
  message: string,
  position: Vec3,
  options: Omit<CoordinateDiagnosticInput, 'rule' | 'message' | 'region' | 'position'> = {},
): Diagnostic {
  return coordinateDiagnostic({ ...options, rule, message, position });
}

/** `rule ↑ severity object @ x,y,z — message`, stable and grep-friendly. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { object, target } = diagnostic;
  const objectLabel = object.id && object.id !== object.kind ? `${object.kind}:${object.id}` : object.kind;
  const where =
    target.kind === 'cell' && target.position
      ? ` @ ${target.position.join(',')}`
      : target.region
        ? ` @ [${target.region.min.join(',')}]..[${target.region.max.join(',')}]`
        : '';
  return `${diagnostic.rule} ${diagnostic.severity} ${objectLabel}${where} — ${diagnostic.message}`;
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[], limit = 20): string[] {
  const lines = diagnostics.slice(0, limit).map(formatDiagnostic);
  if (diagnostics.length > limit) lines.push(`… 另有 ${diagnostics.length - limit} 条`);
  return lines;
}

const TARGET_KEY = (target: DiagnosticTarget) =>
  target.kind === 'cell'
    ? `c:${target.position?.join(',')}`
    : `r:${target.region?.min.join(',')}:${target.region?.max.join(',')}`;

/** Deduplicate identical findings (same rule, object, place and reason) and sort deterministically. */
export function mergeDiagnostics(diagnostics: Iterable<Diagnostic>): Diagnostic[] {
  const seen = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.rule}|${diagnostic.severity}|${diagnostic.object.kind}|${diagnostic.object.id}|${TARGET_KEY(diagnostic.target)}|${diagnostic.message}`;
    if (!seen.has(key)) seen.set(key, diagnostic);
  }
  return [...seen.values()].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.rule.localeCompare(b.rule) ||
      a.object.kind.localeCompare(b.object.kind) ||
      a.object.id.localeCompare(b.object.id) ||
      TARGET_KEY(a.target).localeCompare(TARGET_KEY(b.target)) ||
      a.message.localeCompare(b.message),
  );
}

export function countSeverities(diagnostics: readonly Diagnostic[]) {
  const counts: Record<Severity, number> = { error: 0, warning: 0, unknown: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity]++;
  return counts;
}

/** Mutable collector used while a generation pass is still running. */
export class DiagnosticSink {
  private readonly items: Diagnostic[] = [];
  private readonly limit: number;

  constructor(limit = 2000) {
    this.limit = limit;
  }

  add(diagnostic: Diagnostic): void {
    if (this.items.length >= this.limit) return;
    this.items.push(diagnostic);
  }

  addAll(diagnostics: Iterable<Diagnostic>): void {
    for (const diagnostic of diagnostics) this.add(diagnostic);
  }

  error(rule: string, message: string, options: Omit<CoordinateDiagnosticInput, 'rule' | 'message' | 'severity'> = {}) {
    this.add(coordinateDiagnostic({ ...options, rule, message, severity: 'error' }));
  }

  warn(rule: string, message: string, options: Omit<CoordinateDiagnosticInput, 'rule' | 'message' | 'severity'> = {}) {
    this.add(coordinateDiagnostic({ ...options, rule, message, severity: 'warning' }));
  }

  unknown(
    rule: string,
    message: string,
    options: Omit<CoordinateDiagnosticInput, 'rule' | 'message' | 'severity'> = {},
  ) {
    this.add(coordinateDiagnostic({ ...options, rule, message, severity: 'unknown', conclusive: false }));
  }

  info(rule: string, message: string, options: Omit<CoordinateDiagnosticInput, 'rule' | 'message' | 'severity'> = {}) {
    this.add(coordinateDiagnostic({ ...options, rule, message, severity: 'info' }));
  }

  get size(): number {
    return this.items.length;
  }

  list(): Diagnostic[] {
    return [...this.items];
  }

  merged(): Diagnostic[] {
    return mergeDiagnostics(this.items);
  }
}

/* ---------------------------------------------------------------------------
 * 兼容适配：把已有的三种旧诊断形状归一，保持建筑现有 check() 不需要立刻改。
 * ------------------------------------------------------------------------- */

/** `standardIssues()`/`lanternSupportErrors()` 返回的中文消息 → 诊断。 */
export function fromMessage(
  message: string,
  rule = 'model.standard',
  object: DiagnosticObject | string = 'model',
  region?: Box,
): Diagnostic {
  const at = /(\d+),(\d+),(\d+)/.exec(message);
  const position = at ? ([Number(at[1]), Number(at[2]), Number(at[3])] as Vec3) : undefined;
  return coordinateDiagnostic({
    rule,
    message,
    object,
    severity: 'error',
    ...(position ? { position } : region ? { region } : {}),
    source: 'standard-issues',
  });
}

export function fromMessages(
  messages: readonly string[],
  rule = 'model.standard',
  object: DiagnosticObject | string = 'model',
  region?: Box,
): Diagnostic[] {
  return messages.map((message) => fromMessage(message, rule, object, region));
}

/** 树/植物/屋面的局部诊断结果 → 诊断。 */
export function fromFloatingCells(
  cells: readonly Vec3[],
  rule: string,
  object: DiagnosticObject | string,
  message: (cell: Vec3, index: number) => string,
): Diagnostic[] {
  return cells.map((cell, index) =>
    coordinateDiagnostic({
      rule,
      message: message(cell, index),
      object,
      severity: 'error',
      position: [...cell] as Vec3,
    }),
  );
}

/** 建筑 `check()` 的返回值：旧签名返回 void，或返回诊断/消息。 */
export type BuildingCheckResult =
  | void
  | undefined
  | Diagnostic
  | Diagnostic[]
  | Readonly<{ diagnostics: readonly Diagnostic[] }>
  | Readonly<{ issues: readonly string[] }>
  | string
  | string[];

/**
 * 归一建筑 check 的返回值。抛错仍是合法且推荐的失败方式（旧建筑照旧），
 * 由 `runModelCheck` 捕获后转成 error 诊断。
 */
export function normalizeCheckResult(result: BuildingCheckResult, source = 'building-check'): Diagnostic[] {
  if (result === undefined || result === null) return [];
  if (typeof result === 'string') return [fromMessage(result, 'building.check', 'building')];
  if (Array.isArray(result))
    return result.flatMap((item) =>
      typeof item === 'string' ? [fromMessage(item, 'building.check', 'building')] : [item as Diagnostic],
    );
  if ('diagnostics' in result) return [...result.diagnostics];
  if ('issues' in result) return fromMessages(result.issues, 'building.check', 'building');
  return [{ ...(result as Diagnostic), source: (result as Diagnostic).source ?? source }];
}

/** 结构化失败：既 throw（兼容旧调用点），又能带出机器可读诊断。 */
export class DiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(formatDiagnostics(diagnostics, 20).join('\n') || 'check failed');
    this.name = 'DiagnosticError';
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export function isDiagnosticError(error: unknown): error is DiagnosticError {
  return error instanceof DiagnosticError;
}

/** 模型生成/检查阶段向建筑暴露的上下文。 */
export type ModelCheckContext = Readonly<{
  world: import('../core/structure.js').Structure;
  /** Layered model when the building returned Components instead of a bare Structure. */
  model: Components | null;
  args: Readonly<Record<string, number | string | boolean>>;
  inspect: ReturnType<import('../core/structure.js').Structure['inspect']>;
  /**
   * Legacy preview-mesh diagnostics, carried for existing buildings that read
   * `code === 'placeholder'`. Under `bewright check` there is no mesh pass, so the
   * framework maps the unified model diagnostics into this shape instead of
   * silently reporting an empty list.
   */
  diagnostics: readonly GeometryDiagnostic[];
  /**
   * Declared model extent. Optional only for backward compatibility with
   * hand-written contexts; the CLIs always supply it.
   */
  bounds?: Box;
  /** 实际地形表面查询（地形/水面/可站立面，按模型 revision 失效）。 */
  surfaces?: import('./surface.js').SurfaceQuery;
  /** 已声明的保护区与净空契约。 */
  protection?: import('./protection.js').ProtectionRegistry;
  /** Collect additional diagnostics without throwing. */
  collect?(diagnostic: Diagnostic): void;
  /** Alias of `collect`. */
  report?(diagnostic: Diagnostic): void;
}>;

export type ModelCheckReport = Readonly<{
  /** `none` means the building declares no check at all — not a pass. */
  status: 'passed' | 'failed' | 'none' | 'not-run';
  executed: boolean;
  severity: Severity | null;
  rule: string | null;
  message: string | null;
  counts: Readonly<Record<Severity, number>>;
  diagnostics: readonly Diagnostic[];
  ms: number;
}>;
