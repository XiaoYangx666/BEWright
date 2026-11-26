import { minecraftBlock } from '../blocks/registry.js';
import { Structure, type Box, type Vec3 } from '../core/structure.js';

export type HorizontalDirection = readonly [dx: -1 | 0 | 1, dz: -1 | 0 | 1];
export type StairFlight = Readonly<{
  start: Vec3;
  direction: HorizontalDirection;
  widthDirection: HorizontalDirection;
  steps: number;
}>;
export type SwitchbackStairSpec = Readonly<{
  material: string;
  landingMaterial: string;
  width: number;
  first: StairFlight;
  landing: Box;
  second: StairFlight;
  requiredHeadroom: number;
}>;

function validateDirection([dx, dz]: HorizontalDirection, label: string) {
  if (Math.abs(dx) + Math.abs(dz) !== 1) throw new Error(`${label} must be one cardinal horizontal direction`);
}

function stairDirection([dx, dz]: HorizontalDirection) {
  return dx > 0 ? 0 : dx < 0 ? 1 : dz > 0 ? 2 : 3;
}

/** Builds the authored blocks only. Clearance remains a contract checked from final-world collision. */
export function buildSwitchbackStair(spec: SwitchbackStairSpec) {
  if (!Number.isSafeInteger(spec.width) || spec.width < 1) throw new Error('Stair width must be a positive integer');
  if (!Number.isFinite(spec.requiredHeadroom) || spec.requiredHeadroom < 1.8)
    throw new Error('requiredHeadroom must be at least 1.8');
  const structure = new Structure();
  const occupied = new Set<string>();
  for (const [label, flight] of [
    ['first', spec.first],
    ['second', spec.second],
  ] as const) {
    validateDirection(flight.direction, `${label}.direction`);
    validateDirection(flight.widthDirection, `${label}.widthDirection`);
    if (flight.direction[0] * flight.widthDirection[0] + flight.direction[1] * flight.widthDirection[1] !== 0)
      throw new Error(`${label} width direction must be perpendicular`);
    if (!Number.isSafeInteger(flight.steps) || flight.steps < 1)
      throw new Error(`${label}.steps must be a positive integer`);
    const stair = minecraftBlock(spec.material, {
      weirdo_direction: stairDirection(flight.direction),
      upside_down_bit: false,
    });
    for (let step = 0; step < flight.steps; step++)
      for (let width = 0; width < spec.width; width++) {
        const x = flight.start[0] + flight.direction[0] * step + flight.widthDirection[0] * width;
        const y = flight.start[1] + step;
        const z = flight.start[2] + flight.direction[1] * step + flight.widthDirection[1] * width;
        const key = `${x},${y},${z}`;
        if (occupied.has(key)) throw new Error(`Stair flights overlap at ${key}`);
        occupied.add(key);
        structure.set(x, y, z, stair);
      }
  }
  const landingMaterial = minecraftBlock(spec.landingMaterial);
  structure.fill(spec.landing, landingMaterial);
  const rise = spec.first.steps + spec.second.steps;
  const expectedSecondY = spec.first.start[1] + spec.first.steps;
  if (spec.second.start[1] !== expectedSecondY) throw new Error(`Second flight must start at y=${expectedSecondY}`);
  return {
    structure,
    contract: Object.freeze({
      width: spec.width,
      rise,
      startFootY: spec.first.start[1],
      endFootY: spec.second.start[1] + spec.second.steps,
      landing: spec.landing,
      requiredHeadroom: spec.requiredHeadroom,
      directions: [spec.first.direction, spec.second.direction] as const,
    }),
  };
}
