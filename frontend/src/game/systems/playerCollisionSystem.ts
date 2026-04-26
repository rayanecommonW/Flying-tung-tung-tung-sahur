import * as THREE from 'three';
import { CITY, PLANE, PLAYER } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import type { CityResult } from '../../world/city';
import type { ParticleTrail } from '../../entities/particleTrail';
import { spawnBurst, BurstKind } from './particleSystem';

const _impact = new THREE.Vector3();

/**
 * Squared distance from point (cx,cy,cz) to AABB. Standard sphere-AABB test:
 * if this is ≤ r² the sphere overlaps the box.
 */
function sqDistPointAabb(
  cx: number,
  cy: number,
  cz: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number
): number {
  let dx = 0;
  if (cx < minX) dx = minX - cx;
  else if (cx > maxX) dx = cx - maxX;
  let dy = 0;
  if (cy < minY) dy = minY - cy;
  else if (cy > maxY) dy = cy - maxY;
  let dz = 0;
  if (cz < minZ) dz = minZ - cz;
  else if (cz > maxZ) dz = cz - maxZ;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Tests the player's collision sphere against any building AABB in their
 * cell + the eight neighbouring cells (the player straddles cells while
 * moving). Behaviour:
 *
 * - Skipped while `player.dead` is true.
 * - Skipped while `state.time < state.immunityUntil` (post-hit / post-respawn grace).
 * - On hit: decrement `player.lives` by 1 and set `state.immunityUntil`.
 *   - If lives remaining > 0: smaller "Building" burst, plane stays alive.
 *   - If lives reach 0: full PlayerDeath burst, set `dead = true`,
 *     record `deathTime` for the respawn flow.
 *
 * Returning early after the first hit prevents double-counting if multiple
 * neighbours intersect on the same tick.
 */
export function updatePlayerCollisionSystem(
  state: GameState,
  city: CityResult,
  trail: ParticleTrail
): void {
  const { player } = state;
  if (player.dead) return;
  if (state.time < state.immunityUntil) return;

  const r = PLANE.COLLIDER_RADIUS;
  const r2 = r * r;
  const px = player.position.x;
  const py = player.position.y;
  const pz = player.position.z;

  const half = (CITY.GRID_SIZE * CITY.CELL_SIZE) / 2;
  // Outside the city grid → no buildings here.
  if (px < -half || px > half || pz < -half || pz > half) return;

  const cellX = Math.floor((px + half) / CITY.CELL_SIZE);
  const cellZ = Math.floor((pz + half) / CITY.CELL_SIZE);

  // Walk a 3×3 cell neighbourhood so a sphere overlapping a cell border can
  // still find the building it grazes.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const cx = cellX + dx;
      const cz = cellZ + dz;
      if (cx < 0 || cx >= CITY.GRID_SIZE || cz < 0 || cz >= CITY.GRID_SIZE) continue;
      const key = `${cx},${cz}`;
      const indices = city.cellLookup.get(key);
      if (!indices) continue;
      for (const idx of indices) {
        const b = city.buildings[idx]!;
        if (sqDistPointAabb(px, py, pz, b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ) <= r2) {
          // We took a hit. Always grant immunity so the next tick doesn't
          // re-bash us against the same wall.
          state.immunityUntil = state.time + PLAYER.IMMUNITY_SEC;
          player.lives = Math.max(0, player.lives - 1);
          _impact.set(px, py, pz);
          if (player.lives <= 0) {
            // Fatal — full death + big explosion + flow to respawn modal.
            player.dead = true;
            state.deathTime = state.time;
            spawnBurst(trail, _impact, BurstKind.PlayerDeath, state.time);
          } else {
            // Survived — smaller boom puff to signal the hit.
            spawnBurst(trail, _impact, BurstKind.Building, state.time);
          }
          return;
        }
      }
    }
  }
}
