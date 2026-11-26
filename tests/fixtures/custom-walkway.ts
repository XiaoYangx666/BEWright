import { minecraftBlock as b, recordRoadPaving, type Vec3, type WalkwaySpec } from 'bewright';

export function customSpec(height = 12): WalkwaySpec {
  return {
    id: 'offset-stone-walkway',
    route: [
      [0, height, 0],
      [20, height, 0],
    ],
    width: 5,
    deckThickness: 1,
    supports: { spacing: 5, minY: 0 },
    railing: { height: 2, postEvery: 4 },
    materials: {}, // Entire components replaced: no unused material placeholders.
    builders: {
      deck: (sink, { road }) => recordRoadPaving(sink, road, { surface: () => b('polished_andesite') }),
      beams: (sink, { edges }) => {
        for (const {
          position: [x, y, z],
        } of edges)
          sink.put(x, y, z, 'stone_brick_slab', { 'minecraft:vertical_half': 'top' });
      },
      support: (sink, site, { surface }) => {
        // Offset the foot along the road; the framework verifies the real floor
        // and the elbow's connected path up to the actual beam underside.
        const footX = site.x + 2,
          ground = surface.terrain(footX, site.z);
        if (ground === null) throw new Error('No ground under offset footing');
        for (let y = ground + 1; y < site.deckY; y++) sink.put(footX, y, site.z, 'stone_bricks');
        for (let x = site.x; x <= footX; x++) sink.put(x, site.deckY - 1, site.z, 'stone_bricks');
        return { footings: [[footX, ground, site.z] as Vec3] };
      },
      railing: (sink, { railSites }) => {
        for (const site of railSites) {
          const [x, y, z] = site.position;
          if (site.post) sink.put(x, y, z, 'stone_brick_wall');
          sink.put(x, y + 1, z, 'spruce_fence');
        }
      },
      details: (sink, { edges }) => {
        // An ornamental tower/brace outside the passage. Details retain their
        // cells and must actually attach; they cannot overwrite the railing.
        const [x, y, z] = edges.find((e) => e.position[2] === -3)!.position;
        for (let h = 0; h <= 6; h++) sink.put(x, y + h, z - 1, 'chiseled_stone_bricks');
        sink.put(x, y + 7, z - 1, 'sea_lantern');
      },
    },
  };
}
