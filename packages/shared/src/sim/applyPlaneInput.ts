/**
 * Server-authoritative + client-predicted plane physics step.
 *
 * Pure math — runs identically on the Bun backend (`backend/src/sim/`) and
 * the browser frontend's prediction path (`frontend/src/net/prediction.ts`).
 * Reads numerical constants from `../config` so client and server cannot
 * disagree on tunables.
 *
 * The single function `applyPlaneInput` mutates the supplied `PlayerSimState`
 * in place (no allocations) and returns nothing. Callers are expected to
 * have already reset edge-triggered axes/buttons appropriately.
 *
 * Notes:
 *  - Axes are pre-saturated [-1, +1]; effective angular delta per call is
 *    `axes * MAX_TURN_PER_TICK` independent of `dt`. This matches the
 *    client controller's per-tick rotation behaviour. `dt` *is* used for
 *    forward / lateral position integration.
 *  - Roll axis is reserved (always 0 in v1); banking roll is a render-only
 *    visual and is NOT in the sim state.
 *  - Dodge state lives on the player. When `input.dodge` is true and the
 *    cooldown has elapsed, a side-barrel begins; lateral movement is
 *    integrated for `PLANE.DODGE_DURATION` seconds. Mirrors
 *    `frontend/src/game/systems/planeController.ts` so the local-predicted
 *    plane and the server-simulated plane agree.
 */

import { PLANE } from '../config';
import type { Vec3, Vec4 } from '../types';
import type { InputAxes, InputPayload } from '../events';
import { quatFromAxisAngle, quatMul, quatNormalize, quatRotateVec } from './quat';

/**
 * Mutable per-player simulation state. The wire DTO `PlayerStateDto` is a
 * subset of this; `dodge*` is server-internal book-keeping and never goes
 * out on the wire.
 */
export interface PlayerSimState {
  position: Vec3;
  velocity: Vec3;
  orientation: Vec4;
  turbo: boolean;

  /** True while a side-barrel dodge is currently animating. */
  dodgeActive: boolean;
  /** Seconds elapsed since the active dodge began (0 when inactive). */
  dodgeAccumulator: number;
  /** -1 = barrel left, +1 = barrel right. */
  dodgeDir: 1 | -1;
  /** Seconds remaining before the next dodge is allowed. */
  dodgeCooldownLeft: number;
  /** Visual roll due to active dodge (radians) — overwritten each call. */
  dodgeRoll: number;
}

export interface PlaneInput {
  axes: InputAxes;
  turbo: boolean;
  dodge: boolean;
}

/** Reusable scratch values — module-private since this file is single-threaded. */
const _qPitch: Vec4 = { x: 0, y: 0, z: 0, w: 1 };
const _qYaw: Vec4 = { x: 0, y: 0, z: 0, w: 1 };
const _forward: Vec3 = { x: 0, y: 0, z: 0 };
const _right: Vec3 = { x: 0, y: 0, z: 0 };

export function applyPlaneInput(
  player: PlayerSimState,
  input: PlaneInput,
  dt: number
): void {
  // Convert pre-saturated axes [-1, +1] back to radians.
  const yawAmount = input.axes.yaw * PLANE.MAX_TURN_PER_TICK;
  const pitchAmount = input.axes.pitch * PLANE.MAX_TURN_PER_TICK;

  // Right-multiply orientation by local-X pitch then local-Y yaw.
  if (pitchAmount !== 0) {
    quatFromAxisAngle(_qPitch, 1, 0, 0, pitchAmount);
    quatMul(player.orientation, _qPitch);
  }
  if (yawAmount !== 0) {
    quatFromAxisAngle(_qYaw, 0, 1, 0, yawAmount);
    quatMul(player.orientation, _qYaw);
  }
  quatNormalize(player.orientation);

  // Dodge bookkeeping.
  if (player.dodgeCooldownLeft > 0) {
    player.dodgeCooldownLeft = Math.max(0, player.dodgeCooldownLeft - dt);
  }
  if (input.dodge && !player.dodgeActive && player.dodgeCooldownLeft <= 0) {
    player.dodgeActive = true;
    player.dodgeAccumulator = 0;
    // Pick side from current yaw input intent: positive yaw axis = right.
    player.dodgeDir = input.axes.yaw >= 0 ? 1 : -1;
  }

  let lateralSpeed = 0;
  if (player.dodgeActive) {
    player.dodgeAccumulator += dt;
    if (player.dodgeAccumulator >= PLANE.DODGE_DURATION) {
      player.dodgeActive = false;
      player.dodgeCooldownLeft = PLANE.DODGE_COOLDOWN;
      player.dodgeAccumulator = 0;
      player.dodgeRoll = 0;
    } else {
      const t = player.dodgeAccumulator / PLANE.DODGE_DURATION;
      // One full revolution over the duration (visual only).
      player.dodgeRoll = t * Math.PI * 2 * player.dodgeDir;
      // Lateral speed peaks mid-dodge.
      lateralSpeed = Math.sin(t * Math.PI) * PLANE.DODGE_LATERAL_SPEED * player.dodgeDir;
    }
  } else {
    player.dodgeRoll = 0;
  }

  // Forward velocity along current heading. Throttle is folded in via the
  // boolean turbo flag (we don't honour fractional throttle in v1).
  player.turbo = input.turbo;
  const speed = player.turbo ? PLANE.CRUISE_SPEED * PLANE.TURBO_MULT : PLANE.CRUISE_SPEED;
  quatRotateVec(_forward, player.orientation, 0, 0, 1);
  player.velocity.x = _forward.x * speed;
  player.velocity.y = _forward.y * speed;
  player.velocity.z = _forward.z * speed;

  // Integrate position.
  player.position.x += player.velocity.x * dt;
  player.position.y += player.velocity.y * dt;
  player.position.z += player.velocity.z * dt;

  // Lateral dodge translation along plane-local +X.
  if (lateralSpeed !== 0) {
    quatRotateVec(_right, player.orientation, 1, 0, 0);
    player.position.x += _right.x * lateralSpeed * dt;
    player.position.y += _right.y * lateralSpeed * dt;
    player.position.z += _right.z * lateralSpeed * dt;
  }

  // Soft world boundaries — same axes as PLANE.WORLD_*.
  if (player.position.y < PLANE.WORLD_FLOOR_Y) player.position.y = PLANE.WORLD_FLOOR_Y;
  if (player.position.y > PLANE.WORLD_CEIL_Y) player.position.y = PLANE.WORLD_CEIL_Y;
  const half = PLANE.WORLD_HALF_SIZE;
  if (player.position.x < -half) player.position.x = -half;
  if (player.position.x > half) player.position.x = half;
  if (player.position.z < -half) player.position.z = -half;
  if (player.position.z > half) player.position.z = half;
}

/**
 * Convenience: build an idle input (zero axes, throttle 1, no edges).
 * Used by the server when a player's input queue is empty for a tick so
 * the plane keeps cruising forward instead of freezing in place.
 */
export function buildIdleInput(turbo = false): PlaneInput {
  return {
    axes: { pitch: 0, yaw: 0, roll: 0, throttle: 1 },
    turbo,
    dodge: false,
  };
}

/**
 * Promote a wire `InputPayload` to the smaller `PlaneInput` consumed by
 * `applyPlaneInput`. Server uses this on every drained input.
 */
export function fromInputPayload(p: InputPayload): PlaneInput {
  return {
    axes: p.axes,
    turbo: p.turbo,
    dodge: p.dodge,
  };
}
