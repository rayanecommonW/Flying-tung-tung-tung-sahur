import * as THREE from 'three';
import { PROJECTILE } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import type { ProjectileMesh } from '../../entities/projectile';
import type { PlaneEntity } from '../../entities/plane';
import { planeForward, planeNose } from '../../entities/plane';

const _nose = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);

/**
 * Spawns + advances projectiles. Writes per-instance matrices into the
 * shared InstancedMesh and marks it dirty.
 */
export function updateProjectileSystem(
  state: GameState,
  plane: PlaneEntity,
  pmesh: ProjectileMesh,
  dt: number
): void {
  // ===== Spawn (edge-triggered) =====
  if (state.input.shootPressed) {
    state.input.shootPressed = false; // consume edge
    if (state.time - state.lastShotAt >= PROJECTILE.COOLDOWN_SEC) {
      const slot = state.projectiles.find((p) => !p.alive);
      if (slot) {
        planeNose(plane, state.player, _nose);
        planeForward(state.player, _fwd).multiplyScalar(PROJECTILE.SPEED);
        slot.position.x = _nose.x;
        slot.position.y = _nose.y;
        slot.position.z = _nose.z;
        slot.velocity.x = _fwd.x;
        slot.velocity.y = _fwd.y;
        slot.velocity.z = _fwd.z;
        slot.ageSec = 0;
        slot.alive = true;
        slot.ownerId = state.player.id;
        state.lastShotAt = state.time;
      }
    }
  }

  // ===== Advance + age =====
  for (const p of state.projectiles) {
    if (!p.alive) continue;
    p.ageSec += dt;
    if (p.ageSec >= PROJECTILE.LIFETIME_SEC) {
      p.alive = false;
      continue;
    }
    p.position.x += p.velocity.x * dt;
    p.position.y += p.velocity.y * dt;
    p.position.z += p.velocity.z * dt;

    // Ground collision (cheap shortcut, real check happens in collisionSystem).
    if (p.position.y <= 0) p.alive = false;
  }

  // ===== Push instance matrices =====
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i]!;
    if (p.alive) {
      _pos.set(p.position.x, p.position.y, p.position.z);
      _matrix.compose(_pos, _quat, _scale);
    } else {
      _matrix.compose(_zero, _quat, _zero);
    }
    pmesh.mesh.setMatrixAt(i, _matrix);
  }
  pmesh.mesh.instanceMatrix.needsUpdate = true;
}
