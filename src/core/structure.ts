/** Exploratory IR. Coordinates: X east, Y up, Z south. Boxes are half-open. */
export type Vec3 = [number, number, number];
export type Box = { min: Vec3; max: Vec3 };
export type State = Readonly<{ name: string; states: Readonly<Record<string, string | number | boolean>> }>;
export const CHUNK = 16;
export const VOID = 0; // No write; explicit minecraft:air gets a different palette ID.
export function block(name: string, states: State['states'] = {}): State {
  return Object.freeze({ name: name.includes(':') ? name : `minecraft:${name}`, states: Object.freeze({ ...states }) });
}
export const AIR = block('air');
export type StructureSnapshot = Readonly<{
  palette: readonly (State | null)[];
  chunks: readonly (readonly [string, Vec3, Uint16Array])[];
  meshVersions: readonly (readonly [string, number])[];
  revision: number;
  ceiling: number;
}>;
export function assertBox(box: Box) {
  if (![...box.min, ...box.max].every(Number.isSafeInteger) || box.min.some((v, i) => v >= box.max[i]))
    throw new Error('Expected a nonempty integer half-open box');
}
export function contains(box: Box, x: number, y: number, z: number) {
  return x >= box.min[0] && x < box.max[0] && y >= box.min[1] && y < box.max[1] && z >= box.min[2] && z < box.max[2];
}
type Chunk = { origin: Vec3; cells: Uint16Array };

export class Structure {
  // Global palette in the POC. Production: chunk-local palette with uniform/packed modes.
  readonly palette: (State | null)[] = [null];
  readonly chunks = new Map<string, Chunk>();
  /** Column key `cx,cz` -> chunk Y indices present there; keeps `touched()` cheap. */
  private readonly columnChunks = new Map<string, Set<number>>();
  private readonly ids = new Map<string, number>();
  /** Identity fast path: frozen states (the minecraftBlock cache) are immutable, so identical references always share a palette ID. */
  private readonly frozenIds = new Map<State, number>();
  readonly meshVersions = new Map<string, number>();
  /**
   * One-chunk memo for the numeric lookup path. Import-scale models touch
   * millions of cells, and building `"cx,cy,cz"` per read/write dominated both
   * time and garbage; callers that replace `chunks` directly must call
   * `invalidateChunkCache()`.
   */
  private cacheCx = NaN;
  private cacheCy = NaN;
  private cacheCz = NaN;
  private cacheKey = '';
  private cacheChunk: Chunk | undefined;
  revision = 0;
  /**
   * Highest Y of any explicitly written cell, including explicit air.
   * `inspect().bounds` ignores air, so this is the only record of "the model was
   * carved up to here" — surface queries need it to scan the mined-out space.
   */
  ceiling = -Infinity;
  /**
   * `meshVersions` only serves incremental preview meshing. Turn it off for
   * one-shot imports: it costs up to seven string keys per written cell.
   */
  constructor(readonly trackMeshVersions = true) {}

  invalidateChunkCache() {
    this.cacheCx = NaN;
    this.cacheCy = NaN;
    this.cacheCz = NaN;
    this.cacheKey = '';
    this.cacheChunk = undefined;
  }

  private chunkAt(cx: number, cy: number, cz: number): Chunk | undefined {
    if (cx === this.cacheCx && cy === this.cacheCy && cz === this.cacheCz) return this.cacheChunk;
    this.cacheCx = cx;
    this.cacheCy = cy;
    this.cacheCz = cz;
    this.cacheKey = `${cx},${cy},${cz}`;
    this.cacheChunk = this.chunks.get(this.cacheKey);
    return this.cacheChunk;
  }

