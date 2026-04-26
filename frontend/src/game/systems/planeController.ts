import { PLANE } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import { clamp, damp, deadZone } from '../../utils/math';
import { planeForward } from '../../entities/plane';

import * as THREE from 'three';

const _forward = new THREE.Vector3();

/**
 * Applies cursor-follow steering math + turbo to the player state.
 * Runs once per fixed tick.
 */
export function updatePlaneController(state: GameState, dt: number): void {
  const { player, input } = state;

  // 1. Cursor with dead zone.
  const ndcX = deadZone(input.cursorNdc.x, PLANE.DEAD_ZONE);
  const ndcY = deadZone(input.cursorNdc.y, PLANE.DEAD_ZONE);

  // 2. Target angular rates.
  const targetYawRate = -ndcX * PLANE.MAX_YAW_RATE;
  const targetPitchRate = ndcY * PLANE.MAX_PITCH_RATE;

  state.yawRate = damp(state.yawRate, targetYawRate, PLANE.TAU_YAW, dt);
  state.pitchRate = damp(state.pitchRate, targetPitchRate, PLANE.TAU_PITCH, dt);

  // 3. Integrate orientation.
  player.yaw += state.yawRate * dt;
  player.pitch = clamp(player.pitch + state.pitchRate * dt, -PLANE.MAX_PITCH, PLANE.MAX_PITCH);

  // 4. Banking roll from yaw rate.
  const targetRoll = -(state.yawRate / PLANE.MAX_YAW_RATE) * PLANE.MAX_ROLL;
  player.roll = damp(player.roll, targetRoll, PLANE.TAU_ROLL, dt);

  // 5. Turbo + forward velocity.
  player.turbo = input.turbo;
  const speed = player.turbo ? PLANE.CRUISE_SPEED * PLANE.TURBO_MULT : PLANE.CRUISE_SPEED;

  planeForward(player, _forward).multiplyScalar(speed);
  player.velocity.x = _forward.x;
  player.velocity.y = _forward.y;
  player.velocity.z = _forward.z;

  // 6. Integrate position.
  player.position.x += player.velocity.x * dt;
  player.position.y += player.velocity.y * dt;
  player.position.z += player.velocity.z * dt;

  // 7. Soft world boundaries.
  if (player.position.y < PLANE.WORLD_FLOOR_Y) {
    player.position.y = PLANE.WORLD_FLOOR_Y;
    if (player.pitch < 0) player.pitch = 0;
  }
  if (player.position.y > PLANE.WORLD_CEIL_Y) {
    player.position.y = PLANE.WORLD_CEIL_Y;
    if (player.pitch > 0) player.pitch = 0;
  }

  const half = PLANE.WORLD_HALF_SIZE;
  // Auto-yaw back toward origin if we cross the soft boundary.
  if (Math.abs(player.position.x) > half || Math.abs(player.position.z) > half) {
    const angleHome = Math.atan2(-player.position.x, -player.position.z);
    let delta = angleHome - player.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    player.yaw += delta * Math.min(1, dt * 0.8);

    // Hard clamp position so we never escape entirely.
    player.position.x = clamp(player.position.x, -half * 1.05, half * 1.05);
    player.position.z = clamp(player.position.z, -half * 1.05, half * 1.05);
  }
}
