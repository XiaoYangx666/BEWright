import { contains, type Box, type State, type Structure, type Vec3 } from '../core/structure.js';
import { diagnosticObject, type Diagnostic, type DiagnosticObject } from './diagnostics.js';
import { formatRulePattern, matchProtectionRules, type ProtectionRule, type ProtectionRuleSet } from './rules.js';

/**
 * 保护区与净空契约。
 *
 * 这里**不维护第二份体素世界**：契约只是"某段空间属于谁、里面必须满足什么"
 * 的声明，真正的方块仍然只有 `Structure` 一份权威数据。碰撞盒、占用与冲突
 * 检查都在提交前读取当前模型算出来，因此契约和实际几何不会各自漂移。
 */

export type ProtectionClearance = Readonly<{
  /**
   * 有限高度净空：从净空区底部起算、必须保持可通行的高度。
   * 缺省时按净空区的整段高度计算（`maxY - minY + 1`）。
   */
  minHeight?: number;
  /**
   * 明确指定必须保持空的空气区（半开区间）。缺省用保护区自身的 `region`，
   * 于是"整个这块地都要空"仍然是一句话，而"只有台面上方的空间要空"可以
   * 用净空区单独表达——契约里因此不需要两套彼此矛盾的坐标语义。
   */
  region?: Box;
  /** 允许被占用的最高 Y（含）；缺省由 `minHeight` 推出。 */
  maxY?: number;
}>;

export type ProtectionZone = Readonly<{
  id: string;
  kind: string;
  owner: string;
  /** 归属范围：对象"在这里"，用于覆盖判定与侵占检查。 */
  region: Box;
  /** 净空契约；缺省表示没有额外净空要求（`openSky` 仍可单独声明）。 */
  clearance?: ProtectionClearance;
  /** 要求上方到 `skyCeiling` 之间没有任何方块（含树叶、屋檐、招牌）。 */
  openSky?: boolean;
  /** `openSky` 的天顶（含）；缺省用注册表的 `bounds.max[1]`。 */
  skyCeiling?: number;
  /** `openSky` 检查的起点；缺省从 `region` 顶部再上一格起算。 */
  skyFromY?: number;
  /** 该区域允许出现的方块名（`minecraft:` 前缀可省）。缺省表示只允许空气。 */
  allow?: readonly string[];
  /** 额外人读说明，进入诊断消息。 */
  note?: string;
}>;

export type ProtectionZoneInput = Omit<ProtectionZone, 'kind' | 'owner'> &
  Partial<Pick<ProtectionZone, 'kind' | 'owner'>>;

export type ProtectionViolationReason = 'occupied' | 'blocked-sky' | 'not-allowed';
export type ProtectionViolation = Readonly<{
  cell: Vec3;
  reason: ProtectionViolationReason;
  zone: ProtectionZone;
  block: State | null;
}>;

/** 一次写入/挖除提议：要动哪些格、动机是什么。 */
export type BlockOccupation = Readonly<{
  kind: 'terrain' | 'object' | 'route' | 'water' | 'decor';
  /** 提出动议的对象（道路、树、水段……）。 */
  object: DiagnosticObject | string;
  /** 提议写入的方块；`null` 表示挖除（保持 VOID）。 */
  state: State | null;
  /** 提议跨越的格。 */
  cells: readonly Vec3[];
}>;

function short(name: string): string {
  return name.replace(/^minecraft:/, '');
}

function normaliseAllow(list: readonly string[] | undefined): Set<string> | null {
  if (!list || !list.length) return null;
  return new Set(list.map((name) => short(name)));
}

export class ProtectionRegistry {
  private readonly zones = new Map<string, ProtectionZone>();
  private readonly rules: ProtectionRuleSet;
  private bounds: Box;

  constructor(bounds: Box, options: Readonly<{ rules?: ProtectionRuleSet }> = {}) {
    this.bounds = bounds;
    this.rules = options.rules ?? [];
  }

  get boundsBox(): Box {
    return this.bounds;
  }

  /** Replace the declared model extent (rarely needed; keeps region inference correct). */
  setBounds(bounds: Box): void {
    this.bounds = bounds;
  }

  /** 声明保护区；重复 id 直接报错，避免"哪个契约生效"的歧义。 */
  add(input: ProtectionZoneInput): ProtectionZone {
    if (!input.id) throw new Error('Protection zone needs an id');
    if (this.zones.has(input.id)) throw new Error(`Duplicate protection zone: ${input.id}`);
    if (input.region.min.some((v, axis) => v >= input.region.max[axis]))
      throw new Error(`Protection zone ${input.id} has an empty region`);
    if (input.clearance) {
      const clearance = input.clearance;
      if (clearance.minHeight !== undefined && (!Number.isSafeInteger(clearance.minHeight) || clearance.minHeight < 1))
        throw new Error(`Protection zone ${input.id} needs a positive integer clearance height`);
      if (clearance.maxY !== undefined && !Number.isSafeInteger(clearance.maxY))
        throw new Error(`Protection zone ${input.id} has an invalid clearance ceiling`);
      const air = clearance.region ?? input.region;
      if (air.min.some((value, axis) => value >= air.max[axis]))
        throw new Error(`Protection zone ${input.id} has an empty clearance region`);
      if (clearance.maxY !== undefined && clearance.maxY < air.min[1])
        throw new Error(`Protection zone ${input.id} has a clearance ceiling below its floor`);
    }
    const zone: ProtectionZone = Object.freeze({
      ...input,
      kind: input.kind ?? 'zone',
      owner: input.owner ?? input.id,
      ...(input.allow ? { allow: [...input.allow] } : {}),
    });
    this.zones.set(zone.id, zone);
    return zone;
  }

