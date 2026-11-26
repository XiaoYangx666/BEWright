import { createNoise2D, createNoise3D, type NoiseFunction2D, type NoiseFunction3D } from 'simplex-noise';

/**
 * 地形场：**可复现、带种子、可组合**。
 *
 * 设计约束来自架构要求：地形骨架由明确的设计约束控制（台地、坡脚、鞍部、
 * 脊线／河谷距离），噪声只用于细节。随机扰动不能用来掩盖平顶陡壁——所以
 * `terrainSkeleton` 这些骨架函数是确定性的，`fbmNoise` 只叠加细节。
 *
 * 噪声本身用成熟库 `simplex-noise`，不自己实现：库负责梯度噪声的质量，
 * 我们只负责**把种子变成可复现的置换表**。`createNoise2D(random)` 接受任意
 * `[0,1)` 随机函数，所以种子通过 `seededRandom` 注入，代替库默认的 `Math.random`。
 * 同一个种子在任意机器、任意次运行上得到逐位相同的置换表与采样值。
 */

export type FieldSource = (x: number, z: number) => number;
export type Field2 = Readonly<{
  id: string;
  /** Evaluate the field. Pure: same input -> same output, always. */
  at(x: number, z: number): number;
}>;

/**
 * Deterministic 32-bit PRNG (mulberry32), used as the noise permutation seed.
 *
 * `simplex-noise` only needs a `[0,1)` source, so any stable PRNG works. This
 * one is small, integer-only and has no hidden global state, which is what makes
 * a seed mean the same thing on every run and every machine.
 */
