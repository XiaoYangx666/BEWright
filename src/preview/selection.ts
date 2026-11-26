import { Components } from '../core/components.js';
import { assertBox, type Box, type Vec3 } from '../core/structure.js';
export type PreviewOptions = {
  focus?: string;
  isolate?: readonly string[];
  hide?: readonly string[];
  padding?: number;
  slice?: { axis: 'x' | 'y' | 'z'; min?: number; max?: number };
};
/** Clip a region to an integer half-open slice on one axis. Mutates and returns the region. */
export function sliceRegion(region: Box, slice: { axis: 'x' | 'y' | 'z'; min?: number; max?: number }): Box {
  const axis = ['x', 'y', 'z'].indexOf(slice.axis);
  if (axis < 0) throw new Error('Invalid slice axis');
  for (const n of [slice.min, slice.max])
    if (n !== undefined && !Number.isSafeInteger(n)) throw new Error('Slice limits must be integers');
  if (slice.min !== undefined) region.min[axis] = Math.max(region.min[axis], slice.min);
  if (slice.max !== undefined) region.max[axis] = Math.min(region.max[axis], slice.max);
  return region;
}
/** Select/recompose for inspection; never edits the authoritative world or snapshots. */
export function preparePreview(model: Components, options: PreviewOptions = {}) {
  const list = model.list(),
    focus = options.focus ? list.find((c) => c.id === options.focus) : undefined;
  if (options.focus && !focus) throw new Error(`Unknown focus component: ${options.focus}`);
  if (
    options.focus &&
    (options.hide?.includes(options.focus) || (options.isolate && !options.isolate.includes(options.focus)))
  )
    throw new Error('Focus component is hidden or excluded');
  const padding = options.padding ?? 3;
  if (!Number.isSafeInteger(padding) || padding < 0) throw new Error('Padding must be a non-negative integer');
  const world =
    options.isolate || options.hide ? model.compose({ only: options.isolate, hide: options.hide }) : model.world;
  const whole = world.inspect().bounds;
  if (!whole) throw new Error('Preview selection is empty');
  const base = focus?.bounds ?? whole;
  if (focus && !focus.bounds) throw new Error('Focus component has no visible blocks');
  const region: Box = {
    min: base.min.map((v, i) => Math.max(v - (focus ? padding : 0), whole.min[i])) as Vec3,
    max: base.max.map((v, i) => Math.min(v + (focus ? padding : 0), whole.max[i])) as Vec3,
  };
  if (options.slice) sliceRegion(region, options.slice);
  assertBox(region);
  const summary = world.inspect(region);
  if (!summary.bounds) throw new Error('Preview contains no visible blocks');
  return { world, region, bounds: summary.bounds, summary, sourceRevision: model.world.revision };
}