  /** 注册一个"整块地都不得有方块"的净空区。 */
  addVoid(input: ProtectionZoneInput): ProtectionZone {
    return this.add({ ...input, clearance: { ...(input.clearance ?? {}), region: input.region } });
  }

  /** 开放天空：从 `fromY` 到天顶之间连树叶、屋檐都算遮挡。 */
  addOpenSky(input: ProtectionZoneInput): ProtectionZone {
    return this.add({ ...input, openSky: true });
  }

  get(id: string): ProtectionZone | undefined {
    return this.zones.get(id);
  }

  list(): ProtectionZone[] {
    return [...this.zones.values()];
  }

  /** 落在该格上的全部保护区（半开区间）。 */
  covering(x: number, y: number, z: number): ProtectionZone[] {
    return this.list().filter((zone) => contains(zone.region, x, y, z));
  }

  /** 保护区声明的必须保持空的空气区；没有净空契约时返回 `null`。 */
  static clearanceRegion(zone: ProtectionZone): Box | null {
    if (!zone.clearance) return null;
    return zone.clearance.region ?? zone.region;
  }

  /** 净空允许被占用的最高 Y（含）。 */
  static clearanceTop(zone: ProtectionZone): number {
    const air = ProtectionRegistry.clearanceRegion(zone)!;
    const declared =
      zone.clearance?.maxY ?? (zone.clearance?.minHeight !== undefined ? air.min[1] + zone.clearance.minHeight - 1 : air.max[1] - 1);
    return Math.min(declared, air.max[1] - 1);
  }

  /** 该格是否落在净空里（即必须保持空的格子）。 */
  static inClearance(zone: ProtectionZone, x: number, y: number, z: number): boolean {
    const air = ProtectionRegistry.clearanceRegion(zone);
    if (!air || !contains(air, x, y, z)) return false;
    return y > ProtectionRegistry.clearanceTop(zone);
  }

  /** `openSky` 的检查起点（含）。 */
  static skyFrom(zone: ProtectionZone): number {
    if (zone.skyFromY !== undefined) return zone.skyFromY;
    const air = ProtectionRegistry.clearanceRegion(zone);
    if (air) return ProtectionRegistry.clearanceTop(zone) + 1;
    return zone.region.min[1];
  }

  private allowed(zone: ProtectionZone, block: State | null): boolean {
    const allow = normaliseAllow(zone.allow);
    if (!allow) return false;
    return !!block && allow.has(short(block.name));
  }

  /**
   * 检查一次提议：返回全部违规，空数组表示可以整体提交。
   *
   * 与 `audit()` 使用同一套判据，所以"事前拒绝"和"事后复查"不会互相矛盾。
   * `state: null` 是"挖除"而不是"放方块"——挖空净空区本身不侵占空间。
   */
  check(world: Structure, occupation: BlockOccupation): ProtectionViolation[] {
    const violations: ProtectionViolation[] = [];
    const placing = occupation.state !== null && occupation.state.name !== 'minecraft:air';
    if (!placing) return violations;
    for (const cell of occupation.cells) {
      const [x, y, z] = cell;
      const block = world.get(x, y, z) ?? null;
      for (const zone of this.covering(x, y, z)) {
        const reason = this.verdict(zone, occupation.state, x, y, z);
        if (reason) violations.push({ cell: [...cell] as Vec3, reason, zone, block });
      }
    }
    return violations;
  }

  /**
   * The single protection verdict for one block in one zone.
   *
   * A zone's `allow` list applies to its whole region (an absent list means
   * "only air is allowed"). Above the declared headroom nothing is allowed
   * unless the allow-list names it. `blocked-sky` wins over the rest, because a
   * block that shades an open-sky zone is the more specific finding.
   */
  private verdict(zone: ProtectionZone, block: State | null, x: number, y: number, z: number): ProtectionViolationReason | null {
    if (!block || block.name === 'minecraft:air') return null;
    const skyCeiling = zone.skyCeiling ?? Number.POSITIVE_INFINITY;
    if (zone.openSky && y >= ProtectionRegistry.skyFrom(zone) && y <= skyCeiling) return 'blocked-sky';
    if (ProtectionRegistry.inClearance(zone, x, y, z)) return 'occupied';
    if (ProtectionRegistry.clearanceRegion(zone) || zone.allow) {
      if (!this.allowed(zone, block)) return 'not-allowed';
    }
    return null;
  }

