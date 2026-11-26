import { createHash } from 'node:crypto';
import { Structure, type Box, type State } from '../core/structure.js';
import { sceneMesher } from '../mesh/scene.js';
import { packMeshData } from '../mesh/cache.js';
import { LightField } from '../mesh/light.js';
import type { BuildingBlockSupportReport } from '../blocks/support-types.js';

export type PreviewSnapshot = {
  palette: (State | null)[];
  chunks: [string, { origin: [number, number, number]; cells: Uint16Array }][];
  region: Box;
  style: Record<string, string>;
  camera: { eye?: number[]; target?: number[]; direction?: number[]; camera: string };
  /** Opt-in block-light propagation; absent means flat preview colors. */
  light?: boolean;
  views?: { name: string; title?: string; camera: PreviewSnapshot['camera']; available: boolean }[];
  support?: BuildingBlockSupportReport;
};

/** Keeps unchanged mesh buffers across independently generated structures. */
export class IncrementalPreview {
  buffers = new Map<string, { version: number; data: Buffer }>();
  private hashes = new Map<string, string>();
  private configuration = '';
  private world: Structure | null = null;
  private light: LightField | null = null;
  revision = 0;

  update(snapshot: PreviewSnapshot) {
    const started = performance.now();
    const world = new Structure();
    const ids = snapshot.palette.map((state) => (state ? world.intern(state) : 0));
    const semantic = snapshot.palette.map((state) =>
      state
        ? JSON.stringify([state.name, Object.entries(state.states).sort(([a], [b]) => a.localeCompare(b))])
        : 'void',
    );
    const hashes = new Map<string, string>();
    for (const [key, chunk] of snapshot.chunks) {
      if (chunk.origin.some((v, i) => v >= snapshot.region.max[i] + 16 || v + 16 <= snapshot.region.min[i] - 16))
        continue;
      const cells = new Uint16Array(chunk.cells.length);
      const used = new Set<number>();
      for (let i = 0; i < cells.length; i++) {
        const id = chunk.cells[i];
        cells[i] = ids[id];
        used.add(id);
      }
      world.chunks.set(key, { origin: chunk.origin, cells });
      // Local palette normalization prevents unrelated palette insertions invalidating every chunk.
      const names = [...new Set([...used].map((id) => semantic[id]))].sort();
      const local = new Map(names.map((name, id) => [name, id]));
      const lookup = new Uint16Array(snapshot.palette.length);
      for (const id of used) lookup[id] = local.get(semantic[id])!;
      const canonical = new Uint16Array(chunk.cells.length);
      for (let i = 0; i < canonical.length; i++) canonical[i] = lookup[chunk.cells[i]];
      hashes.set(
        key,
        createHash('sha256').update(JSON.stringify(names)).update(Buffer.from(canonical.buffer)).digest('hex'),
      );
    }
    world.invalidateChunkCache();
    // Lighting is opt-in per snapshot: the default preview stays flat and fast.
    // Toggling it changes every mesh color, so it participates in the configuration.
    const wantLight = snapshot.light === true;
    const configuration = JSON.stringify([snapshot.region, Object.entries(snapshot.style).sort(), wantLight]);
    // True content edits drive light repair; a style change only recolors meshes.
    const contentChanged = new Set<string>();
    for (const key of new Set([...hashes.keys(), ...this.hashes.keys()]))
      if (hashes.get(key) !== this.hashes.get(key)) contentChanged.add(key);
    const lightStarted = performance.now();
    let lightChanged = new Set<string>();
    if (wantLight) {
      if (!this.light) this.light = LightField.compute(world);
      else if (contentChanged.size) {
        try {
          lightChanged = this.light.applyWorld(world, contentChanged);
        } catch {
          // A failed repair must never leave the field inconsistent; the full
          // flood is the reference implementation and repairs any state.
          this.light = LightField.compute(world);
          lightChanged = new Set(hashes.keys());
        }
      }
    } else this.light = null;
    const lightMs = Math.round(performance.now() - lightStarted);
    // Light-dirty chunks are already exact: the field marks each changed chunk
    // plus the boundary neighbours whose meshes sample its voxels. Only content
    // edits need the full halo, for connected and shaped block geometry.
    const dirty = new Set<string>(lightChanged);
    const configurationChanged = configuration !== this.configuration;
    const meshChanged = configurationChanged ? hashes.keys() : contentChanged;
    for (const key of meshChanged) {
      const [x, y, z] = key.split(',').map(Number);
      // Include the complete neighboring halo for connected and shaped blocks.
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) dirty.add(`${x + dx},${y + dy},${z + dz}`);
    }
    // A full remesh only visits the current model and its halo. Old buffers
    // outside that area must not carry over to the new configuration.
    const next = configurationChanged ? new Map<string, { version: number; data: Buffer }>() : new Map(this.buffers);
    const revision = this.revision + 1;
    let rebuilt = 0,
      bytes = 0;
    try {
      const mesher = sceneMesher(world, snapshot.region, snapshot.style, this.light);
      for (const [key, result] of mesher.chunks(dirty)) {
        const chunk = world.chunks.get(key);
        if (!result) {
          next.delete(key);
          continue;
        }
        rebuilt++;
        if (!result.positions.length && !result.translucentPositions.length) {
          next.delete(key);
          continue;
        }
        // The page reads the same packed chunk the build cache writes.
        const data = packMeshData(result, chunk!.origin);
        next.set(key, { version: revision, data });
        bytes += data.length;
      }
    } catch (cause) {
      // The published scene must stay consistent with the published field.
      if (this.world) this.light = LightField.compute(this.world);
      throw cause;
    }
    // Publish only after every mesh succeeds, retaining the last valid scene on errors.
    this.buffers = next;
    this.hashes = hashes;
    this.configuration = configuration;
    this.world = world;
    this.revision = revision;
    return {
      rebuilt,
      bytes,
      meshMs: Math.round(performance.now() - started),
      lightMs,
      lightChunks: lightChanged.size,
      chunks: next.size,
    };
  }
}
