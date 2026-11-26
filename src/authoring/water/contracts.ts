import type { Box, Vec3 } from '../../core/structure.js';
import type { Diagnostic, DiagnosticObject } from '../diagnostic-core.js';

/**
 * 水系：用**源头 / 河段 / 跌水 / 潭 / 出口**表达连接关系，而不是一堆水方块。
 *
 * 三个契约分开表达，禁止互相顶替：
 * - **几何**：每个水段由若干 `WaterColumn` 组成，列出水面、水底、水体层数与床体标高；
 * - **边界**：水体的底面与侧面必须是确认能封闭的方块，或已连接的合法水口（`inflows` /
 *   别的已计划水段占据的格子）；空气缺口明确失败，不认识的材料/形状报 unknown；
 * - **端口**：连接引用对象自己的接口（`inlet` / `outlet`，含位置、朝向、宽度），
 *   不取体素数组首尾；`connectsTo` 里不存在的段号是错误，不是"跳过检查"。
 *
 * 生成顺序是硬约束：**先河床、潭盆与岩壁，再放水**。水只是最后铺的一层。
 * 检查按水段类型分别判定：河床要封闭且顺流不逆坡；跌水（瀑布）本来就悬空，
 * 不要求水下有实体；只有声明了 `wall` 的贴壁水帘才要求与岩壁保持距离；潭要求盆体闭合。
 *
 * 第一版不做完整流体模拟，静态检查不能等同游戏内流动行为，也**不用距源点的距离
 * 冒充水深或流动级别**：所有水格都是源方块。
 */

export const WATER_RULES = {
  discontinuity: 'water.discontinuity',
  uphill: 'water.unexpected-uphill',
  basinLeak: 'water.basin-leak',
  basinFloor: 'water.basin-floor',
  dropLanding: 'water.drop-landing',
  wallDistance: 'water.wall-distance',
  drySource: 'water.dry-source',
  outlet: 'water.outlet',
  /** A `connectsTo` id that names no segment in the system. */
  portMissing: 'water.port-missing',
  /** Two directly connected segments do not hold the same water level. */
  levelMismatch: 'water.level-mismatch',
  /** Boundary material whose collision shape is not confirmed to seal water. */
  boundaryUnknown: 'water.boundary-unknown',
  /** A basin's Y range disagrees with the water column the segment declares. */
  basinOutline: 'water.basin-outline',
  /** `depth` and an explicit `bedAt` describe different water thicknesses. */
  depthConflict: 'water.depth-conflict',
} as const;

export type WaterSegmentKind = 'reach' | 'drop' | 'wall-sheet' | 'pool';

/**
 * A declared connection port: where water enters or leaves a segment.
 *
 * `at` is a **water block** position, `facing` follows the repo convention
 * (0=+X 1=-X 2=+Z 3=-Z) and names the direction the water travels through the
 * port, and `width` is the cross-section width in blocks (defaults to the
 * segment's own `2 * halfWidth + 1`).
 */
export type WaterPort = Readonly<{
  at: Vec3;
  facing: number;
  width?: number;
}>;

