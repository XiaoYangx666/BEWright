import { field, fbmNoise, fieldSlope, fieldRange, seedFor, type Field2, type FieldSource } from './fields.js';

export type TerrainSkeleton = Readonly<{
  /** Base height before any detail noise. */
  base: number;
  /** Summit height of the tallest feature. */
  peak: number;
  /** Plateau terraces: flat tops with explicit transitions, never noisy cones. */
  plateaus?: readonly PlateauSpec[];
  /** Ridge lines: height falls off with distance from these polylines. */
  ridges?: readonly RidgeSpec[];
  /** Valley lines: height drops with proximity to these polylines. */
  valleys?: readonly ValleySpec[];
  /** Saddle: a low pass between two high masses. */
  saddles?: readonly SaddleSpec[];
  /** Foot-of-slope skirt width in blocks (explicit, not noise-driven). */
  skirt?: number;
}>;

export type PlateauSpec = Readonly<{
  id: string;
  /** Inclusive rectangle of the flat top. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Flat top height. */
  top: number;
  /** Transition band width in blocks; the profile is linear, never random. */
  transition: number;
  /** Height at the outer edge of the transition band. */
  outer: number;
  /**
   * Sides where the plateau keeps its top right up to the edge: the ground
   * outside is the surrounding terrain, so the result is a real cliff face
   * instead of a transition band. A waterfall needs something to fall off.
   */
  cliff?: readonly ('x-' | 'x+' | 'z-' | 'z+')[];
}>;

export type RidgeSpec = Readonly<{
  id: string;
  /** Polyline of the crest; `[x,z]` pairs. */
  line: readonly (readonly [number, number])[];
  /** Crest height. */
  crest: number;
  /** Distance over which the ridge fades into the base. */
  falloff: number;
  /** Set false for a valley-shaped cut instead of a rise. */
  raise?: boolean;
}>;

export type ValleySpec = Readonly<{
  id: string;
  line: readonly (readonly [number, number])[];
  /** Floor height at the thalweg. */
  floor: number;
  /** Distance over which the valley climbs back to the base. */
  falloff: number;
}>;

export type SaddleSpec = Readonly<{
  id: string;
  /** Two high masses; the saddle is the low pass between them. */
  a: readonly [number, number];
  b: readonly [number, number];
  /** Saddle (pass) height. */
  height: number;
  /** Radius of influence around the midpoint. */
  radius: number;
}>;

