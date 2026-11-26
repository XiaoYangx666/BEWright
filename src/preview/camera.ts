import { Vector3 } from 'three';
import { assertBox, type Box, type Vec3 } from '../core/structure.js';

export type PreviewCameraRequest = {
  eye?: Vec3;
  target?: Vec3;
  direction?: Vec3;
  perspective?: boolean;
  /** Vertical world-space span; omit to fit bounds. */
  span?: number;
  aspect?: number;
  padding?: number;
};
/** Orthographic cameras may retreat without changing composition. Perspective eyes remain intentional. */
export function planPreviewCamera(bounds: Box, request: PreviewCameraRequest = {}) {
  assertBox(bounds);
  const aspect = request.aspect ?? 4 / 3,
    padding = request.padding ?? 1.12;
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(padding) || padding < 1)
    throw Error('Invalid camera aspect or padding');
  if (request.span !== undefined && (!Number.isFinite(request.span) || request.span <= 0))
    throw Error('Camera span must be positive');
  for (const v of [request.eye, request.target, request.direction])
    if (v && (v.length !== 3 || v.some((n) => !Number.isFinite(n)))) throw Error('Invalid camera vector');
  const target = new Vector3(...(request.target ?? (bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as Vec3)));
  const direction = request.eye
    ? new Vector3(...request.eye).sub(target)
    : new Vector3(...(request.direction ?? [1, 0.85, 1]));
  if (direction.lengthSq() === 0) throw Error('Camera eye and direction must differ from target');
  direction.normalize();
  const up = Math.abs(direction.y) > 0.999 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(up, direction).normalize(),
    vertical = new Vector3().crossVectors(direction, right);
  let extentX = 0,
    extentY = 0,
    front = -Infinity,
    back = Infinity;
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const p = new Vector3(x, y, z).sub(target),
          depth = p.dot(direction);
        extentX = Math.max(extentX, Math.abs(p.dot(right)));
        extentY = Math.max(extentY, Math.abs(p.dot(vertical)));
        front = Math.max(front, depth);
        back = Math.min(back, depth);
      }
  const originalDistance = request.eye ? new Vector3(...request.eye).distanceTo(target) : 0;
  if (request.perspective && !request.eye) throw Error('Perspective preview requires an explicit eye');
  const distance = request.perspective
    ? originalDistance
    : Math.max(originalDistance, front + Math.max(1, (front - back) * 0.05));
  return {
    eye: target.clone().addScaledVector(direction, distance).toArray() as Vec3,
    target: target.toArray() as Vec3,
    up: up.toArray() as Vec3,
    near: 0.05,
    far: Math.max(10, distance - back + 10),
    span: request.span ?? 2 * Math.max(extentY, extentX / aspect, 0.5) * padding,
    aspect,
    perspective: request.perspective ?? false,
  };
}
