import { AIR, Structure, assertBox, type Box, type State, type Vec3 } from '../core/structure.js';
import { minecraftBlock } from '../blocks/registry.js';
import type { ConstructionSink } from './construction.js';
import { assertPoint, voxelPath } from './layout.js';

/**
 * 建筑创作薄封装：把“放方块”的常用动作收敛成一个类，让建筑代码只表达意图。
 * 坐标一律**闭区间**（x0..x1 两端都包含），状态键名与基岩注册表一致，
 * 非法组合由 `minecraftBlock` 直接报错。材料默认值由构造参数注入，
 * 框架不绑定任何建筑的调色板；建筑可以继承本类补充自己的组合件。
 */
export type Dir = 0 | 1 | 2 | 3; // 0=+X 1=-X 2=+Z 3=-Z，与 authoring/staircase.ts 的方向一致。
export type AuthoringMaterial = string | State;
/** A fixed material or a rule receiving the component's own geometric context. */
export type MaterialSource<A extends unknown[] = []> = AuthoringMaterial | ((...args: A) => AuthoringMaterial);

export function materialFunction<A extends unknown[]>(source: MaterialSource<A>): (...args: A) => State {
  return typeof source === 'function' ? (...args) => resolveMaterial(source(...args)) : () => resolveMaterial(source);
}

/** Explicit states override the supplied material's states, then pass registry validation. */
export function resolveMaterial(material: AuthoringMaterial, states: State['states'] = {}): State {
  return typeof material === 'string'
    ? minecraftBlock(material, states)
    : minecraftBlock(material.name, { ...material.states, ...states });
}

export type KitDefaults = Readonly<
  Partial<{
    slab: AuthoringMaterial;
    stairs: AuthoringMaterial;
    log: AuthoringMaterial;
    leaf: AuthoringMaterial;
    lantern: AuthoringMaterial;
  }>
>;

function drawingBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box | null {
  assertPoint([x0, y0, z0]);
  assertPoint([x1, y1, z1]);
  return x1 < x0 || y1 < y0 || z1 < z0 ? null : { min: [x0, y0, z0], max: [x1 + 1, y1 + 1, z1 + 1] };
}

/** The same drawing actions work on a structure and on an atomic construction recorder. */
export type KitTarget = Pick<ConstructionSink, 'put' | 'air' | 'get'>;

export class BlockKit {
  readonly #target: KitTarget;
  protected readonly defaults: KitDefaults;

  constructor(target: KitTarget, defaults: KitDefaults = {}) {
    this.defaults = defaults;
    this.#target = target;
  }

  put(
    x: number,
    y: number,
    z: number,
    name: AuthoringMaterial,
    states: Record<string, string | number | boolean> = {},
  ) {
    this.#target.put(x, y, z, name, states);
  }

  air(x: number, y: number, z: number) {
    this.#target.air(x, y, z);
  }

