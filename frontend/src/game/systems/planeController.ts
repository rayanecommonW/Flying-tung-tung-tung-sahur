import { PLANE } from '@flying-tung-tung/shared';

import * as THREE from 'three';

import type { GameState } from '../gameState';
import { clamp, damp } from '../../utils/math';
import { planeForward } from '../../entities/plane';

// Local-frame axes used to build the per-tick rotation increment.
const LOCAL_X = new THREE.Vector3(1, 0, 0);
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

// Scratch objects (allocated once, mutated in place).
const _orient = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();

/**
 * Saturating-resistance curve — `tanh(x / limit) * limit`. Behaves linearly
 * near zero (small mouse motions feel natural) and asymptotically approaches
 * ±limit at large inputs (so the further the player pushes the mouse, the
 * less each extra pixel adds, like there's a spring resisting them).
 */
function softLimit(value: number, limit: number): number {
  if (limit <= 0) return 0;
  return limit * Math.tanh(value / limit);
}

/**
 * Delta-driven, quaternion-based plane controller with side-barrel dodge.
 *
 * Standard tick (alive, no dodge):
 *   1. Consume mouse deltas → tanh-saturated pitch & yaw amounts.
 *   2. Right-multiply local-frame rotations onto orientation.
 *   3. Damp banking roll based on yaw input.
 *   4. Move forward at cruise/turbo speed.
 *
 * Dodge tick:
 *   - `dodgeRoll` ramps from 0 to ±2π over `PLANE.DODGE_DURATION`.
 *   - Lateral velocity along plane-local +X (or -X) using a sin half-arc so
 *     the plane eases out, peaks mid-dodge, eases in.
 *   - Forward flight continues; mouse input is *also* still respected so the
 *     player can steer through the dodge if they want.
 *
 * Dead tick: short-circuit; nothing moves.
 */
export function updatePlaneController(state: GameState, dt: number): void {
  const { player, input } = state;

  if (player.dead) {
    // Drain any input edges so they don't fire on respawn.
    input.shootPressed = false;
    input.dodgePressed = false;
    input.mouseDelta.x = 0;
    input.mouseDelta.y = 0;
    return;
  }

  // 1. Consume mouse deltas (and zero them so they don't apply twice).
  const dx = input.mouseDelta.x;
  const dy = input.mouseDelta.y;
  input.mouseDelta.x = 0;
  input.mouseDelta.y = 0;

  // 1b. Update the smoothed yaw-intent — used by the dodge system to pick a side.
  state.yawIntent = damp(state.yawIntent, dx, PLANE.YAW_INTENT_TAU, dt);

  // 1c. Edge-triggered dodge.
  if (input.dodgePressed) {
    input.dodgePressed = false;
    if (!state.dodge.active && state.time >= state.dodge.cooldownUntil) {
      state.dodge.active = true;
      state.dodge.startTime = state.time;
      state.dodge.duration = PLANE.DODGE_DURATION;
      state.dodge.dir = state.yawIntent >= 0 ? 1 : -1;
    }
  }

  // 2. Map pixel deltas to rotation amounts through a saturating curve.
  const pitchSign = PLANE.INVERT_PITCH ? -1 : 1;
  const yawRaw = -dx * PLANE.YAW_SENSITIVITY;
  const pitchRaw = pitchSign * dy * PLANE.PITCH_SENSITIVITY;
  const yawAmount = softLimit(yawRaw, PLANE.MAX_TURN_PER_TICK);
  const pitchAmount = softLimit(pitchRaw, PLANE.MAX_TURN_PER_TICK);

  // 3. Track derivative rates (rad/sec) for HUD/FX consumers.
  state.yawRate = dt > 0 ? yawAmount / dt : 0;
  state.pitchRate = dt > 0 ? pitchAmount / dt : 0;

  // 4. Build incremental quaternions in the plane's local frame and right-multiply.
  _orient.set(player.orientation.x, player.orientation.y, player.orientation.z, player.orientation.w);
  if (pitchAmount !== 0) {
    _qPitch.setFromAxisAngle(LOCAL_X, pitchAmount);
    _orient.multiply(_qPitch);
  }
  if (yawAmount !== 0) {
    _qYaw.setFromAxisAngle(LOCAL_Y, yawAmount);
    _orient.multiply(_qYaw);
  }
  _orient.normalize();
  player.orientation.x = _orient.x;
  player.orientation.y = _orient.y;
  player.orientation.z = _orient.z;
  player.orientation.w = _orient.w;

  // 5. Derive Euler triple for HUD/debug. YXZ matches the flight convention
  //    we used previously and keeps the values intuitive.
  _euler.setFromQuaternion(_orient, 'YXZ');
  player.yaw = _euler.y;
  player.pitch = _euler.x;

  // 6. Banking roll based on the yaw input rate.
  const yawNorm = clamp(yawAmount / PLANE.MAX_TURN_PER_TICK, -1, 1);
  const targetRoll = -yawNorm * PLANE.MAX_ROLL;
  player.roll = damp(player.roll, targetRoll, PLANE.TAU_ROLL, dt);

  // 7. Dodge animation + lateral translation.
  let lateralSpeed = 0;
  if (state.dodge.active) {
    const t = (state.time - state.dodge.startTime) / state.dodge.duration;
    if (t >= 1) {
      // Dodge complete — clear visual roll, start cooldown.
      state.dodge.active = false;
      state.dodge.cooldownUntil = state.time + PLANE.DODGE_COOLDOWN;
      player.dodgeRoll = 0;
    } else {
      // One full revolution over the duration (visual only).
      player.dodgeRoll = t * Math.PI * 2 * state.dodge.dir;
      // Lateral speed peaks mid-dodge and tapers at both ends.
      lateralSpeed = Math.sin(t * Math.PI) * PLANE.DODGE_LATERAL_SPEED * state.dodge.dir;
    }
  } else {
    player.dodgeRoll = 0;
  }

  // 8. Turbo + forward velocity along the plane's current heading.
  player.turbo = input.turbo;
  const speed = player.turbo ? PLANE.CRUISE_SPEED * PLANE.TURBO_MULT : PLANE.CRUISE_SPEED;

  planeForward(player, _forward).multiplyScalar(speed);
  player.velocity.x = _forward.x;
  player.velocity.y = _forward.y;
  player.velocity.z = _forward.z;

  // 9. Integrate position.
  player.position.x += player.velocity.x * dt;
  player.position.y += player.velocity.y * dt;
  player.position.z += player.velocity.z * dt;

  // 10. Add dodge lateral translation along plane-local +X.
  if (lateralSpeed !== 0) {
    _right.set(1, 0, 0).applyQuaternion(_orient);
    player.position.x += _right.x * lateralSpeed * dt;
    player.position.y += _right.y * lateralSpeed * dt;
    player.position.z += _right.z * lateralSpeed * dt;
  }

  // 11. Soft world boundaries: position is clamped, but we never force yaw —
  //     the player keeps full directional control even at the edges.
  if (player.position.y < PLANE.WORLD_FLOOR_Y) player.position.y = PLANE.WORLD_FLOOR_Y;
  if (player.position.y > PLANE.WORLD_CEIL_Y) player.position.y = PLANE.WORLD_CEIL_Y;

  const half = PLANE.WORLD_HALF_SIZE;
  if (player.position.x < -half) player.position.x = -half;
  if (player.position.x > half) player.position.x = half;
  if (player.position.z < -half) player.position.z = -half;
  if (player.position.z > half) player.position.z = half;
}