export function seededRandom(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error('Noise seed must be a finite number');
  let state = Math.floor(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Channel separation: one seed plus a channel is still one deterministic seed. */
export function seedFor(seed: number, channel = 0): number {
  return (Math.floor(seed) ^ Math.imul(channel + 1, 0x9e3779b9)) >>> 0;
}

export type SimplexField = Readonly<{
  /** Raw 2D simplex sample in [-1,1]; zero on the noise lattice (see `latticeSafe`). */
  at(x: number, z: number): number;
  /** The library function, for callers that want to sample 3D or wrap it. */
  noise2D: NoiseFunction2D;
}>;

/**
 * Seeded 2D simplex noise from `simplex-noise`, exposed in its native `[-1,1]`
 * range. Use `fbmNoise` for the normalized `[0,1)` form the rest of the
 * framework expects.
 *
 * **Lattice note**: 2D simplex is zero only at the origin, not across the whole
 * integer lattice (measured: ~5% of integer samples are exactly 0). Sampling
 * whole-block coordinates therefore still gives real relief; `fbmNoise` offsets
 * the sample position anyway, which decorrelates seeds and channels.
 */
export function simplex2D(seed: number, channel = 0): SimplexField {
  const noise2D = createNoise2D(seededRandom(seedFor(seed, channel)));
  return { at: (x, z) => noise2D(x, z), noise2D };
}

/**
 * A seed-derived fractional offset for the sample position.
 *
 * Terrain is generated on whole-block coordinates. `fbmNoise` applies this
 * offset so that different seeds and channels trace different paths through the
 * lattice instead of all landing on the same lattice points. The offset is drawn
 * from the seeded PRNG, so it is reproducible and different per seed/channel.
 */
export function latticeSafe(seed: number, channel = 0): readonly [number, number] {
  const random = seededRandom(seedFor(seed, channel) ^ 0x5bf03635);
  return [random(), random()];
}

export type SimplexField3 = Readonly<{
  /** Raw 3D simplex sample in [-1,1]; zero on the noise lattice (see `latticeSafe3`). */
  at(x: number, y: number, z: number): number;
  /** The library function, for callers that want to wrap or rescale it. */
  noise3D: NoiseFunction3D;
}>;

/**
 * Seeded 3D simplex noise from `simplex-noise`, in its native `[-1,1]` range.
 *
 * **Why 3D matters**: a 2D field is constant along Y, so painting a vertical
 * surface (cliff face, shaft wall, cave mouth) with it produces stripes that run
 * straight up the face — the give-away that the rock is a heightmap. Sampling in
 * 3D breaks that correlation.
 *
 * **Lattice caveat**: unlike the 2D case, 3D simplex **is** degenerate on its own
 * integer lattice — measured, about half of all integer samples come out exactly
 * `0`. Block coordinates are integers, so sampling 3D noise per block without an
 * offset produces a checkerboard of zeros. Use `latticeSafe3` to offset the
 * sample position, or `fbmNoise3D`, which does it for you.
 */
export function simplex3D(seed: number, channel = 0): SimplexField3 {
  const noise3D = createNoise3D(seededRandom(seedFor(seed, channel)));
  return { at: (x, y, z) => noise3D(x, y, z), noise3D };
}

/**
 * The 3D counterpart of `latticeSafe`: three seed-derived fractional offsets.
 *
 * The third offset is drawn from a separate channel so that X/Y/Z are not the
 * same fraction, which would bias the lattice along the diagonal.
 */
export function latticeSafe3(seed: number, channel = 0): readonly [number, number, number] {
  const random = seededRandom(seedFor(seed, channel) ^ 0x2545f491);
  return [random(), random(), random()];
}

export type NoiseSpec3 = Readonly<{
  seed: number;
  /** Base feature size in blocks. */
  scale: number;
  octaves?: number;
  persistence?: number;
  lacunarity?: number;
  channel?: number;
  /** Domain warp, the 3D counterpart of `NoiseSpec.warp`. */
  warp?: Readonly<{ strength: number; scale?: number; channel?: number }>;
}>;

export type Field3 = Readonly<{
  id: string;
  /** Evaluate the field. Pure: same input -> same output, always. */
  at(x: number, y: number, z: number): number;
}>;

/**
 * Fractal 3D simplex noise, normalized to `[0,1)` — the 3D counterpart of
 * `fbmNoise`, for rock mottling, cave carving and any other volume detail that
 * must not be constant along Y.
 *
 * Options mirror `fbmNoise`, including domain warp. Warping a volume needs three
 * independent warp fields, which is why the 2D version's two-field warp does not
 * carry over unchanged.
 */
export function fbmNoise3D(spec: NoiseSpec3): Field3 {
  const octaves = Math.max(1, Math.floor(spec.octaves ?? 4));
  const persistence = spec.persistence ?? 0.5;
  const lacunarity = spec.lacunarity ?? 2;
  if (!Number.isFinite(spec.scale) || spec.scale <= 0) throw new Error('Noise scale must be positive');
  if (!Number.isFinite(persistence) || persistence <= 0) throw new Error('Noise persistence must be positive');
  if (!Number.isFinite(lacunarity) || lacunarity <= 0) throw new Error('Noise lacunarity must be positive');
  const noise = simplex3D(spec.seed, spec.channel ?? 0);
  const warpBase = spec.warp?.channel ?? 900;
  const warpX = spec.warp ? simplex3D(spec.seed, warpBase + 1) : null;
  const warpY = spec.warp ? simplex3D(spec.seed, warpBase + 2) : null;
  const warpZ = spec.warp ? simplex3D(spec.seed, warpBase + 3) : null;
  const warpStrength = spec.warp?.strength ?? 0;
  const warpScale = spec.warp?.scale ?? spec.scale;
  const [offsetX, offsetY, offsetZ] = latticeSafe3(spec.seed, spec.channel ?? 0);
  return {
    id: `fbm3(${spec.seed},${spec.scale})`,
    at(x, y, z) {
      let sampleX = x + offsetX;
      let sampleY = y + offsetY;
      let sampleZ = z + offsetZ;
      if (warpX && warpY && warpZ && warpStrength > 0) {
        sampleX += warpX.at(sampleX / warpScale, sampleY / warpScale, sampleZ / warpScale) * warpStrength;
        sampleY += warpY.at(sampleX / warpScale, sampleY / warpScale, sampleZ / warpScale) * warpStrength;
        sampleZ += warpZ.at(sampleX / warpScale, sampleY / warpScale, sampleZ / warpScale) * warpStrength;
      }
      let amplitude = 1;
      let frequency = 1 / spec.scale;
      let sum = 0;
      let norm = 0;
      for (let octave = 0; octave < octaves; octave++) {
        sum += amplitude * (noise.at(sampleX * frequency, sampleY * frequency, sampleZ * frequency) * 0.5 + 0.5);
        norm += amplitude;
        amplitude *= persistence;
        frequency *= lacunarity;
      }
      return sum / norm;
    },
  };
}

export type NoiseSpec = Readonly<{
  seed: number;
  /** Base feature size in blocks. */
  scale: number;
  octaves?: number;
  persistence?: number;
  lacunarity?: number;
  channel?: number;
  /**
   * Domain warp: the sample position is pushed by another seeded simplex field.
   * Small values (0.5–2 blocks) turn straight-ish ridges into natural meanders.
   */
  warp?: Readonly<{ strength: number; scale?: number; channel?: number }>;
}>;

/**
 * Fractal simplex noise, normalized to `[0,1)`. Detail only — never the skeleton.
 */
export function fbmNoise(spec: NoiseSpec): Field2 {
  const octaves = Math.max(1, Math.floor(spec.octaves ?? 4));
  const persistence = spec.persistence ?? 0.5;
  const lacunarity = spec.lacunarity ?? 2;
  if (!Number.isFinite(spec.scale) || spec.scale <= 0) throw new Error('Noise scale must be positive');
  if (!Number.isFinite(persistence) || persistence <= 0) throw new Error('Noise persistence must be positive');
  if (!Number.isFinite(lacunarity) || lacunarity <= 0) throw new Error('Noise lacunarity must be positive');
  const noise = simplex2D(spec.seed, spec.channel ?? 0);
  const warpX = spec.warp ? simplex2D(spec.seed, (spec.warp.channel ?? 900) + 1) : null;
  const warpZ = spec.warp ? simplex2D(spec.seed, (spec.warp.channel ?? 900) + 2) : null;
  const warpStrength = spec.warp?.strength ?? 0;
  const warpScale = spec.warp?.scale ?? spec.scale;
  const [offsetX, offsetZ] = latticeSafe(spec.seed, spec.channel ?? 0);
  return {
    id: `fbm(${spec.seed},${spec.scale})`,
    at(x, z) {
      let sampleX = x + offsetX;
      let sampleZ = z + offsetZ;
      if (warpX && warpZ && warpStrength > 0) {
        const wx = warpX.at(sampleX / warpScale, sampleZ / warpScale);
        const wz = warpZ.at(sampleX / warpScale, sampleZ / warpScale);
        sampleX += wx * warpStrength;
        sampleZ += wz * warpStrength;
      }
      let amplitude = 1;
      let frequency = 1 / spec.scale;
      let sum = 0;
      let norm = 0;
      for (let octave = 0; octave < octaves; octave++) {
        // `simplex-noise` returns [-1,1]; fold it to [0,1) so octave stacking is
        // a plain weighted mean and the result stays in range by construction.
        sum += amplitude * (noise.at(sampleX * frequency, sampleZ * frequency) * 0.5 + 0.5);
        norm += amplitude;
        amplitude *= persistence;
        frequency *= lacunarity;
      }
      return sum / norm;
    },
  };
}

export function field(id: string, at: FieldSource): Field2 {
  return { id, at };
}

/** Scale a field's output into `[min,max]`. */
export function remap(source: Field2, min: number, max: number): Field2 {
  return field(`${source.id}->[${min},${max}]`, (x, z) => min + (max - min) * source.at(x, z));
}

/** Add fields; useful for "skeleton + detail" composition. */
export function addFields(...fields: readonly Field2[]): Field2 {
  return field(fields.map((item) => item.id).join('+'), (x, z) => fields.reduce((sum, item) => sum + item.at(x, z), 0));
}

export function maxFields(...fields: readonly Field2[]): Field2 {
  return field(fields.map((item) => item.id).join('|'), (x, z) =>
    fields.reduce((best, item) => Math.max(best, item.at(x, z)), -Infinity),
  );
}

/** Blend two fields with a mask field in [0,1]. */
export function blendFields(base: Field2, detail: Field2, mask: Field2): Field2 {
  return field(`${base.id}~${detail.id}`, (x, z) => {
    const t = Math.max(0, Math.min(1, mask.at(x, z)));
    return base.at(x, z) * (1 - t) + detail.at(x, z) * t;
  });
}

/** Clamp and quantize a field to whole blocks; the building decides the step. */
export function quantize(field2: Field2, step = 1, min = -Infinity, max = Infinity): Field2 {
  if (step <= 0) throw new Error('Quantize step must be positive');
  return field(`${field2.id}#${step}`, (x, z) => {
    const value = Math.max(min, Math.min(max, field2.at(x, z)));
    return Math.round(value / step) * step;
  });
}

export type SurfaceMaterialRule = Readonly<{
  id: string;
  /** Weight for this material at a site; higher wins. */
  weight: (site: SiteContext) => number;
}>;

export type SiteContext = Readonly<{
  x: number;
  z: number;
  height: number;
  /** Height above the field's base. */
  rise: number;
  /** Local slope in blocks per step. */
  slope: number;
  /** 0..1 moisture field value. */
  moisture: number;
  /** 0..1 exposure (sky/edge) field value. */
  exposure: number;
}>;

/**
 * Pick a surface material by weighted score. Buildings pass their own rule sets,
 * so no snow line, grass line or biome table is hard-coded in the framework.
 */
export function selectSurfaceMaterial(
  rules: readonly SurfaceMaterialRule[],
  site: SiteContext,
): SurfaceMaterialRule | null {
  let best: SurfaceMaterialRule | null = null;
  let bestWeight = 0;
  for (const rule of rules) {
    const weight = rule.weight(site);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (weight > bestWeight || (weight === bestWeight && best && rule.id < best.id)) {
      best = rule;
      bestWeight = weight;
    }
  }
  return best;
}

/** One entry in a `weightedPick` palette: any value plus its relative weight. */
export type WeightedChoice<T> = Readonly<{ value: T; weight: number }>;

/** Shorthand for a palette entry, so a table reads as `pair('tuff', 0.3)`. */
export function pair<T>(value: T, weight: number): WeightedChoice<T> {
  return { value, weight };
}

/**
 * Pick one value from a weighted palette using a `[0,1)` sample.
 *
 * This is the mechanism behind the pattern every terrain author writes by hand —
 * `r < .58 ? 'stone' : r < .74 ? 'andesite' : …` — with the block names and the
 * thresholds left entirely to the caller. **The framework ships no palettes, no
 * default materials and no biome table**; it only turns weights into a decision.
 *
 * ```ts
 * const ROCK = [pair('stone', 5), pair('andesite', 3), pair('tuff', 2)];
 * const r = mottle.at(x, y, z);          // any [0,1) source, e.g. fbmNoise3D
 * const block = weightedPick(ROCK, r);   // 'stone' ~50% of the time
 * ```
 *
 * - `weight <= 0` entries are skipped, so a palette can disable an option
 *   conditionally without rebuilding the array.
 * - Weights are relative, not probabilities: `[5,3,2]` and `[.5,.3,.2]` agree.
 * - When every weight is non-positive the **last** entry wins. Returning
 *   `undefined` would push a null-check onto every call site for a case that
 *   cannot arise from a literal palette.
 */
export function weightedPick<T>(choices: readonly WeightedChoice<T>[], sample: number): T {
  if (!choices.length) throw new Error('weightedPick needs at least one choice');
  const total = choices.reduce((sum, choice) => sum + Math.max(0, choice.weight), 0);
  if (!(total > 0)) return choices[choices.length - 1]!.value;
  const target = Math.max(0, Math.min(1, sample)) * total;
  let running = 0;
  for (const choice of choices) {
    running += Math.max(0, choice.weight);
    if (target < running) return choice.value;
  }
  return choices[choices.length - 1]!.value;
}

/** Slope of a height field, in blocks per step (max of the four neighbours). */
export function fieldSlope(source: Field2, x: number, z: number): number {
  const here = source.at(x, z);
  return Math.max(
    Math.abs(source.at(x + 1, z) - here),
    Math.abs(source.at(x - 1, z) - here),
    Math.abs(source.at(x, z + 1) - here),
    Math.abs(source.at(x, z - 1) - here),
  );
}

/**
 * Discrete curvature: positive on convex crests, negative in concave hollows,
 * zero on a plane.
 *
 * All eight neighbours are used, because a 4-neighbour (axis-aligned) Laplacian
 * is not rotation-invariant: on a radially symmetric summit it can report a
 * crest on one axis and a hollow on the other, which would make crest-rock and
 * hollow-moss rules flicker with grid direction.
 */
export function fieldCurvature(source: Field2, x: number, z: number): number {
  const centre = source.at(x, z);
  const diagonal = 1 / Math.SQRT2;
  const neighbours =
    (source.at(x + 1, z) + source.at(x - 1, z) + source.at(x, z + 1) + source.at(x, z - 1)) * 1 +
    (source.at(x + 1, z + 1) + source.at(x + 1, z - 1) + source.at(x - 1, z + 1) + source.at(x - 1, z - 1)) * diagonal;
  return centre - neighbours / (4 + 4 * diagonal);
}

/** Grid statistics for reporting "actual coverage" of a generated layer. */
export function fieldRange(source: Field2, x0: number, z0: number, x1: number, z1: number) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      const value = source.at(x, z);
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      count++;
    }
  return { min: count ? min : 0, max: count ? max : 0, mean: count ? sum / count : 0, count };
}