/** Distance from a point to a polyline, in blocks. A single-point line is a point. */
export function distanceToLine(x: number, z: number, line: readonly (readonly [number, number])[]): number {
  if (!line.length) return Infinity;
  if (line.length === 1) return Math.hypot(x - line[0]![0], z - line[0]![1]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1]!;
    const [bx, bz] = line[i]!;
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/**
 * Build the terrain skeleton as a field of integer heights.
 *
 * Composition is explicit so two overlapping features cannot silently cancel
 * each other: the valley decides how deep the ground is cut, then a ridge adds
 * its own height on top but only where it is *stronger* than the valley at that
 * point. A ridge crossing a gorge therefore does not fill the gorge in, while a
 * ridge crest inside the valley's reach still reaches its declared height.
 *
 * Order: valleys cut -> ridges raise -> plateaus flatten (hard override) ->
 * saddles carve the passes. Detail noise is a separate field the caller may
 * add; it is never folded in here, so a flat top cannot be turned into a bumpy
 * cone by a later octave.
 */
export function terrainSkeleton(spec: TerrainSkeleton): Field2 {
  const base = spec.base;
  const valleys = spec.valleys ?? [];
  const ridges = spec.ridges ?? [];
  const plateaus = spec.plateaus ?? [];
  const saddles = spec.saddles ?? [];
  const falloff = (distance: number, reach: number) => (distance >= reach ? 0 : 1 - distance / reach);
  return field(`skeleton(${spec.base}-${spec.peak})`, (x, z) => {
    let valleyCut = 0;
    let cutStrength = 0;
    for (const valley of valleys) {
      const strength = falloff(distanceToLine(x, z, valley.line), valley.falloff);
      if (strength <= 0) continue;
      valleyCut = Math.max(valleyCut, (base - valley.floor) * strength);
      cutStrength = Math.max(cutStrength, strength);
    }
    let height = base - valleyCut;
    for (const ridge of ridges) {
      const strength = falloff(distanceToLine(x, z, ridge.line), ridge.falloff);
      if (strength <= 0) continue;
      const rise = (ridge.crest - base) * strength;
      if (ridge.raise === false) height = Math.min(height, base + rise);
      else if (strength > cutStrength) height = Math.max(height, base + rise);
    }
    for (const plateau of plateaus) {
      const inside = x >= plateau.x0 && x <= plateau.x1 && z >= plateau.z0 && z <= plateau.z1;
      if (inside) {
        height = plateau.top;
        continue;
      }
      // Explicit linear transition band: the "cliff" of a mesa is a designed
      // slope, not a noise artifact. A side declared as `cliff` has no band at
      // all — the plateau simply ends there.
      const cliff = plateau.cliff ?? [];
      const dx = x < plateau.x0 ? plateau.x0 - x : x > plateau.x1 ? x - plateau.x1 : 0;
      const dz = z < plateau.z0 ? plateau.z0 - z : z > plateau.z1 ? z - plateau.z1 : 0;
      if (
        (dx > 0 && cliff.includes(x < plateau.x0 ? 'x-' : 'x+')) ||
        (dz > 0 && cliff.includes(z < plateau.z0 ? 'z-' : 'z+'))
      )
        continue;
      const distance = Math.hypot(dx, dz);
      const skirt = Math.max(0, spec.skirt ?? 0);
      const reach = plateau.transition + skirt;
      if (distance > reach) continue;
      if (distance <= plateau.transition) {
        const t = 1 - distance / plateau.transition;
        height = Math.max(height, plateau.outer + (plateau.top - plateau.outer) * t);
      } else {
        // Foot-of-slope apron: the band continues from `outer` down to the base
        // over the declared skirt width, so a mesa does not end in a hard rim.
        const t = 1 - (distance - plateau.transition) / skirt;
        height = Math.max(height, base + (plateau.outer - base) * t);
      }
    }
    for (const saddle of saddles) {
      const mx = (saddle.a[0] + saddle.b[0]) / 2;
      const mz = (saddle.a[1] + saddle.b[1]) / 2;
      const distance = Math.hypot(x - mx, z - mz);
      if (distance >= saddle.radius) continue;
      const t = 1 - distance / saddle.radius;
      height = Math.min(height, saddle.height + (base - saddle.height) * (1 - t));
    }
    // Cap at the declared summit, and never fall below the world floor: the
    // skeleton is bounded. The floor is `min(0, peak)` — *not* the base, which
    // would undo a valley that was deliberately cut below the base.
    height = Math.min(height, spec.peak);
    height = Math.max(height, Math.min(0, spec.peak));
    return height;
  });
}

/** Straight ridge/valley line between two points, for building polylines. */
export function lineBetween(a: readonly [number, number], b: readonly [number, number]): [number, number][] {
  const points: [number, number][] = [];
  const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  if (steps === 0) return [[a[0], a[1]]];
  for (let i = 0; i <= steps; i++)
    points.push([Math.round(a[0] + ((b[0] - a[0]) * i) / steps), Math.round(a[1] + ((b[1] - a[1]) * i) / steps)]);
  return points;
}

/* ---------------------------------------------------------------------------
 * 山体配方：横断面可控的山，而不是"一条线性坡"或"一堆圆锥"。
 *
 * 一座山由四条横断面段组成，全部显式声明、按距离线性过渡：
 *
 * ```text
 *        crestHalfWidth   shoulderRun        faceRun          skirtRun
 *   ──┬─────────────────┬───────────────┬────────────────┬──────────────
 *     │   平顶 top      │  肩部 top→shoulder │ 陡壁段 shoulder→foot │ 坡脚 foot→base
 * ```
 *
 * `foot` 是坡脚高度，`skirtRun` 是坡脚继续过渡到 `base` 的连续裙摆宽度——
 * 默认带坡脚，所以山脚不会以一条硬边结束。`roughness` 只低频扰动轮廓距离，
 * 不改变横断面本身；细节噪声由 `detail` 单独控制，且受平台与掩码约束。
 * ------------------------------------------------------------------------- */

export type MountainProfile = Readonly<{
  id: string;
  /** Crest polyline in XZ; the summit plateau follows it. */
  line: readonly (readonly [number, number])[];
  /** Half-width of the flat summit plateau around the crest line. */
  crestHalfWidth: number;
  /** Summit height of the plateau. */
  top: number;
  /** Height where the steep face begins. */
  shoulder: number;
  /** Height at the foot of the steep face. */
  foot: number;
  /** Horizontal run of the summit-to-shoulder band. */
  shoulderRun: number;
  /** Horizontal run of the steep face (shoulder -> foot). */
  faceRun: number;
  /** Horizontal run of the foot-of-slope apron (foot -> base). */
  skirtRun: number;
  /** Low-frequency outline distortion in blocks (0 = a perfect offset curve). */
  roughness?: number;
}>;

export type TerrainRecipeSpec = Readonly<{
  /** Ground level away from every feature. */
  base: number;
  seed: number;
  mountains?: readonly MountainProfile[];
  valleys?: readonly ValleySpec[];
  /** Hard flat platforms (yards, building pads): nothing raises or dents them. */
  plateaus?: readonly PlateauSpec[];
  saddles?: readonly SaddleSpec[];
  /** Detail noise added on top of the skeleton, in blocks. */
  detail?: Readonly<{ amplitude: number; scale: number; octaves?: number; channel?: number }>;
}>;

export type TerrainRecipe = Readonly<{
  /** Ground level away from every feature; `TerrainSite.rise` is measured from it. */
  base: number;
  /** Final ground height, an integer block Y. */
  at(x: number, z: number): number;
  /** The same field without detail noise, for reports and cut/fill budgets. */
  skeleton(x: number, z: number): number;
  /** Largest one-step slope of the final field, in blocks. */
  slope(x: number, z: number): number;
  range(x0: number, z0: number, x1: number, z1: number): { min: number; max: number; mean: number; count: number };
}>;

/** Height of one mountain profile at horizontal distance `distance` from its crest. */
export function mountainHeight(profile: MountainProfile, distance: number, base: number): number {
  const crest = Math.max(0, profile.crestHalfWidth);
  const shoulderRun = Math.max(0, profile.shoulderRun);
  const faceRun = Math.max(0, profile.faceRun);
  const skirtRun = Math.max(0, profile.skirtRun);
  if (distance <= crest) return profile.top;
  const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
  if (distance <= crest + shoulderRun)
    return lerp(profile.top, profile.shoulder, shoulderRun === 0 ? 1 : (distance - crest) / shoulderRun);
  if (distance <= crest + shoulderRun + faceRun)
    return lerp(profile.shoulder, profile.foot, faceRun === 0 ? 1 : (distance - crest - shoulderRun) / faceRun);
  if (distance <= crest + shoulderRun + faceRun + skirtRun)
    return lerp(profile.foot, base, skirtRun === 0 ? 1 : (distance - crest - shoulderRun - faceRun) / skirtRun);
  return base;
}

/**
 * Build the terrain recipe as an integer height field.
 *
 * Composition order is explicit, so writing order cannot decide who wins:
 * valleys cut first, mountains raise only where they are stronger than the cut,
 * plateaus override hard, saddles carve the passes, and detail noise is added
 * last with a smaller weight than any declared transition band.
 */
export function terrainRecipe(spec: TerrainRecipeSpec): TerrainRecipe {
  const base = spec.base;
  const mountains = spec.mountains ?? [];
  const valleys = spec.valleys ?? [];
  const plateaus = spec.plateaus ?? [];
  const saddles = spec.saddles ?? [];
  const detail = spec.detail ?? null;
  const detailField = detail
    ? fbmNoise({ seed: spec.seed, scale: detail.scale, octaves: detail.octaves ?? 3, channel: detail.channel ?? 0 })
    : null;
  const roughnessFields = new Map<string, Field2>();
  const roughnessField = (profile: MountainProfile) => {
    const key = `${profile.id}`;
    const existing = roughnessFields.get(key);
    if (existing) return existing;
    const created = fbmNoise({ seed: seedFor(spec.seed, 71), scale: 64, octaves: 3, channel: profile.id.length });
    roughnessFields.set(key, created);
    return created;
  };
  const falloff = (distance: number, reach: number) => (distance >= reach ? 0 : 1 - distance / reach);

  const skeletonAt = (x: number, z: number): number => {
    let valleyCut = 0;
    let cutStrength = 0;
    for (const valley of valleys) {
      const strength = falloff(distanceToLine(x, z, valley.line), valley.falloff);
      if (strength <= 0) continue;
      valleyCut = Math.max(valleyCut, (base - valley.floor) * strength);
      cutStrength = Math.max(cutStrength, strength);
    }
    let height = base - valleyCut;
    for (const profile of mountains) {
      const distance = distanceToLine(x, z, profile.line);
      const reach = Math.max(0, profile.crestHalfWidth) + profile.shoulderRun + profile.faceRun + profile.skirtRun;
      if (distance > reach) continue;
      const roughness = profile.roughness ?? 0;
      const wobble = roughness > 0 ? (roughnessField(profile).at(x, z) - 0.5) * 2 * roughness : 0;
      const shaped = mountainHeight(profile, Math.max(0, distance + wobble), base);
      if (shaped <= base) continue;
      // A mountain may not fill a gorge it crosses: it wins only where it is
      // *stronger* than the valley cut at this point, which is also what keeps
      // the composition independent of the order the features are listed in.
      const strength = falloff(distance, reach);
      if (strength > cutStrength) height = Math.max(height, shaped);
    }
    for (const plateau of plateaus) {
      const inside = x >= plateau.x0 && x <= plateau.x1 && z >= plateau.z0 && z <= plateau.z1;
      if (inside) {
        height = plateau.top;
        continue;
      }
      const dx = x < plateau.x0 ? plateau.x0 - x : x > plateau.x1 ? x - plateau.x1 : 0;
      const dz = z < plateau.z0 ? plateau.z0 - z : z > plateau.z1 ? z - plateau.z1 : 0;
      // A `cliff` side has no transition band: outside it the plateau has no
      // influence at all, which is what makes a vertical face.
      const cliff = plateau.cliff ?? [];
      if (
        (dx > 0 && cliff.includes(x < plateau.x0 ? 'x-' : 'x+')) ||
        (dz > 0 && cliff.includes(z < plateau.z0 ? 'z-' : 'z+'))
      )
        continue;
      const distance = Math.hypot(dx, dz);
      if (distance > plateau.transition) continue;
      const t = 1 - distance / plateau.transition;
      height = Math.max(height, plateau.outer + (plateau.top - plateau.outer) * t);
    }
    for (const saddle of saddles) {
      const mx = (saddle.a[0] + saddle.b[0]) / 2;
      const mz = (saddle.a[1] + saddle.b[1]) / 2;
      const distance = Math.hypot(x - mx, z - mz);
      if (distance >= saddle.radius) continue;
      const t = 1 - distance / saddle.radius;
      height = Math.min(height, saddle.height + (base - saddle.height) * (1 - t));
    }
    return Math.max(height, Math.min(0, base));
  };

  const heightField = field(`recipe(${spec.seed})`, (x, z) => {
    let height = skeletonAt(x, z);
    if (detailField) {
      // Detail only where the ground is not a declared flat surface: a platform
      // inside a mountain must stay exactly flat.
      const onPlatform = plateaus.some(
        (plateau) =>
          x >= plateau.x0 - plateau.transition &&
          x <= plateau.x1 + plateau.transition &&
          z >= plateau.z0 - plateau.transition &&
          z <= plateau.z1 + plateau.transition,
      );
      if (!onPlatform) height += (detailField.at(x, z) - 0.5) * 2 * detail!.amplitude;
    }
    return height;
  });

  return {
    base,
    at: (x, z) => Math.round(heightField.at(x, z)),
    skeleton: (x, z) => Math.round(skeletonAt(x, z)),
    slope: (x, z) => Math.round(fieldSlope(heightField, x, z)),
    range: (x0, z0, x1, z1) => {
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let count = 0;
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const value = heightField.at(x, z);
          min = Math.min(min, value);
          max = Math.max(max, value);
          sum += value;
          count++;
        }
      return {
        min: count ? Math.round(min) : 0,
        max: count ? Math.round(max) : 0,
        mean: count ? sum / count : 0,
        count,
      };
    },
  };
}

