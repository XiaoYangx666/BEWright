import { resolveMaterial, type AuthoringMaterial, type Dir, type BlockKit } from './kit.js';
import { roofSurface } from './roof-surface.js';

/**
 * 屋顶创作引擎：举折表驱动的四面坡/六角攒尖顶、戗脊、四角起翘、宝顶与檐下木构。
 * 材料全部显式传入（`RoofMaterials`），框架不绑定任何建筑的调色板；
 * 相邻格抬升差 ≤ 1 由 profile 保证，屋面不会出现悬空瓦片。
 */
export type Profile = readonly number[];

export type RoofMaterials = Readonly<{
  tile: AuthoringMaterial;
  stairs: AuthoringMaterial;
  slab: AuthoringMaterial;
  ridge: AuthoringMaterial;
  gold: AuthoringMaterial;
  rafter: AuthoringMaterial;
  beam: AuthoringMaterial;
}>;

export type RoofSpec = Readonly<{
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 檐口第一层屋面的标高。 */
  eaveY: number;
  profile: Profile;
  /** 抬升上限：> 0 时形成可站立的檐裙平台，0 表示不设平台（攒尖顶）。 */
  cap: number;
  /** 是否沿对角线铺戗脊。 */
  hips?: boolean;
  /** 四角起翘的角饰方块；`null` 表示只起翘不加饰。 */
  ornament?: AuthoringMaterial | null;
}>;

function heightAt(profile: Profile, cap: number, d: number) {
  const raw = profile[Math.min(Math.max(d, 0), profile.length - 1)]!;
  return cap > 0 ? Math.min(cap, raw) : raw;
}

/** 抬升一侧的方向：高侧朝向屋脊。 */
function ridgeDir(ex: number, ez: number, eastSide: boolean, southSide: boolean): Dir {
  if (ex <= ez) return eastSide ? 0 : 1;
  return southSide ? 2 : 3;
}

/**
 * 四面坡屋顶。每格按“到最近檐边的距离”取举折高度，
 * 实心填充檐下、屋面用瓦块/半砖/瓦阶交错收头，因此不会出现悬空瓦片。
 */
export function hipRoof(kit: BlockKit, spec: RoofSpec, m: RoofMaterials) {
  const { x0, x1, z0, z1, eaveY, profile, cap } = spec;
  if (
    !profile.length ||
    !profile.every((v) => Number.isSafeInteger(v) && v >= 0) ||
    !Number.isSafeInteger(cap) ||
    cap < 0
  )
    throw new Error('Roof requires a nonempty nonnegative integer profile and cap');
  roofSurface(
    kit,
    {
      x0,
      x1,
      z0,
      z1,
      solidFromY: eaveY,
      heightAt: (x, z) => eaveY + heightAt(profile, cap, Math.min(x - x0, x1 - x, z - z0, z1 - z)),
    },
    {
      tile: m.tile,
      surface: ({ position: [x, , z] }) => {
        const ex = Math.min(x - x0, x1 - x),
          ez = Math.min(z - z0, z1 - z),
          d = Math.min(ex, ez);
        const up = heightAt(profile, cap, d),
          next = heightAt(profile, cap, d + 1);
        if (ex === ez || (cap > 0 && up === cap)) return m.tile;
        if (next > up)
          return resolveMaterial(m.stairs, {
            weirdo_direction: ridgeDir(ex, ez, x - x0 <= x1 - x, z - z0 <= z1 - z),
            upside_down_bit: false,
          });
        return resolveMaterial(m.slab, { 'minecraft:vertical_half': 'bottom' });
      },
    },
  );
  if (spec.hips) hipRidges(kit, spec, m);
  if (spec.ornament !== undefined) upturnCorners(kit, spec, m);
}

/** 戗脊：沿对角线把屋面抬高半格，形成四条清晰的角脊。 */
function hipRidges(kit: BlockKit, spec: RoofSpec, m: RoofMaterials) {
  const { x0, x1, z0, z1, eaveY, profile, cap } = spec;
  const cx = (x0 + x1) / 2,
    cz = (z0 + z1) / 2;
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      if (Math.abs(Math.abs(x - cx) - Math.abs(z - cz)) > 0.4) continue;
      const d = Math.min(x - x0, x1 - x, z - z0, z1 - z);
      const up = heightAt(profile, cap, d);
      if (up <= 0) continue;
      if (cap > 0 && up >= cap) continue; // 檐裙平台是平的，不再铺戗脊
      kit.put(x, eaveY + up + 1, z, m.ridge);
    }
}

