import { Structure, CHUNK, contains, type Box, type State, type Vec3 } from '../core/structure.js';
import { colorProfile, materials, PLACEHOLDER_COLOR } from '../blocks/materials.js';
import { visualGeometry, colors, fullCube, kind, validateVisual } from '../blocks/shapes.js';
import { lightEmission } from './light.js';
export type LightSampler = {
  at(x: number, y: number, z: number): number;
  skyAt(x: number, y: number, z: number): number;
};
export type MeshDiagnostic = import('../core/geometry-diagnostic.js').GeometryDiagnostic;
export type MeshData = {
  diagnostics: MeshDiagnostic[];
  positions: Float32Array;
  colors: Float32Array;
  lights: Float32Array;
  skies: Float32Array;
  translucentPositions: Float32Array;
  translucentColors: Float32Array;
  translucentLights: Float32Array;
  translucentSkies: Float32Array;
  translucentAlphas: Float32Array;
  quads: number;
  translucentQuads: number;
  chunks: number;
};

/** Triangle order per face direction, as indices into the (a, b) unit square. */
const TRIANGLE_POSITIVE: readonly number[] = [0, 1, 2, 0, 2, 3];
const TRIANGLE_NEGATIVE: readonly number[] = [0, 2, 1, 0, 3, 2];

/**
 * The meshed chunk's origin plus its 3x3x3 neighbourhood of cell arrays. The
 * mask pass only ever reads the meshed chunk or one cell outside it, so this
 * replaces one string-keyed `Structure.getId` per voxel with integer arithmetic.
 */
function chunkShell(world: Structure, key: string | undefined) {
  if (key === undefined) return null;
  const [cx, cy, cz] = key.split(',').map(Number);
  const cells: (Uint16Array | undefined)[] = new Array(27);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        cells[(dx + 1) * 9 + (dy + 1) * 3 + (dz + 1)] = world.chunks.get(`${cx + dx},${cy + dy},${cz + dz}`)?.cells;
  return { x: cx * CHUNK, y: cy * CHUNK, z: cz * CHUNK, cells };
}
type PaletteMeshProfile = {
  cube: boolean[];
  opacity: number[];
  emission: number[];
  color: number[][];
  geometryKind: string[];
  staticGeometry: (ReturnType<typeof visualGeometry> | null)[];
};
const paletteProfiles = new WeakMap<Structure, { states: (State | null)[]; styles: Map<string, PaletteMeshProfile> }>();

