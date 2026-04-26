import type { PlayerInput, PlayerState, ProjectileState } from '@flying-tung-tung/shared';
import { PROJECTILE } from '@flying-tung-tung/shared';

export interface GameState {
  /** Total elapsed sim time (sec). */
  time: number;
  /** Local player. (Future: a Map<id, PlayerState>.) */
  player: PlayerState;
  /** Pool of projectiles, fixed size. */
  projectiles: ProjectileState[];
  /** Last shot timestamp for cooldown. */
  lastShotAt: number;
  /** Yaw rate (rad/sec) — needed across ticks for damping. */
  yawRate: number;
  /** Pitch rate (rad/sec) — needed across ticks for damping. */
  pitchRate: number;
  /** Current input snapshot. */
  input: PlayerInput;
}

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
      position: { x: 0, y: 80, z: 0 },
      velocity: { x: 0, y: 0, z: 1 },
      yaw: 0,
      pitch: 0,
      roll: 0,
      turbo: false,
    },
    projectiles,
    lastShotAt: -Infinity,
    yawRate: 0,
    pitchRate: 0,
    input: {
      cursorNdc: { x: 0, y: 0 },
      shootPressed: false,
      turbo: false,
    },
  };
}
