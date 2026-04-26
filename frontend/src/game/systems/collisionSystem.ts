import type { GameState } from '../gameState';
import type { CityResult } from '../../world/city';
import { worldToCellKey } from '../../world/city';

/**
 * Tests live projectiles against the city's per-cell building AABBs.
 * Despawns hits. Cosmetic effects can be hooked in later.
 */
export function updateCollisionSystem(state: GameState, city: CityResult): void {
  for (const p of state.projectiles) {
    if (!p.alive) continue;

    const key = worldToCellKey(p.position.x, p.position.z);
    if (!key) continue;

    const indices = city.cellLookup.get(key);
    if (!indices) continue;

    for (const idx of indices) {
      const b = city.buildings[idx]!;
      if (
        p.position.x >= b.minX &&
        p.position.x <= b.maxX &&
        p.position.y >= b.minY &&
        p.position.y <= b.maxY &&
        p.position.z >= b.minZ &&
        p.position.z <= b.maxZ
      ) {
        p.alive = false;
        break;
      }
    }
  }
}
