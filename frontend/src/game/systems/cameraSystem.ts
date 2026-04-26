import * as THREE from 'three';
import { CAMERA } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import { damp } from '../../utils/math';
import { planeForward } from '../../entities/plane';

const _fwd = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Smooth chase camera that hangs behind & above the plane and looks
 * slightly ahead of it. Also smoothly pumps FOV when turbo is on.
 */
export function updateCameraSystem(
  camera: THREE.PerspectiveCamera,
  state: GameState,
  dt: number
): void {
  const { player } = state;

  planeForward(player, _fwd);

  _desiredPos.set(
    player.position.x - _fwd.x * CAMERA.DISTANCE,
    player.position.y - _fwd.y * CAMERA.DISTANCE + CAMERA.HEIGHT,
    player.position.z - _fwd.z * CAMERA.DISTANCE
  );

  // Smooth position with damping.
  const k = 1 - Math.exp(-dt / CAMERA.TAU_POS);
  camera.position.lerp(_desiredPos, k);

  _lookTarget.set(
    player.position.x + _fwd.x * CAMERA.LOOK_AHEAD,
    player.position.y + _fwd.y * CAMERA.LOOK_AHEAD,
    player.position.z + _fwd.z * CAMERA.LOOK_AHEAD
  );
  camera.up.copy(_up);
  camera.lookAt(_lookTarget);

  const targetFov = player.turbo ? CAMERA.FOV_TURBO : CAMERA.FOV_NORMAL;
  const newFov = damp(camera.fov, targetFov, CAMERA.TAU_FOV, dt);
  if (Math.abs(newFov - camera.fov) > 0.001) {
    camera.fov = newFov;
    camera.updateProjectionMatrix();
  }
}