  /** Box uses the same half-open convention as Structure; numeric endpoints are inclusive. */
  fill(box: Box, name: AuthoringMaterial): void;
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, name: AuthoringMaterial): void;
  fill(
    boxOrX: Box | number,
    nameOrY: AuthoringMaterial | number,
    z0?: number,
    x1?: number,
    y1?: number,
    z1?: number,
    name?: AuthoringMaterial,
  ) {
    const box = typeof boxOrX === 'number' ? drawingBox(boxOrX, nameOrY as number, z0!, x1!, y1!, z1!) : boxOrX;
    if (!box) return;
    assertBox(box);
    this.fillBox(box, typeof boxOrX === 'number' ? name! : (nameOrY as AuthoringMaterial));
  }

  protected fillBox(box: Box, name: AuthoringMaterial) {
    const material = resolveMaterial(name);
    for (let x = box.min[0]; x < box.max[0]; x++)
      for (let y = box.min[1]; y < box.max[1]; y++)
        for (let z = box.min[2]; z < box.max[2]; z++) this.put(x, y, z, material);
  }

  /** 只填充矩形环（墙、额枋、栏杆基座）。 */
  ring(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, name: AuthoringMaterial) {
    assertPoint([x0, y0, z0]);
    assertPoint([x1, y1, z1]);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        this.put(x, y, z0, name);
        this.put(x, y, z1, name);
      }
      for (let z = z0 + 1; z < z1; z++) {
        this.put(x0, y, z, name);
        this.put(x1, y, z, name);
      }
    }
  }

  carve(box: Box): void;
  carve(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void;
  carve(boxOrX: Box | number, y0?: number, z0?: number, x1?: number, y1?: number, z1?: number) {
    const box = typeof boxOrX === 'number' ? drawingBox(boxOrX, y0!, z0!, x1!, y1!, z1!) : boxOrX;
    if (!box) return;
    assertBox(box);
    for (let x = box.min[0]; x < box.max[0]; x++)
      for (let y = box.min[1]; y < box.max[1]; y++) for (let z = box.min[2]; z < box.max[2]; z++) this.air(x, y, z);
  }

  /** Draw a face-connected line through a few control points. */
  line(path: readonly Vec3[], material: MaterialSource<[Vec3, number]>) {
    const points = voxelPath(path),
      at = materialFunction(material);
    for (const [index, point] of points.entries()) this.put(...point, at(point, index));
    return points;
  }

  slab(x: number, y: number, z: number, name = this.defaults.slab, top = false) {
    if (!name) throw new Error('kit.slab requires a material or a kit default');
    this.put(x, y, z, name, { 'minecraft:vertical_half': top ? 'top' : 'bottom' });
  }

  stair(x: number, y: number, z: number, dir: Dir, name = this.defaults.stairs) {
    if (!name) throw new Error('kit.stair requires a material or a kit default');
    this.put(x, y, z, name, { weirdo_direction: dir, upside_down_bit: false });
  }

  log(x: number, y: number, z: number, name = this.defaults.log, axis: 'x' | 'y' | 'z' = 'y') {
    if (!name) throw new Error('kit.log requires a material or a kit default');
    this.put(x, y, z, name, { pillar_axis: axis });
  }

  leaf(x: number, y: number, z: number, name = this.defaults.leaf) {
    if (!name) throw new Error('kit.leaf requires a material or a kit default');
    this.put(x, y, z, name, { persistent_bit: true, update_bit: false });
  }

  lantern(x: number, y: number, z: number, hanging = true) {
    this.put(x, y, z, this.defaults.lantern ?? 'lantern', { hanging });
  }

  get(x: number, y: number, z: number) {
    return this.#target.get(x, y, z);
  }

  empty(x: number, y: number, z: number) {
    const state = this.get(x, y, z);
    return !state || state.name === 'minecraft:air';
  }
}

/** Direct drawing into an independent structure, useful for custom prefabs. */
export class StructureKit extends BlockKit {
  readonly s: Structure;

  constructor(defaults: KitDefaults = {}, structure = new Structure()) {
    super(
      {
        put: (x, y, z, material, states) => structure.set(x, y, z, resolveMaterial(material, states)),
        air: (x, y, z) => structure.set(x, y, z, AIR),
        get: (x, y, z) => structure.get(x, y, z),
      },
      defaults,
    );
    this.s = structure;
  }

  protected override fillBox(box: Box, name: AuthoringMaterial) {
    this.s.fill(box, resolveMaterial(name));
  }

  /**
   * 方形栏杆墙的接线状态：朝相接方块补 wall_connection，其余留 none，
   * wall_post_bit 恒为 true。连接方名单独可配；派生后与本框架
   * `applyBedrockWallConnections` 的全局推导同样幂等。
   */
  finishWalls(
    wallName = 'cobblestone_wall',
    connectorBlocks = ['minecraft:cobblestone_wall', 'minecraft:stone_bricks', 'minecraft:stone_brick_slab'],
  ) {
    const connectors = new Set(connectorBlocks);
    this.s.forEach((x, y, z, id) => {
      if (this.s.palette[id]!.name !== `minecraft:${wallName.replace(/^minecraft:/, '')}`) return;
      const states: Record<string, string | boolean> = { wall_post_bit: true };
      for (const [direction, dx, dz] of [
        ['east', 1, 0],
        ['west', -1, 0],
        ['south', 0, 1],
        ['north', 0, -1],
      ] as const) {
        const name = this.s.get(x + dx, y, z + dz)?.name;
        states[`wall_connection_type_${direction}`] = name && connectors.has(name) ? 'short' : 'none';
      }
      this.put(x, y, z, wallName, states);
    });
  }
}
