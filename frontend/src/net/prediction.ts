/**
 * Local-player prediction + reconciliation against server snapshots.
 *
 * v1 model:
 *  - Client physics keep running at 60 Hz via the existing
 *    `planeController` (unchanged). After each fixed tick the netSystem
 *    optionally pushes an `InputPayload` into a 128-slot ring; we send
 *    every other tick (= 30 Hz upload).
 *  - On every snapshot we look up our own entry. If the position error
 *    relative to the server's view is small (< SOFT) we trust prediction
 *    and only adopt the server's stepwise scalars (hp/lives/alive). If
 *    it's large (> HARD) we hard-snap to the server pose. In between,
 *    we lerp/slerp toward the server pose.
 *
 * Note: We deliberately do NOT replay queued inputs after a hard snap in
 * v1 — that would require the shared `applyPlaneInput` to take the same
 * scratch buffers as the production controller. The thresholds are wide
 * enough that a hard snap on LAN is exceptional (server desync, hit, or
 * respawn).
 */

import { NET, vec3Distance, vec3Lerp, quatSlerp } from '@flying-tung-tung/shared';
import type { InputPayload, PlayerStateDto } from '@flying-tung-tung/shared';
import type { GameState } from '../game/gameState';
import type { NetState, PendingInput } from './netState';

/**
 * Push a fresh input into the ring + send it to the server. Caller has
 * already mutated `state.player` for this local tick (prediction).
 */
export function pushAndSendInput(
  state: GameState,
  net: NetState,
  payload: InputPayload,
  emitInput: (p: InputPayload) => void
): void {
  const pending: PendingInput = {
    seq: payload.seq,
    payload,
    predictedAfter: {
      position: { ...state.player.position },
      orientation: { ...state.player.orientation },
    },
  };
  net.inputRing.push(pending);
  if (net.inputRing.length > NET.INPUT_BUFFER_RING_SIZE) {
    net.inputRing.shift();
  }
  emitInput(payload);
}

/**
 * Handle the snapshot's view of the local player. Mutates `state.player`
 * (lives/dead/alive flags always; pose only when error exceeds soft).
 */
export function reconcile(
  selfDto: PlayerStateDto | undefined,
  ackedSeq: number,
  state: GameState,
  net: NetState
): void {
  if (!selfDto) return;
  net.lastSelfDto = selfDto;
  net.lastAckedSeq = ackedSeq;

  // Drop ring entries the server has already applied.
  while (net.inputRing.length > 0 && net.inputRing[0]!.seq <= ackedSeq) {
    net.inputRing.shift();
  }

  // Always adopt stepwise authoritative scalars.
  state.player.lives = selfDto.lives;
  // Map server's `alive` to client's `dead` flag.
  const wasDead = state.player.dead;
  const nowDead = !selfDto.alive;
  state.player.dead = nowDead;
  if (!wasDead && nowDead && state.deathTime < 0) {
    state.deathTime = state.time;
  }
  if (wasDead && !nowDead) {
    // Server respawned us — reset client-side death book-keeping.
    state.deathTime = -1;
  }

  // Pose error against the server's authoritative position.
  const err = vec3Distance(state.player.position, selfDto.position);

  if (err < NET.PRED_SOFT_THRESHOLD_M) {
    return; // trust prediction
  }

  if (err > NET.PRED_HARD_THRESHOLD_M) {
    // Hard snap.
    state.player.position.x = selfDto.position.x;
    state.player.position.y = selfDto.position.y;
    state.player.position.z = selfDto.position.z;
    state.player.velocity.x = selfDto.velocity.x;
    state.player.velocity.y = selfDto.velocity.y;
    state.player.velocity.z = selfDto.velocity.z;
    state.player.orientation.x = selfDto.orientation.x;
    state.player.orientation.y = selfDto.orientation.y;
    state.player.orientation.z = selfDto.orientation.z;
    state.player.orientation.w = selfDto.orientation.w;
    return;
  }

  // Soft correct: lerp/slerp partway toward the server's pose.
  vec3Lerp(state.player.position, state.player.position, selfDto.position, NET.PRED_SMOOTH_RATE);
  vec3Lerp(state.player.velocity, state.player.velocity, selfDto.velocity, NET.PRED_SMOOTH_RATE);
  quatSlerp(
    state.player.orientation,
    state.player.orientation,
    selfDto.orientation,
    NET.PRED_SMOOTH_QSLERP
  );
}