function paletteMeshProfile(world: Structure, overrides: Readonly<Record<string, string>>): PaletteMeshProfile {
  const style = colorProfile(overrides);
  const styleKey = JSON.stringify(Object.entries(style).sort(([a], [b]) => a.localeCompare(b)));
  let cached = paletteProfiles.get(world);
  if (!cached || cached.states.length !== world.palette.length || cached.states.some((state, id) => state !== world.palette[id])) {
    cached = { states: [...world.palette], styles: new Map() };
    paletteProfiles.set(world, cached);
  }
  const prior = cached.styles.get(styleKey);
  if (prior) return prior;
  const geometryKind = world.palette.map((s) => s ? materials[kind(s)].geometry : 'void');
  const profile: PaletteMeshProfile = {
    geometryKind,
    cube: world.palette.map(fullCube),
    opacity: world.palette.map((s) => s ? (materials[kind(s)].opacity ?? 1) : 1),
    emission: world.palette.map((s) => s ? lightEmission(s) : 0),
    color: world.palette.map((s) => {
      if (s) validateVisual(s);
      const hex = s ? (style[kind(s)] ?? colors[kind(s)]) : undefined;
      if (s && !hex) throw new Error(`No POC visual model: ${s.name}`);
      return [0, 2, 4].map((i) => {
        const srgb = parseInt((hex ?? '#ffffff').slice(1 + i, 3 + i), 16) / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      });
    }),
    staticGeometry: world.palette.map((s, id) =>
      s && geometryKind[id] !== 'stairs' && geometryKind[id] !== 'fence'
        ? visualGeometry(s, () => null)
        : null),
  };
  cached.styles.set(styleKey, profile);
  return profile;
}
/** Chunk-local greedy rectangle meshing, with world-neighbor culling across chunk boundaries. */
export function mesh(
  world: Structure,
  region?: Box,
  chunkKey?: string,
  overrides: Readonly<Record<string, string>> = {},
  light?: LightSampler | null,
): MeshData {
  const { cube, opacity: opacityCache, emission: emissionCache, color: colorCache, geometryKind, staticGeometry } =
    paletteMeshProfile(world, overrides);
  const diagnostics = new Map<string, MeshDiagnostic>();
  const markerColor = [0, 2, 4].map((i) => {
    const v = parseInt(PLACEHOLDER_COLOR.slice(i + 1, i + 3), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const positions = new FloatWriter(),
    rgb = new FloatWriter(),
    lightLevels = new FloatWriter(),
    skyLevels = new FloatWriter(),
    translucentPositions = new FloatWriter(),
    translucentRgb = new FloatWriter(),
    translucentLightLevels = new FloatWriter(),
    translucentSkyLevels = new FloatWriter(),
    translucentAlpha = new FloatWriter();
  let quads = 0,
    translucentQuads = 0;
  const get = (p: Vec3) => (region && !contains(region, ...p) ? 0 : world.getId(...p));
  const shell = chunkShell(world, chunkKey);
  /** Region-clamped block id without `get`'s array spread or string-keyed lookup. */
  function idAt(x: number, y: number, z: number): number {
    if (region && !contains(region, x, y, z)) return 0;
    if (!shell) return world.getId(x, y, z);
    const lx = x - shell.x,
      ly = y - shell.y,
      lz = z - shell.z;
    if (lx < -1 || lx > CHUNK || ly < -1 || ly > CHUNK || lz < -1 || lz > CHUNK) return world.getId(x, y, z);
    // 0 selects the neighbouring chunk on the low side, 2 the high side.
    const sx = lx < 0 ? 0 : lx >= CHUNK ? 2 : 1;
    const sy = ly < 0 ? 0 : ly >= CHUNK ? 2 : 1;
    const sz = lz < 0 ? 0 : lz >= CHUNK ? 2 : 1;
    const cells = shell.cells[sx * 9 + sy * 3 + sz];
    if (!cells) return 0;
    return cells[((lx - (sx - 1) * CHUNK) * CHUNK + ly - (sy - 1) * CHUNK) * CHUNK + lz - (sz - 1) * CHUNK];
  }
  const linear = (hex: string) =>
    [0, 2, 4].map((i) => {
      const v = parseInt(hex.slice(i + 1, i + 3), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  /** Scalar face emitter: every coordinate is by value, so neither pass allocates
   *  a vector per voxel or per face. */
  function face(
    ox: number,
    oy: number,
    oz: number,
    dux: number,
    duy: number,
    duz: number,
    dvx: number,
    dvy: number,
    dvz: number,
    sign: number,
    id: number,
    axis: number,
    diagnostic = false,
    boxColor?: string,
    faceLevel?: number,
    faceSky?: number,
  ) {
    const shade = axis === 1 ? (sign > 0 ? 1 : 0.52) : axis === 0 ? 0.77 : 0.9;
    const color = diagnostic ? markerColor : boxColor ? linear(boxColor) : colorCache[id];
    const opacity = diagnostic ? 1 : opacityCache[id],
      transparent = opacity < 1;
    const positionWriter = transparent ? translucentPositions : positions,
      colorWriter = transparent ? translucentRgb : rgb,
      lightWriter = transparent ? translucentLightLevels : lightLevels,
      skyWriter = transparent ? translucentSkyLevels : skyLevels;
    // Faces sample both channels of the voxel they open into; emitters stay
    // full-bright and diagnostic markers ignore lighting so they remain visible.
    let level = faceLevel,
      sky = faceSky;
    if (level === undefined || sky === undefined) {
      if (!light || diagnostic) {
        level = 1;
        sky = 1;
      } else {
        const back = sign > 0 ? 0 : -1;
        const qx = ox + (axis === 0 ? back : 0),
          qy = oy + (axis === 1 ? back : 0),
          qz = oz + (axis === 2 ? back : 0);
        level ??= Math.max(light.at(qx, qy, qz), emissionCache[id]) / 15;
        sky ??= light.skyAt(qx, qy, qz) / 15;
      }
    }
    const order = sign > 0 ? TRIANGLE_POSITIVE : TRIANGLE_NEGATIVE;
    for (let t = 0; t < 6; t++) {
      const j = order[t],
        a = j === 1 || j === 2 ? 1 : 0,
        b = j >= 2 ? 1 : 0;
      positionWriter.triple(ox + dux * a + dvx * b, oy + duy * a + dvy * b, oz + duz * a + dvz * b);
      colorWriter.triple(color[0] * shade, color[1] * shade, color[2] * shade);
      lightWriter.value(level);
      skyWriter.value(sky);
      if (transparent) translucentAlpha.value(opacity);
    }
    quads++;
    if (transparent) translucentQuads++;
  }
  const target = chunkKey === undefined ? undefined : world.chunks.get(chunkKey);
  const chunks: Iterable<readonly [string, { origin: Vec3; cells: Uint16Array }]> =
    chunkKey === undefined ? world.chunks : target ? [[chunkKey, target]] : [];
  for (const [key, { origin }] of chunks) {
    if (region && origin.some((v, i) => v >= region.max[i] || v + CHUNK <= region.min[i])) continue;
    // An all-air chunk has nothing to merge; skip its 6 x 16 layer scans.
    const cells = world.chunks.get(key)!.cells;
    let occupied = false;
    for (let i = 0; i < cells.length; i++)
      if (cells[i]) {
        occupied = true;
        break;
      }
    if (!occupied) continue;
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3,
        v = (d + 2) % 3;
      // Axis unit vectors as scalars keep both passes free of per-voxel arrays.
      const dx = d === 0 ? 1 : 0,
        dy = d === 1 ? 1 : 0,
        dz = d === 2 ? 1 : 0;
      const ux = u === 0 ? 1 : 0,
        uy = u === 1 ? 1 : 0,
        uz = u === 2 ? 1 : 0;
      const vx = v === 0 ? 1 : 0,
        vy = v === 1 ? 1 : 0,
        vz = v === 2 ? 1 : 0;
      for (const sign of [-1, 1]) {
        const nx = dx * sign,
          ny = dy * sign,
          nz = dz * sign;
        for (let layer = 0; layer < CHUNK; layer++) {
          const x0 = origin[0] + dx * layer,
            y0 = origin[1] + dy * layer,
            z0 = origin[2] + dz * layer;
          const mask = new Uint16Array(CHUNK * CHUNK),
            levelMask = new Uint8Array(CHUNK * CHUNK);
          let exposed = 0;
          for (let b = 0; b < CHUNK; b++) {
            const bx = x0 + vx * b,
              by = y0 + vy * b,
              bz = z0 + vz * b;
            for (let a = 0; a < CHUNK; a++) {
              const x = bx + ux * a,
                y = by + uy * a,
                z = bz + uz * a;
              const id = idAt(x, y, z);
              if (!cube[id]) continue;
              const wx = x + nx,
                wy = y + ny,
                wz = z + nz;
              if (cube[idAt(wx, wy, wz)]) continue;
              mask[b * CHUNK + a] = id;
              // Faces merge only across equal block and light; the combined
              // signature packs both channels into one comparison byte.
              const blockLevel = light ? Math.max(light.at(wx, wy, wz), emissionCache[id]) : 15;
              const skyLevel = light ? light.skyAt(wx, wy, wz) : 15;
              levelMask[b * CHUNK + a] = blockLevel * 16 + skyLevel;
              exposed++;
            }
          }
          if (!exposed) continue;
          for (let b = 0; b < CHUNK; b++)
            for (let a = 0; a < CHUNK;) {
              const id = mask[b * CHUNK + a];
              if (!id) {
                a++;
                continue;
              }
              const combined = levelMask[b * CHUNK + a];
              let w = 1,
                h = 1;
              while (a + w < CHUNK && mask[b * CHUNK + a + w] === id && levelMask[b * CHUNK + a + w] === combined) w++;
              outer: while (b + h < CHUNK) {
                for (let i = 0; i < w; i++)
                  if (mask[(b + h) * CHUNK + a + i] !== id || levelMask[(b + h) * CHUNK + a + i] !== combined)
                    break outer;
                h++;
              }
              const lift = layer + (sign > 0 ? 1 : 0);
              face(
                origin[0] + dx * lift + ux * a + vx * b,
                origin[1] + dy * lift + uy * a + vy * b,
                origin[2] + dz * lift + uz * a + vz * b,
                ux * w,
                uy * w,
                uz * w,
                vx * h,
                vy * h,
                vz * h,
                sign,
                id,
                d,
                false,
                undefined,
                Math.floor(combined / 16) / 15,
                (combined % 16) / 15,
              );
              for (let j = 0; j < h; j++) mask.fill(0, (b + j) * CHUNK + a, (b + j) * CHUNK + a + w);
              a += w;
            }
        }
      }
    }
  }
  const visitSpecial = (fn: (x: number, y: number, z: number, id: number) => void) => {
    if (chunkKey === undefined) {
      world.forEach(fn, region);
      return;
    }
    const chunk = world.chunks.get(chunkKey);
    if (!chunk) return;
    const [ox, oy, oz] = chunk.origin;
    for (let i = 0; i < chunk.cells.length; i++) {
      const id = chunk.cells[i];
      if (!id) continue;
      const x = ox + Math.floor(i / 256),
        y = oy + (Math.floor(i / 16) % 16),
        z = oz + (i % 16);
      if (!region || contains(region, x, y, z)) fn(x, y, z, id);
    }
  };
  visitSpecial((x, y, z, id) => {
      const s = world.palette[id]!;
      if (cube[id]) return;
      const geometry = staticGeometry[id] ?? visualGeometry(s, ([dx, dy, dz]) => world.palette[get([x + dx, y + dy, z + dz])]);
      if (geometry.placeholder) {
        const key = id + '|' + geometry.placeholder;
        let item = diagnostics.get(key);
        if (!item) {
          item = {
            code: 'placeholder',
            name: s.name,
            states: s.states,
            reason: geometry.placeholder,
            count: 0,
            samples: [],
          };
          diagnostics.set(key, item);
        }
        item.count++;
        if (item.samples.length < 16) item.samples.push([x, y, z]);
      }
      for (const [boxIndex, box] of geometry.boxes.entries()) {
        const w0 = box[3] - box[0],
          w1 = box[4] - box[1],
          w2 = box[5] - box[2];
        for (let d = 0; d < 3; d++)
          for (const sign of [-1, 1]) {
            // A contiguous water body has a shell, not six transparent faces
            // per voxel. Cull only fully covered boundary faces; different
            // liquid levels keep their exposed step faces. Region clipping
            // intentionally exposes the cut surface for section views.
            if (geometryKind[id] === 'water' && box[sign > 0 ? d + 3 : d] === (sign > 0 ? 1 : 0)) {
              const adjacent: Vec3 = [x, y, z];
              adjacent[d] += sign;
              const otherId = get(adjacent);
              const other = world.palette[otherId];
              if (cube[otherId] && opacityCache[otherId] === 1) continue;
              if (other && geometryKind[otherId] === 'water') {
                const a = (d + 1) % 3,
                  b = (d + 2) % 3;
                const covered = (staticGeometry[otherId] ?? visualGeometry(other, () => null)).boxes.some(
                  (n) =>
                    n[sign > 0 ? d : d + 3] === (sign > 0 ? 0 : 1) &&
                    n[a] <= box[a] &&
                    n[a + 3] >= box[a + 3] &&
                    n[b] <= box[b] &&
                    n[b + 3] >= box[b + 3],
                );
                if (covered) continue;
              }
            }
            const u = (d + 1) % 3,
              v = (d + 2) % 3,
              shift = sign > 0 ? (d === 0 ? w0 : d === 1 ? w1 : w2) : 0;
            face(
              x + box[0] + (d === 0 ? shift : 0),
              y + box[1] + (d === 1 ? shift : 0),
              z + box[2] + (d === 2 ? shift : 0),
              u === 0 ? w0 : 0,
              u === 1 ? w1 : 0,
              u === 2 ? w2 : 0,
              v === 0 ? w0 : 0,
              v === 1 ? w1 : 0,
              v === 2 ? w2 : 0,
              sign,
              id,
              d,
              !!geometry.placeholder,
              geometry.boxColors?.[boxIndex],
            );
          }
      }
    });
  return {
    diagnostics: [...diagnostics.values()],
    positions: positions.finish(),
    colors: rgb.finish(),
    lights: lightLevels.finish(),
    skies: skyLevels.finish(),
    translucentPositions: translucentPositions.finish(),
    translucentColors: translucentRgb.finish(),
    translucentLights: translucentLightLevels.finish(),
    translucentSkies: translucentSkyLevels.finish(),
    translucentAlphas: translucentAlpha.finish(),
    quads,
    translucentQuads,
    chunks: world.chunks.size,
  };
}

/** Bounded geometric growth replaces boxed number[] staging. Exact output owns its buffer. */
class FloatWriter {
  private data = new Float32Array(4096);
  private length = 0;
  triple(x: number, y: number, z: number) {
    this.ensure(3);
    this.data[this.length++] = x;
    this.data[this.length++] = y;
    this.data[this.length++] = z;
  }
  value(x: number) {
    this.ensure(1);
    this.data[this.length++] = x;
  }
  private ensure(count: number) {
    if (this.length + count <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, this.length + count));
    next.set(this.data);
    this.data = next;
  }
  finish() {
    return this.data.slice(0, this.length);
  }
}
/** Independent caches do not consume a shared dirty set. Region is copied and fixed. */
export class ChunkMeshes {
  readonly meshes = new Map<string, MeshData>();
  private versions = new Map<string, number>();
  private readonly region?: Box;
  private readonly style: Readonly<Record<string, string>>;
  constructor(
    readonly world: Structure,
    region?: Box,
    overrides: Readonly<Record<string, string>> = {},
    private readonly light?: LightSampler | null,
  ) {
    this.style = colorProfile(overrides);
    this.region = region ? { min: [...region.min], max: [...region.max] } : undefined;
  }
  update() {
    const rebuilt: string[] = [];
    for (const [key, { origin }] of this.world.chunks) {
      if (this.region && origin.some((v, i) => v >= this.region!.max[i] || v + CHUNK <= this.region!.min[i])) continue;
      const version = this.world.meshVersions.get(key) ?? 0;
      if (this.versions.get(key) === version) continue;
      this.meshes.set(key, mesh(this.world, this.region, key, this.style, this.light));
      this.versions.set(key, version);
      rebuilt.push(key);
    }
    return rebuilt;
  }
}

/** Aggregate current cache warnings, including unchanged chunks, without unbounded coordinate output. */
export function meshDiagnostics(meshes: Iterable<Pick<MeshData, 'diagnostics'>>): MeshDiagnostic[] {
  const result = new Map<string, MeshDiagnostic>();
  for (const mesh of meshes)
    for (const d of mesh.diagnostics) {
      const key = JSON.stringify([d.name, d.states, d.reason]);
      const old = result.get(key);
      if (old) {
        old.count += d.count;
        old.samples.push(...d.samples.slice(0, Math.max(0, 16 - old.samples.length)));
      } else result.set(key, { ...d, samples: d.samples.slice(0, 16) });
    }
  return [...result.values()];
}