export type WaterSegmentSpec = Readonly<{
  id: string;
  kind: WaterSegmentKind;
  /** Centre path of the segment, ordered upstream -> downstream. */
  path: readonly Vec3[];
  /** Half-width of the water surface (>= 0); width 0 is a one-block channel. */
  halfWidth?: number;
  /** Water surface Y per step; defaults to the path Y. */
  surfaceAt?: (x: number, z: number, step: number) => number;
  /** Bed material Y per step; defaults to `water surface - depth`. */
  bedAt?: (x: number, z: number, step: number) => number;
  /**
   * Water thickness in blocks (>= 1, default 1).
   *
   * The water column is `[top - depth + 1 .. top]` and the bed always sits
   * directly under it, so a pool has a volume contract instead of one flat
   * layer. An explicit `bedAt` overrides the thickness and is reported when the
   * two disagree.
   */
  depth?: number;
  /**
   * Highest Y to clear above the surface before placing water (default 1 for a
   * channel, 0 for anything that hangs).
   *
   * A channel cut into a hillside needs its banks opened above the water line,
   * otherwise water is placed *inside* the rock and the segment never appears.
   * `carve` is how a caller says how deep the trench has to be; it is bounded
   * by the segment's own path, so it cannot silently excavate a whole mountain.
   */
  carve?: number;
  /** Wall distance a `wall-sheet` must keep from its backing rock. */
  wallDistance?: number;
  /**
   * Side cells where water is *supposed* to cross the body boundary — the mouth
   * where a cascade pours into a pool, for example. Without this, a legitimate
   * inflow is reported as a leak.
   */
  inflows?: readonly Vec3[];
  /** Explicit upstream/downstream neighbours for continuity checks. */
  connectsTo?: readonly string[];
  /** Where water enters this segment (defaults to the first path step). */
  inlet?: WaterPort;
  /** Where water leaves this segment (defaults to the last path step). */
  outlet?: WaterPort;
  /** Explicit outward outlet on the boundary of this scene. Only its wet section is open. */
  externalOutlet?: Readonly<{ bounds: Box; facing: 0 | 1 | 2 | 3 }>;
  /**
   * Pool outline (half-open box) — the bounding box of the body.
   *
   * Only X/Z are used: the water level comes from the path (or `surfaceAt`) and
   * the thickness from `depth`. A basin whose Y range does not contain the
   * declared water column is reported as a warning rather than silently
   * reinterpreting the water level. Add `outline` for a body that is not a
   * rectangle; the box stays the bounding box for bounds and reports.
   */
  basin?: Box;
  /**
   * Non-rectangular body mask, evaluated inside `basin`'s X/Z bounding box.
   *
   * The outline is the pool's actual shape: cells it rejects are not part of
   * the body, so their floor and side walls are not part of the容水 contract
   * either. Omit it for a rectangular pool.
   */
  outline?: (x: number, z: number) => boolean;
}>;

export type WaterSystemSpec = Readonly<{
  id: string;
  /** Where the water comes from; checked as non-dry. */
  source: Vec3;
  segments: readonly WaterSegmentSpec[];
  /** Where the water leaves the model. */
  outlet?: Vec3;
  object?: DiagnosticObject | string;
}>;

/** One vertical water column of a segment: surface, volume, and the bed under it. */
export type WaterColumn = Readonly<{
  x: number;
  z: number;
  /** Top water block Y (the surface). */
  top: number;
  /** Bottom water block Y. Equals `top` for a one-layer body. */
  bottom: number;
  /** Bed block Y; always `bottom - 1`. */
  bed: number;
  /** Water blocks in this column. */
  depth: number;
  /** Where the column came from: the declared path or the pool basin. */
  source: 'path' | 'basin';
  /** Path step this column belongs to (path columns only). */
  step?: number;
}>;

export type WaterSegmentPlan = Readonly<{
  spec: WaterSegmentSpec;
  /** Centreline design levels, upstream -> downstream. */
  steps: readonly Vec3[];
  /** Every water column of the body, path columns first, basin columns last. */
  columns: readonly WaterColumn[];
  /** Water surface cells along the declared path (the channel the spec describes). */
  surfaceCells: readonly Vec3[];
  /**
   * Extra cells a `pool` holds water in: its declared basin.
   *
   * A basin is the pool's actual water body — a 20x20 basin with a one-cell path
   * would otherwise be a dry hole with a single water block in the middle, and
   * the source/outlet checks would call the system dry.
   */
  basinCells: readonly Vec3[];
  /** Channel/bed cells that must be solid before water is placed. */
  bedCells: readonly Vec3[];
  /** Water cells the segment clears before placing water. */
  carveCells: readonly Vec3[];
  /** Inlet / outlet cross-section cells (declared ports, or the path ends). */
  inletCells: readonly Vec3[];
  outletCells: readonly Vec3[];
  /** Water surface block Y of the segment's outlet / inlet. */
  outletY: number;
  inletY: number;
  lowest: number;
  highest: number;
}>;

export type WaterPlan = Readonly<{
  id: string;
  source: Vec3;
  outlet: Vec3 | null;
  segments: readonly WaterSegmentPlan[];
  diagnostics: readonly Diagnostic[];
  feasible: boolean;
}>;
