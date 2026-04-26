/**
 * Drains the per-tick `state.netEvents` queue (filled by the netSystem on
 * each snapshot) and turns server events into client-side effects:
 *  - `spawns`  → small puff at the muzzle (cosmetic)
 *  - `despawns`→ impact burst at the despawn position (kind depends on reason)
 *  - `hits`    → impact burst + (for self) HUD flash via immunityUntil
 *  - `deaths`  → big death explosion
 *  - `respawns`→ for self, snap pose back to spawn
 *
 * Runs once per fixed tick.
 */

import * as THREE from 'three';
import type { GameState } from '../gameState';
import { applyServerRespawn } from '../gameState';
import type { ParticleTrail } from '../../entities/particleTrail';
import { spawnBurst, BurstKind } from './particleSystem';
import { PLAYER } from '@flying-tung-tung/shared';

const _pos = new THREE.Vector3();

export function updateNetEventsSystem(state: GameState, trail: ParticleTrail): void {
  const e = state.netEvents;

  // === Despawns: most projectile FX live here, including hit-player ===
  if (e.despawns.length > 0) {
    for (const ev of e.despawns) {
      _pos.set(ev.position.x, ev.position.y, ev.position.z);
      switch (ev.reason) {
        case 'hit-ground':
          spawnBurst(trail, _pos, BurstKind.Ground, state.time);
          break;
        case 'hit-player':
        case 'hit-building':
          spawnBurst(trail, _pos, BurstKind.Building, state.time);
          break;
        case 'expired':
        case 'out-of-bounds':
          // silent
          break;
      }
    }
    e.despawns.length = 0;
  }

  // === Hits: small flash + immunity for self ===
  if (e.hits.length > 0) {
    for (const ev of e.hits) {
      if (ev.victimId === state.player.id) {
        // We took damage. Drive HUD flash via immunityUntil.
        state.immunityUntil = state.time + PLAYER.IMMUNITY_SEC;
      }
    }
    e.hits.length = 0;
  }

  // === Deaths: big explosion at corpse position ===
  if (e.deaths.length > 0) {
    for (const ev of e.deaths) {
      _pos.set(ev.position.x, ev.position.y, ev.position.z);
      spawnBurst(trail, _pos, BurstKind.PlayerDeath, state.time);
      if (ev.victimId === state.player.id) {
        state.deathTime = state.time;
      }
    }
    e.deaths.length = 0;
  }

  // === Spawns: occasional muzzle puff for visual feedback ===
  if (e.spawns.length > 0) {
    // For v1 we keep this silent — too noisy at high fire rates and the
    // bullet itself plus the existing trail give plenty of feedback.
    e.spawns.length = 0;
  }

  // === Respawns: snap self pose back when our id appears ===
  if (e.respawns.length > 0) {
    for (const ev of e.respawns) {
      if (ev.playerId === state.player.id) {
        applyServerRespawn(state, ev.position, ev.orientation);
      }
    }
    e.respawns.length = 0;
  }
}