/** 四角起翘：在角部瓦面上叠起两级并朝檐外收一级，末端压一个角饰。 */
function upturnCorners(kit: BlockKit, spec: RoofSpec, m: RoofMaterials) {
  const { x0, x1, z0, z1, eaveY, ornament } = spec;
  const corners: readonly (readonly [number, number, -1 | 1])[] = [
    [x0, z0, -1],
    [x0, z1, -1],
    [x1, z0, 1],
    [x1, z1, 1],
  ];
  for (const [x, z, dx] of corners) {
    const outward: Dir = dx < 0 ? 1 : 0;
    kit.put(x, eaveY + 1, z, m.tile);
    kit.stair(x, eaveY + 2, z, outward, m.stairs);
    if (ornament) kit.put(x, eaveY + 3, z, ornament);
  }
}

/** 檐下木构：满铺望板，再沿墙线压一圈额枋。 */
export function eaveSoffit(
  kit: BlockKit,
  spec: Pick<RoofSpec, 'x0' | 'x1' | 'z0' | 'z1' | 'eaveY'>,
  wall: { x0: number; x1: number; z0: number; z1: number },
  m: Pick<RoofMaterials, 'rafter' | 'beam'>,
) {
  const { x0, x1, z0, z1, eaveY } = spec;
  kit.fill(x0, eaveY - 1, z0, x1, eaveY - 1, z1, m.rafter);
  kit.ring(wall.x0, eaveY - 1, wall.z0, wall.x1, eaveY - 1, wall.z1, m.beam);
}

/** 六角攒尖顶：按六边形范数取举折；范数下降方向唯一才用瓦阶，脊线交角处改用整块。 */
export function hexRoof(
  kit: BlockKit,
  cx: number,
  cz: number,
  radius: number,
  eaveY: number,
  profile: Profile,
  m: Pick<RoofMaterials, 'tile' | 'stairs' | 'gold'>,
) {
  for (let x = cx - radius; x <= cx + radius; x++)
    for (let z = cz - radius; z <= cz + radius; z++) {
      const dx = x - cx,
        dz = z - cz;
      const n = Math.max(Math.abs(dx), Math.abs(dz), Math.abs(dx + dz));
      if (n > radius) continue;
      const d = radius - n;
      const up = profile[Math.min(d, profile.length - 1)]!;
      const y = eaveY + up;
      for (let f = eaveY; f < y; f++) kit.put(x, f, z, m.tile);
      // 找出“更靠近亭心”的邻居；多于一个说明这里是两条脊的交角。
      const inward: [number, number][] = [];
      for (const [ox, oz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const mm = Math.max(Math.abs(dx + ox), Math.abs(dz + oz), Math.abs(dx + ox + dz + oz));
        if (mm < n) inward.push([ox, oz]);
      }
      if (inward.length !== 1) kit.put(x, y, z, m.tile);
      else {
        const [ox, oz] = inward[0]!;
        const dir: Dir = ox !== 0 ? (ox > 0 ? 1 : 0) : oz > 0 ? 3 : 2;
        kit.stair(x, y, z, dir, m.stairs);
      }
    }
  // 六角起翘
  const corners: readonly (readonly [number, number])[] = [
    [cx + radius, cz],
    [cx - radius, cz],
    [cx, cz + radius],
    [cx, cz - radius],
    [cx + radius, cz - radius],
    [cx - radius, cz + radius],
  ];
  for (const [x, z] of corners) {
    kit.put(x, eaveY + 1, z, m.tile);
    kit.put(x, eaveY + 2, z, m.gold);
  }
}

/** 宝顶：攒尖顶顶部的塔式收头；`y0` 是屋面最高块正上方那一格。 */
export function finial(
  kit: BlockKit,
  cx: number,
  cz: number,
  y0: number,
  m: Pick<RoofMaterials, 'tile' | 'ridge' | 'gold'>,
) {
  kit.put(cx, y0, cz, m.tile);
  kit.put(cx, y0 + 1, cz, m.ridge);
  kit.put(cx, y0 + 2, cz, m.gold);
  // 十字宝珠：四臂借侧向支撑，不会悬空。
  for (const [dx, dz] of [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const)
    kit.put(cx + dx, y0 + 3, cz + dz, m.gold);
  kit.put(cx, y0 + 4, cz, m.gold);
  kit.put(cx, y0 + 5, cz, m.gold);
  return y0 + 5;
}
