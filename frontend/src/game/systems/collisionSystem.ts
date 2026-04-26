import * as THREE from 'three';

import type { GameState } from '../gameState';
import type { CityResult } from '../../world/city';
import { worldToCellKey } from '../../world/city';
import type { ParticleTrail } from '../../entities/particleTrail';
import { spawnBurst, BurstKind } from './particleSystem';

const _impactPos = new THREE.Vector3();

/**
 * Tests live projectiles against the city's per-cell building AABBs.
 * On hit: kill the projectile and emit a small boom into the trail's
 * particle pool so the player gets clear visual feedback.
 */
export function updateCollisionSystem(
  state: GameState,
  city: CityResult,
  trail: ParticleTrail
): void {
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
        _impactPos.set(p.position.x, p.position.y, p.position.z);
        spawnBurst(trail, _impactPos, BurstKind.Building, state.time);
        p.alive = false;
        break;
      }
    }
  }
}
