import * as THREE from 'three';
import { PROJECTILE } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import type { ProjectileMesh } from '../../entities/projectile';
import type { PlaneEntity } from '../../entities/plane';
import { planeForward, planeNose } from '../../entities/plane';
import type { ParticleTrail } from '../../entities/particleTrail';
import { spawnBurst, BurstKind } from './particleSystem';

const _nose = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _haloMatrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _haloScale = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _impactPos = new THREE.Vector3();

/**
 * Spawns + advances projectiles. Writes per-instance matrices into the
 * shared core + halo InstancedMeshes and marks them dirty.
 *
 * Ground impacts ("y <= 0") emit a small dust burst into the trail's
 * particle pool. Building impacts are detected and bursted by the
 * collision system, which has access to per-cell AABB lookups.
 */
export function updateProjectileSystem(
  state: GameState,
  plane: PlaneEntity,
  pmesh: ProjectileMesh,
  trail: ParticleTrail,
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
      // Lifetime expiry — silent, no burst.
      p.alive = false;
      continue;
    }
    p.position.x += p.velocity.x * dt;
    p.position.y += p.velocity.y * dt;
    p.position.z += p.velocity.z * dt;

    // Ground impact — kill + dust burst.
    if (p.position.y <= 0) {
      _impactPos.set(p.position.x, 0.05, p.position.z);
      spawnBurst(trail, _impactPos, BurstKind.Ground, state.time);
      p.alive = false;
    }
  }

  // ===== Push instance matrices for both layers =====
  for (let i = 0; i < state.projectiles.length; i++) {
    const p = state.projectiles[i]!;
    if (p.alive) {
      _pos.set(p.position.x, p.position.y, p.position.z);
      _matrix.compose(_pos, _quat, _scale);
      _haloMatrix.compose(_pos, _quat, _haloScale);
    } else {
      _matrix.compose(_zero, _quat, _zeroScale);
      _haloMatrix.compose(_zero, _quat, _zeroScale);
    }
    pmesh.core.setMatrixAt(i, _matrix);
    pmesh.halo.setMatrixAt(i, _haloMatrix);
  }
  pmesh.core.instanceMatrix.needsUpdate = true;
  pmesh.halo.instanceMatrix.needsUpdate = true;
}

const _rPos = new THREE.Vector3();
const _rMat = new THREE.Matrix4();
const _rQuat = new THREE.Quaternion();
const _rScale = new THREE.Vector3(1, 1, 1);
const _rZero = new THREE.Vector3();
const _rZeroScale = new THREE.Vector3(0, 0, 0);

/**
 * Render server-spawned projectiles into the existing InstancedMesh pool.
 * Replaces the local-spawn path of `updateProjectileSystem` when the game
 * is running in network mode — bullet positions come straight from
 * `state.remoteProjectiles` (which was populated/interpolated by the
 * netSystem).
 */
export function renderRemoteProjectiles(
  state: GameState,
  pmesh: ProjectileMesh
): void {
  let i = 0;
  const cap = pmesh.core.count;
  for (const p of state.remoteProjectiles.values()) {
    if (i >= cap) break;
    if (!p.alive) continue;
    _rPos.set(p.position.x, p.position.y, p.position.z);
    _rMat.compose(_rPos, _rQuat, _rScale);
    pmesh.core.setMatrixAt(i, _rMat);
    pmesh.halo.setMatrixAt(i, _rMat);
    i++;
  }
  for (; i < cap; i++) {
    _rMat.compose(_rZero, _rQuat, _rZeroScale);
    pmesh.core.setMatrixAt(i, _rMat);
    pmesh.halo.setMatrixAt(i, _rMat);
  }
  pmesh.core.instanceMatrix.needsUpdate = true;
  pmesh.halo.instanceMatrix.needsUpdate = true;
}
