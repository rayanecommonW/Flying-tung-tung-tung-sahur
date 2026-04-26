/**
 * 8 fixed spawn points around the safe-plaza centre, each oriented to face
 * outward. Picker chooses the spot whose nearest live opponent is furthest
 * away (anti-spawn-camp). See `plans/networking/07_ROOMS_AND_LIFECYCLE.md`.
 */

import { NET, quatFromAxisAngle } from '@flying-tung-tung/shared';
import type { Vec3, Vec4 } from '@flying-tung-tung/shared';
import type { ServerPlayer } from './player';

export interface SpawnPoint {
  position: Vec3;
  orientation: Vec4;
}

/**
 * Build the 8-point spawn ring. Each plane is positioned `R` from origin
 * at altitude 80, and oriented so its local +Z (forward) points radially
 * outward — i.e. away from the centre, into the open plaza.
 */
function buildSpawnPoints(): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  const R = NET.SPAWN_RING_RADIUS;
  const Y = NET.SPAWN_ALTITUDE;
  for (let i = 0; i < 8; i++) {
    const theta = (i / 8) * Math.PI * 2;
    const cx = Math.cos(theta) * R;
    const cz = Math.sin(theta) * R;
    // Forward direction = (cos θ, 0, sin θ). Plane's local +Z must align
    // with that. The base orientation has +Z facing world +Z, so we need a
    // rotation about world Y by `θ - π/2` (because at θ=π/2 the forward
    // should be (0,0,1) which is the identity heading).
    // Equivalent: yaw = atan2(forward.x, forward.z).
    const yaw = Math.atan2(cx, cz);
    const q: Vec4 = { x: 0, y: 0, z: 0, w: 1 };
    quatFromAxisAngle(q, 0, 1, 0, yaw);
    out.push({
      position: { x: cx, y: Y, z: cz },
      orientation: q,
    });
  }
  return out;
}

const SPAWN_POINTS = buildSpawnPoints();

export class SpawnPicker {
  /**
   * Pick the spawn whose nearest live opponent is *furthest* away.
   * Falls back to point 0 for an empty room.
   */
  choose(players: Map<string, ServerPlayer>, excludeId?: string): SpawnPoint {
    let best = SPAWN_POINTS[0]!;
    let bestMinSqDist = -Infinity;
    for (const sp of SPAWN_POINTS) {
      let minSqDist = Infinity;
      for (const p of players.values()) {
        if (!p.alive) continue;
        if (excludeId !== undefined && p.id === excludeId) continue;
        const dx = p.position.x - sp.position.x;
        const dz = p.position.z - sp.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < minSqDist) minSqDist = d2;
      }
      if (minSqDist > bestMinSqDist) {
        bestMinSqDist = minSqDist;
        best = sp;
      }
    }
    return {
      position: { ...best.position },
      orientation: { ...best.orientation },
    };
  }
}
