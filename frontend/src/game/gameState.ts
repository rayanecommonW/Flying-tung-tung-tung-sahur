import type {
  PlayerInput,
  PlayerState,
  ProjectileState,
  Vec3,
  Vec4,
  SpawnEventDto,
  DespawnEventDto,
  HitEventDto,
  DeathEventDto,
  RespawnEventDto,
} from '@flying-tung-tung/shared';
import { CITY, PLAYER, PROJECTILE } from '@flying-tung-tung/shared';
import type { RemotePlayerView, RemoteProjectileView } from '../net/interpolation';

/**
 * Side-barrel dodge state — see `plans/10_DODGE_AND_DEATH.md`.
 */
export interface DodgeState {
  active: boolean;
  startTime: number;
  /** -1 = barrel left, +1 = barrel right. */
  dir: number;
  duration: number;
  cooldownUntil: number;
}

/** Pre-saturated control axes (output of mouse → controller). */
export interface NetInputAxes {
  pitch: number;
  yaw: number;
}

/** Buffered server-broadcast events kept around for cosmetic + flow consumers. */
export interface NetEventsQueue {
  spawns: SpawnEventDto[];
  despawns: DespawnEventDto[];
  hits: HitEventDto[];
  deaths: DeathEventDto[];
  respawns: RespawnEventDto[];
}

/**
 * Mirror visual handle for a remote player. The actual `THREE.Group` and
 * its mixer live here so the game-state stays the single source of truth
 * for "which planes are spawned right now".
 */
export interface RemotePlayerVisual {
  id: string;
  /** Parent group whose transform we drive each render frame. */
  group: import('three').Group;
  mixer: import('three').AnimationMixer | null;
  /** The clone of the model we attached under `group`. */
  model: import('three').Object3D;
  dispose(): void;
}

export interface GameState {
  /** Total elapsed sim time (sec). */
  time: number;
  /** Local player. (Future: a Map<id, PlayerState>.) */
  player: PlayerState;
  /** Pool of projectiles, fixed size (single-player legacy). */
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

  // ===== Multiplayer fields (filled by netSystem) =====

  /** Latest pre-saturated axes computed by `planeController` for upload. */
  netInputAxes: NetInputAxes;
  /** Authoritative city seed (overrides `CITY.SEED` once welcome lands). */
  citySeed: number;
  /** All non-self players, keyed by socket id. Pose interpolated per render. */
  remotePlayers: Map<string, RemotePlayerView>;
  /** Display names for remote players, keyed by id. */
  remotePlayerNames: Map<string, string>;
  /** Visual handles parallel to `remotePlayers` (one `THREE.Group` per id). */
  remotePlayerVisuals: Map<string, RemotePlayerVisual>;
  /** Server-spawned projectiles, keyed by id. Pose interpolated per render. */
  remoteProjectiles: Map<number, RemoteProjectileView>;
  /** Server-broadcast events queued between snapshots; consumers drain them. */
  netEvents: NetEventsQueue;
  /** True once a network session is up; gates the snapshot-driven death flow. */
  isNetworked: boolean;
}

const SPAWN_POSITION: Vec3 = { x: 0, y: 80, z: 0 };
const SPAWN_ORIENTATION: Vec4 = { x: 0, y: 0, z: 0, w: 1 };

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
      orientation: { ...SPAWN_ORIENTATION },
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
    immunityUntil: PLAYER.IMMUNITY_SEC,
    input: {
      mouseDelta: { x: 0, y: 0 },
      shootPressed: false,
      dodgePressed: false,
      turbo: false,
      pointerLocked: false,
      allowLock: true,
    },

    // Multiplayer fields — empty/sane until netSystem wires them up.
    netInputAxes: { pitch: 0, yaw: 0 },
    citySeed: CITY.SEED,
    remotePlayers: new Map(),
    remotePlayerNames: new Map(),
    remotePlayerVisuals: new Map(),
    remoteProjectiles: new Map(),
    netEvents: {
      spawns: [],
      despawns: [],
      hits: [],
      deaths: [],
      respawns: [],
    },
    isNetworked: false,
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

/**
 * Snap the local player to a server-supplied spawn pose (used after a
 * `respawn` event lands for our own id). Mirrors `resetForRespawn` but
 * doesn't reset client-only HUD/dodge state — the net layer already
 * decides those via the snapshot.
 */
export function applyServerRespawn(state: GameState, position: Vec3, orientation: Vec4): void {
  state.player.position.x = position.x;
  state.player.position.y = position.y;
  state.player.position.z = position.z;
  state.player.velocity.x = 0;
  state.player.velocity.y = 0;
  state.player.velocity.z = 0;
  state.player.orientation.x = orientation.x;
  state.player.orientation.y = orientation.y;
  state.player.orientation.z = orientation.z;
  state.player.orientation.w = orientation.w;
  state.player.roll = 0;
  state.player.dodgeRoll = 0;
  state.player.dead = false;
  state.player.turbo = false;
  state.player.lives = PLAYER.MAX_LIVES;
  state.deathTime = -1;
  state.immunityUntil = state.time + PLAYER.IMMUNITY_SEC;
  state.dodge.active = false;
  state.dodge.cooldownUntil = state.time;
}