/** A bounded grading operation: signed footprint distance, target block Y and an outer blend. */
export type TerrainGrade = Readonly<{
  id: string;
  height: number;
  /** <= 0 inside; Infinity excludes the column (for an intentional cliff). */
  distance: FieldSource;
  transition: number;
}>;

/** Apply explicit grading in order, blending both cuts and fills into the existing terrain. */
export function gradeTerrain(source: TerrainRecipe, grades: readonly TerrainGrade[]): TerrainRecipe {
  for (const grade of grades) {
    if (!Number.isFinite(grade.height) || !Number.isFinite(grade.transition) || grade.transition <= 0)
      throw new Error(`Invalid terrain grade ${grade.id}`);
  }
  const sample = (x: number, z: number, skeleton = false) => {
    let y = skeleton ? source.skeleton(x, z) : source.at(x, z);
    for (const grade of grades) {
      const distance = grade.distance(x, z);
      if (Number.isNaN(distance)) throw new Error(`Invalid distance in terrain grade ${grade.id}`);
      const t = Math.max(0, Math.min(1, 1 - distance / grade.transition));
      const weight = t * t * (3 - 2 * t);
      y += (grade.height - y) * weight;
    }
    return Math.round(y);
  };
  const sampled = field('graded-terrain', (x, z) => sample(x, z));
  return {
    base: source.base,
    at: sampled.at,
    skeleton: (x, z) => sample(x, z, true),
    slope: (x, z) => fieldSlope(sampled, x, z),
    range: (x0, z0, x1, z1) => fieldRange(sampled, x0, z0, x1, z1),
  };
}
