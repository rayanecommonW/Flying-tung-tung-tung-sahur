import * as THREE from 'three';
import { CAMERA } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import { damp } from '../../utils/math';
import { planeForward } from '../../entities/plane';

const _fwd = new THREE.Vector3();
const _orient = new THREE.Quaternion();
const _localUp = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _shake = new THREE.Vector3();

/**
 * Smoothed up-vector. We track the plane's *local* up so the chase camera
 * follows through loops and barrel rolls without flipping. Eased with
 * CAMERA.TAU_UP so transitions feel like one continuous arc instead of a
 * hard snap when the plane crosses 90° pitch.
 */
const _smoothUp = new THREE.Vector3(0, 1, 0);

// Smoothed shake amplitude (eased toward target each tick).
let shakeAmp = 0;

/**
 * Smooth chase camera that hangs behind & above the plane (in plane-local
 * frame) and looks slightly ahead of it. The use of plane-local up + a
 * smoothed up vector for `camera.up` is what fixes the "model reverses at
 * 180°" bug — `lookAt` no longer fights world-up across loops.
 *
 * While turbo is engaged the camera also widens its FOV (Quake-Pro feel)
 * and applies a low-amplitude high-frequency shake.
 */
export function updateCameraSystem(
  camera: THREE.PerspectiveCamera,
  state: GameState,
  dt: number
): void {
  const { player } = state;

  planeForward(player, _fwd);

  // Local up = orientation × (0,1,0). This rotates the camera's vertical
  // offset and roll-anchor with the plane, so we stay "above the cockpit"
  // through any orientation including upside-down flight.
  _orient.set(player.orientation.x, player.orientation.y, player.orientation.z, player.orientation.w);
  _localUp.set(0, 1, 0).applyQuaternion(_orient);

  // Ease the camera's up vector toward the plane's current local up.
  const kUp = 1 - Math.exp(-dt / CAMERA.TAU_UP);
  _smoothUp.lerp(_localUp, kUp).normalize();

  // Desired camera position: behind the plane along its forward axis,
  // offset up along the smoothed local-up axis.
  _desiredPos.set(
    player.position.x - _fwd.x * CAMERA.DISTANCE + _smoothUp.x * CAMERA.HEIGHT,
    player.position.y - _fwd.y * CAMERA.DISTANCE + _smoothUp.y * CAMERA.HEIGHT,
    player.position.z - _fwd.z * CAMERA.DISTANCE + _smoothUp.z * CAMERA.HEIGHT
  );

  // Smooth position with damping.
  const k = 1 - Math.exp(-dt / CAMERA.TAU_POS);
  camera.position.lerp(_desiredPos, k);

  // Speed-rush shake. Only ramps in while turbo is held; eases out smoothly
  // once released so we never end on a jarring snap.
  const targetShake = player.turbo ? CAMERA.SHAKE_TURBO : 0;
  shakeAmp = damp(shakeAmp, targetShake, CAMERA.TAU_SHAKE, dt);
  if (shakeAmp > 0.001) {
    _shake.set(
      (Math.random() - 0.5) * shakeAmp,
      (Math.random() - 0.5) * shakeAmp,
      (Math.random() - 0.5) * shakeAmp * 0.5
    );
    camera.position.add(_shake);
  }

  _lookTarget.set(
    player.position.x + _fwd.x * CAMERA.LOOK_AHEAD,
    player.position.y + _fwd.y * CAMERA.LOOK_AHEAD,
    player.position.z + _fwd.z * CAMERA.LOOK_AHEAD
  );
  camera.up.copy(_smoothUp);
  camera.lookAt(_lookTarget);

  const targetFov = player.turbo ? CAMERA.FOV_TURBO : CAMERA.FOV_NORMAL;
  const newFov = damp(camera.fov, targetFov, CAMERA.TAU_FOV, dt);
  if (Math.abs(newFov - camera.fov) > 0.001) {
    camera.fov = newFov;
    camera.updateProjectionMatrix();
  }
}
