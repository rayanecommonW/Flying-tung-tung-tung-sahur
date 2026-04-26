import type { PlayerInput, PlayerState, ProjectileState } from '@flying-tung-tung/shared';
import { PLAYER, PROJECTILE } from '@flying-tung-tung/shared';

/**
 * Side-barrel dodge state — see `plans/10_DODGE_AND_DEATH.md`.
 *
 * `active` true means the dodge is currently animating (rotating + sliding).
 * `cooldownUntil` is the earliest sim-time at which a new dodge can be
 * triggered after the current one ends.
 */
export interface DodgeState {
  active: boolean;
  startTime: number;
  /** -1 = barrel left, +1 = barrel right. */
  dir: number;
  duration: number;
  cooldownUntil: number;
}

export interface GameState {
  /** Total elapsed sim time (sec). */
  time: number;
  /** Local player. (Future: a Map<id, PlayerState>.) */
  player: PlayerState;
  /** Pool of projectiles, fixed size. */
  projectiles: ProjectileState[];
  /** Last shot timestamp for cooldown. */
  lastShotAt: number;
  /** Yaw rate (rad/sec) — derived per tick from the consumed mouse delta. */
  yawRate: number;
  /** Pitch rate (rad/sec) — derived per tick from the consumed mouse delta. */
  pitchRate: number;
  /**
   * Smoothed running average of mouse-x delta. Used by the dodge system to
   * pick a side: positive = recent rightward intent, negative = leftward.
   */
  yawIntent: number;
  /** Particle emission accumulator (fractional particles allowed across ticks). */
  particleBudget: number;
  /** Side-barrel dodge book-keeping. */
  dodge: DodgeState;
  /** Sim-time the player died (-1 while alive). */
  deathTime: number;
  /**
   * Sim-time at which post-hit / post-respawn invulnerability ends.
   * Collision detection skips while `state.time < immunityUntil`.
   */
  immunityUntil: number;
  /** Current input snapshot. */
  input: PlayerInput;
}

const SPAWN_POSITION = { x: 0, y: 80, z: 0 };

export function createGameState(): GameState {
  const projectiles: ProjectileState[] = [];
  for (let i = 0; i < PROJECTILE.POOL_SIZE; i++) {
    projectiles.push({
      id: i,
      ownerId: 'local',
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      ageSec: 0,
      alive: false,
    });
  }

  return {
    time: 0,
    player: {
      id: 'local',
      position: { ...SPAWN_POSITION },
      velocity: { x: 0, y: 0, z: 1 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      yaw: 0,
      pitch: 0,
      roll: 0,
      dodgeRoll: 0,
      turbo: false,
      lives: PLAYER.MAX_LIVES,
      dead: false,
    },
    projectiles,
    lastShotAt: -Infinity,
    yawRate: 0,
    pitchRate: 0,
    yawIntent: 0,
    particleBudget: 0,
    dodge: {
      active: false,
      startTime: 0,
      dir: 1,
      duration: 0,
      cooldownUntil: 0,
    },
    deathTime: -1,
    // Grant a brief grace window at startup so the player can orient themselves.
    immunityUntil: PLAYER.IMMUNITY_SEC,
    input: {
      mouseDelta: { x: 0, y: 0 },
      shootPressed: false,
      dodgePressed: false,
      turbo: false,
      pointerLocked: false,
      allowLock: true,
    },
  };
}

/**
 * Reset the player back to their spawn pose with full lives and a fresh
 * post-respawn immunity window. Velocity, dodge, and death book-keeping are
 * cleared. Projectiles in flight are killed so the world looks calm.
 */
export function resetForRespawn(state: GameState): void {
  state.player.position.x = SPAWN_POSITION.x;
  state.player.position.y = SPAWN_POSITION.y;
  state.player.position.z = SPAWN_POSITION.z;
  state.player.velocity.x = 0;
  state.player.velocity.y = 0;
  state.player.velocity.z = 1;
  state.player.orientation.x = 0;
  state.player.orientation.y = 0;
  state.player.orientation.z = 0;
  state.player.orientation.w = 1;
  state.player.yaw = 0;
  state.player.pitch = 0;
  state.player.roll = 0;
  state.player.dodgeRoll = 0;
  state.player.turbo = false;
  state.player.lives = PLAYER.MAX_LIVES;
  state.player.dead = false;

  state.yawRate = 0;
  state.pitchRate = 0;
  state.yawIntent = 0;
  state.dodge.active = false;
  state.dodge.cooldownUntil = state.time;
  state.deathTime = -1;
  state.immunityUntil = state.time + PLAYER.IMMUNITY_SEC;

  for (const p of state.projectiles) p.alive = false;

  state.input.mouseDelta.x = 0;
  state.input.mouseDelta.y = 0;
  state.input.shootPressed = false;
  state.input.dodgePressed = false;
  state.input.turbo = false;
}
