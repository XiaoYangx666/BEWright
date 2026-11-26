import { Structure, type Vec3 } from './structure.js';
/** Ordered layers: later insertion wins; replacing an ID preserves its priority.
 * Inputs are copied. Mutate the result only through replace(); direct writes are not layers.
 */
export class Components {
  readonly world = new Structure();
  private layers = new Map<string, Structure>();
  replace(id: string, source: Structure | null) {
    const snapshot = new Structure();
    if (source) snapshot.paste(source, [0, 0, 0]);
    const affected = new Map<string, Vec3>();
    const collect = (s?: Structure) => s?.forEach((x, y, z) => affected.set(`${x},${y},${z}`, [x, y, z]));
    collect(this.layers.get(id));
    collect(snapshot);
    if (source) this.layers.set(id, snapshot);
    else this.layers.delete(id);
    const ordered = [...this.layers.values()].reverse();
    for (const p of affected.values()) {
      const layer = ordered.find((s) => s.getId(...p) !== 0);
      this.world.set(...p, layer?.get(...p) ?? null);
    }
    return affected.size;
  }
  /** Detached metadata; callers cannot mutate stored snapshots through this API. */
  list() {
    return [...this.layers].map(([id, s]) => ({ id, ...s.inspect() }));
  }
  /** Recompose visible source layers in original priority order, including explicit air. */
  compose(options: { only?: readonly string[]; hide?: readonly string[] } = {}) {
    for (const id of [...(options.only ?? []), ...(options.hide ?? [])])
      if (!this.layers.has(id)) throw new Error(`Unknown component: ${id}`);
    const result = new Structure();
    for (const [id, layer] of this.layers) {
      if ((options.only && !options.only.includes(id)) || options.hide?.includes(id)) continue;
      result.paste(layer, [0, 0, 0]);
    }
    return result;
  }
  get snapshotCellBytes() {
    return [...this.layers.values()].reduce((n, s) => n + s.chunks.size * 8192, 0);
  }
}