  snapshot(): StructureSnapshot {
    return {
      palette: [...this.palette],
      chunks: [...this.chunks].map(([key, chunk]) => [key, [...chunk.origin] as Vec3, chunk.cells.slice()]),
      meshVersions: [...this.meshVersions],
      revision: this.revision,
      ceiling: this.ceiling,
    };
  }
  static fromSnapshot(snapshot: StructureSnapshot): Structure {
    if (snapshot.palette[0] !== null || !Number.isSafeInteger(snapshot.revision))
      throw new Error('Invalid structure snapshot');
    const world = new Structure();
    for (let id = 1; id < snapshot.palette.length; id++) {
      const state = snapshot.palette[id];
      if (!state || world.intern(state) !== id) throw new Error('Invalid structure snapshot palette');
    }
    for (const [key, origin, cells] of snapshot.chunks) {
      if (cells.length !== CHUNK ** 3 || origin.some((value) => !Number.isSafeInteger(value) || value % CHUNK !== 0) ||
        key !== origin.map((value) => value / CHUNK).join(','))
        throw new Error('Invalid structure snapshot chunk');
      world.chunks.set(key, { origin: [...origin], cells: cells.slice() });
      const column = `${origin[0] / CHUNK},${origin[2] / CHUNK}`;
      const levels = world.columnChunks.get(column);
      if (levels) levels.add(origin[1] / CHUNK);
      else world.columnChunks.set(column, new Set([origin[1] / CHUNK]));
    }
    for (const [key, version] of snapshot.meshVersions) world.meshVersions.set(key, version);
    world.revision = snapshot.revision;
    world.ceiling = snapshot.ceiling;
    return world;
  }
  intern(state: State): number {
    const frozen = Object.isFrozen(state);
    if (frozen) {
      const cached = this.frozenIds.get(state);
      if (cached !== undefined) return cached;
    }
    const entries = Object.entries(state.states).sort(([a], [b]) => a.localeCompare(b));
    for (const [, value] of entries)
      if (typeof value === 'number' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647))
        throw new Error('State integer must fit NBT int');
    const key = JSON.stringify([state.name, entries]);
    const existing = this.ids.get(key);
    if (existing !== undefined) {
      if (frozen) this.frozenIds.set(state, existing);
      return existing;
    }
    if (this.palette.length >= 65536) throw new Error('POC palette limit; production must upgrade index width');
    const id = this.palette.length;
    this.palette.push(block(state.name, Object.fromEntries(entries)));
    this.ids.set(key, id);
    if (frozen) this.frozenIds.set(state, id);
    return id;
  }
  set(x: number, y: number, z: number, state: State | null) {
    this.setId(x, y, z, state === null ? VOID : this.intern(state));
  }
  setId(x: number, y: number, z: number, id: number) {
    if (
      !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z) ||
      !Number.isInteger(id) || id < 0 || id >= this.palette.length
    )
      throw new Error('Invalid coordinate or palette ID');
    if (y > this.ceiling) this.ceiling = y;
    const cx = Math.floor(x / CHUNK),
      cy = Math.floor(y / CHUNK),
      cz = Math.floor(z / CHUNK);
    let chunk = this.chunkAt(cx, cy, cz);
    if (!chunk) {
      if (id === VOID) return;
      chunk = { origin: [cx * CHUNK, cy * CHUNK, cz * CHUNK], cells: new Uint16Array(CHUNK ** 3) };
      this.chunks.set(this.cacheKey, chunk);
      this.cacheChunk = chunk;
      const column = `${cx},${cz}`;
      const levels = this.columnChunks.get(column);
      if (levels) levels.add(cy);
      else this.columnChunks.set(column, new Set([cy]));
    }
    const lx = x - chunk.origin[0],
      ly = y - chunk.origin[1],
      lz = z - chunk.origin[2];
    const i = (lx * CHUNK + ly) * CHUNK + lz;
    if (chunk.cells[i] !== id) {
      chunk.cells[i] = id;
      this.revision++;
      if (this.trackMeshVersions) this.touchMeshVersions(cx, cy, cz, lx, ly, lz);
    }
  }
  /** Mark the chunk and its 6-neighbours as remeshable. */
  private touchMeshVersions(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number) {
    const key = this.cacheKey;
    this.meshVersions.set(key, this.revision);
    if (lx === 0) this.meshVersions.set(`${cx - 1},${cy},${cz}`, this.revision);
    else if (lx === CHUNK - 1) this.meshVersions.set(`${cx + 1},${cy},${cz}`, this.revision);
    if (ly === 0) this.meshVersions.set(`${cx},${cy - 1},${cz}`, this.revision);
    else if (ly === CHUNK - 1) this.meshVersions.set(`${cx},${cy + 1},${cz}`, this.revision);
    if (lz === 0) this.meshVersions.set(`${cx},${cy},${cz - 1}`, this.revision);
    else if (lz === CHUNK - 1) this.meshVersions.set(`${cx},${cy},${cz + 1}`, this.revision);
  }
  getId(x: number, y: number, z: number): number {
    const cx = Math.floor(x / CHUNK),
      cy = Math.floor(y / CHUNK),
      cz = Math.floor(z / CHUNK);
    const chunk = this.chunkAt(cx, cy, cz);
    return chunk?.cells[((x - cx * CHUNK) * CHUNK + y - cy * CHUNK) * CHUNK + z - cz * CHUNK] ?? VOID;
  }
  get(x: number, y: number, z: number) {
    return this.palette[this.getId(x, y, z)];
  }
  /**
   * True when any block was written into this column at any height.
   * Query layers use it to tell "outside the model" from "inside the model but
   * mined out": the former answers `null`, the latter stops the downward scan.
   */
  touched(x: number, z: number): boolean {
    const cx = Math.floor(x / CHUNK),
      cz = Math.floor(z / CHUNK);
    for (const cy of this.columnChunks.get(`${cx},${cz}`) ?? []) if (this.chunks.has(`${cx},${cy},${cz}`)) return true;
    return false;
  }
  fill(box: Box, state: State | null) {
    assertBox(box);
    const id = state === null ? VOID : this.intern(state);
    if (box.max[0] === box.min[0] + 1 && box.max[2] === box.min[2] + 1) {
      this.fillColumn(box.min[0], box.min[1], box.max[1], box.min[2], id);
      return;
    }
    for (let x = box.min[0]; x < box.max[0]; x++)
      for (let y = box.min[1]; y < box.max[1]; y++)
        for (let z = box.min[2]; z < box.max[2]; z++) this.setId(x, y, z, id);
  }
  /** Same writes as setId(), with the X/Z chunk lookup shared by a vertical run. */
  private fillColumn(x: number, y0: number, y1: number, z: number, id: number) {
    this.ceiling = Math.max(this.ceiling, y1 - 1);
    const cx = Math.floor(x / CHUNK),
      cz = Math.floor(z / CHUNK),
      lx = x - cx * CHUNK,
      lz = z - cz * CHUNK;
    let activeCy = Infinity;
    let key = '';
    let chunk: Chunk | undefined;
    for (let y = y0; y < y1; y++) {
      const cy = Math.floor(y / CHUNK);
      if (cy !== activeCy) {
        activeCy = cy;
        key = `${cx},${cy},${cz}`;
        chunk = this.chunks.get(key);
        if (!chunk && id !== VOID) {
          chunk = { origin: [cx * CHUNK, cy * CHUNK, cz * CHUNK], cells: new Uint16Array(CHUNK ** 3) };
          this.chunks.set(key, chunk);
          const column = `${cx},${cz}`;
          const levels = this.columnChunks.get(column);
          if (levels) levels.add(cy);
          else this.columnChunks.set(column, new Set([cy]));
        }
        this.cacheCx = cx;
        this.cacheCy = cy;
        this.cacheCz = cz;
        this.cacheKey = key;
        this.cacheChunk = chunk;
      }
      if (!chunk) continue;
      const ly = y - cy * CHUNK;
      const index = (lx * CHUNK + ly) * CHUNK + lz;
      if (chunk.cells[index] === id) continue;
      chunk.cells[index] = id;
      this.revision++;
      if (this.trackMeshVersions) this.touchMeshVersions(cx, cy, cz, lx, ly, lz);
    }
  }
  /** Conditional paint. Select against the original region before writing, so predicates cannot see partial edits. */
  fillWhere(box: Box, state: State | null, accepts: (existing: State | null, position: Vec3) => boolean): number {
    assertBox(box);
    const selected: Vec3[] = [];
    for (let x = box.min[0]; x < box.max[0]; x++)
      for (let y = box.min[1]; y < box.max[1]; y++)
        for (let z = box.min[2]; z < box.max[2]; z++)
          if (accepts(this.get(x, y, z), [x, y, z])) selected.push([x, y, z]);
    const id = state === null ? VOID : this.intern(state);
    for (const [x, y, z] of selected) this.setId(x, y, z, id);
    return selected.length;
  }
  /** Translation-only prefab paste. No silent fake rotation of directional states. */
  paste(prefab: Structure, offset: Vec3) {
    if (prefab === this) throw new Error('Paste requires a separate source snapshot');
    const ids = prefab.palette.map((s) => (s ? this.intern(s) : VOID));
    prefab.forEach((x, y, z, id) => this.setId(x + offset[0], y + offset[1], z + offset[2], ids[id]));
  }
  /**
   * Chunk-aligned cell storage, one 16³ array at a time.
   *
   * Streaming consumers (the direct world writer) pull whole chunks instead of
   * asking for every cell, so a multi-million-cell model never has to be
   * materialized a second time as per-cell tuples. Callers still apply
   * `contains(region, ...)` per cell: a chunk that overlaps the region also
   * holds cells outside it.
   */
  *chunksIn(region?: Box): Generator<{ origin: Vec3; cells: Uint16Array }> {
    for (const chunk of this.chunks.values()) {
      const [ox, oy, oz] = chunk.origin;
      if (
        region &&
        (ox >= region.max[0] ||
          ox + CHUNK <= region.min[0] ||
          oy >= region.max[1] ||
          oy + CHUNK <= region.min[1] ||
          oz >= region.max[2] ||
          oz + CHUNK <= region.min[2])
      )
        continue;
      yield chunk;
    }
  }
  forEach(fn: (x: number, y: number, z: number, id: number) => void, region?: Box) {
    for (const {
      origin: [ox, oy, oz],
      cells,
    } of this.chunksIn(region)) {
      for (let i = 0; i < cells.length; i++)
        if (cells[i]) {
          const x = ox + Math.floor(i / 256),
            y = oy + (Math.floor(i / 16) % 16),
            z = oz + (i % 16);
          if (!region || contains(region, x, y, z)) fn(x, y, z, cells[i]);
        }
    }
  }
  inspect(region?: Box) {
    const min: Vec3 = [Infinity, Infinity, Infinity],
      max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const materials: Record<string, number> = {};
    let occupied = 0,
      explicitAir = 0;
    this.forEach((x, y, z, id) => {
      const s = this.palette[id]!;
      if (s.name === 'minecraft:air') {
        explicitAir++;
        return;
      }
      occupied++;
      materials[s.name] = (materials[s.name] ?? 0) + 1;
      [x, y, z].forEach((v, i) => {
        min[i] = Math.min(min[i], v);
        max[i] = Math.max(max[i], v + 1);
      });
    }, region);
    return {
      revision: this.revision,
      occupied,
      explicitAir,
      bounds: occupied ? { min, max } : null,
      materials,
      chunks: this.chunks.size,
      cellBytes: this.chunks.size * CHUNK ** 3 * 2,
    };
  }
}