  /**
   * 对**已提交**的模型重新检查全部契约。检查基于最终几何，不依赖生成时的乐观判断，
   * 所以合法桥梁、悬挑、树枝、瀑布只要落在契约允许的范围内就不会被误报。
   */
  audit(world: Structure, options: Readonly<{ skyLimit?: (zone: ProtectionZone) => number }> = {}): ProtectionViolation[] {
    const violations: ProtectionViolation[] = [];
    const occupied = (block: State | null) => !!block && block.name !== 'minecraft:air';
    for (const zone of this.list()) {
      const declaredCeiling = options.skyLimit?.(zone) ?? zone.skyCeiling;
      const effective: ProtectionZone =
        declaredCeiling === undefined ? zone : { ...zone, skyCeiling: declaredCeiling };
      // In-region blocks: headroom, allow-list and shading are all decided by the
      // same `verdict()` the proposal path uses, so the two can never disagree.
      for (let x = zone.region.min[0]; x < zone.region.max[0]; x++)
        for (let y = zone.region.min[1]; y < zone.region.max[1]; y++)
          for (let z = zone.region.min[2]; z < zone.region.max[2]; z++) {
            const block = world.get(x, y, z) ?? null;
            if (!occupied(block)) continue;
            const reason = this.verdict(effective, block, x, y, z);
            if (reason) violations.push({ cell: [x, y, z], reason, zone, block });
          }
      // Open sky reaches above the declared region: an eave, roof or sign over
      // the pad is a violation even though it is outside the zone's own Y range.
      if (zone.openSky) {
        const from = Math.max(ProtectionRegistry.skyFrom(zone), zone.region.min[1]);
        for (let x = zone.region.min[0]; x < zone.region.max[0]; x++)
          for (let z = zone.region.min[2]; z < zone.region.max[2]; z++) {
            const aboveRegion = Math.max(from, zone.region.max[1]);
            for (let y = aboveRegion; y <= (effective.skyCeiling ?? this.bounds.max[1]); y++) {
              const block = world.get(x, y, z) ?? null;
              if (!occupied(block)) continue;
              violations.push({ cell: [x, y, z], reason: 'blocked-sky', zone, block });
              break;
            }
          }
      }
    }
    return violations;
  }

  /**
   * 应用框架的保护区规则集（例如"天然石头受保护、石径不受保护"）。
   * 返回违规；空数组表示这次写入不碰任何受保护对象。
   */
  checkRules(world: Structure, occupation: BlockOccupation): ProtectionViolation[] {
    const rule = matchProtectionRules(this.rules, occupation.object);
    if (!rule) return [];
    const violations: ProtectionViolation[] = [];
    for (const cell of occupation.cells) {
      const block = world.get(cell[0], cell[1], cell[2]) ?? null;
      if (!rule.blocks(block, cell)) continue;
      violations.push({ cell: [...cell] as Vec3, reason: 'not-allowed', zone: ruleZone(rule), block });
    }
    return violations;
  }

  rulePatterns(): string[] {
    return this.rules.map(formatRulePattern);
  }
}

/**
 * 保护区规则不是地理区域，诊断里仍需要一个稳定的"对象"载体，
 * 这里给规则生成一个不参与 `covering()` 的伪 zone，避免在诊断里丢字段。
 */
const ruleZones = new WeakMap<ProtectionRule, ProtectionZone>();
function ruleZone(rule: ProtectionRule): ProtectionZone {
  const cached = ruleZones.get(rule);
  if (cached) return cached;
  const zone: ProtectionZone = Object.freeze({
    id: `rule:${formatRulePattern(rule)}`,
    kind: 'rule',
    owner: rule.owner ?? 'framework',
    region: { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 },
    note: rule.note ?? rule.reason,
  });
  ruleZones.set(rule, zone);
  return zone;
}

/** 违规 → 诊断。保护区侵占是错误；`allow` 不匹配同样是错误。 */
export function protectionDiagnostics(
  violations: readonly ProtectionViolation[],
  options: Readonly<{ object?: DiagnosticObject | string; rule?: string; limit?: number }> = {},
): Diagnostic[] {
  const rule = options.rule ?? 'protection.occupied';
  return violations.slice(0, options.limit ?? 200).map((violation) => ({
    rule: violation.reason === 'blocked-sky' ? 'protection.open-sky' : rule,
    severity: 'error',
    object: diagnosticObject(options.object ?? { kind: violation.zone.kind, id: violation.zone.id, owner: violation.zone.owner }),
    target: { kind: 'cell', position: [...violation.cell] as Vec3 },
    message:
      violation.reason === 'blocked-sky'
        ? `净空要求开放天空，但 ${violation.cell.join(',')} 被 ${violation.block?.name ?? '方块'} 遮挡（保护区 ${violation.zone.id}）`
        : violation.reason === 'not-allowed'
          ? `${violation.cell.join(',')} 的 ${violation.block?.name ?? '方块'} 不在保护区 ${violation.zone.id} 的允许清单内`
          : `保护区 ${violation.zone.id} 要求 ${violation.cell.join(',')} 保持净空，实际被 ${violation.block?.name ?? '方块'} 占用`,
    ...(violation.zone.note ? { data: { note: violation.zone.note } } : {}),
    source: 'protection',
  }));
}
