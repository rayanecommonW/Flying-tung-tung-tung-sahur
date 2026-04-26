/**
 * Module-level networking state: clock-sync output, peer + projectile
 * interpolation buffers, local prediction ring, kicked reason, etc.
 *
 * Kept as a plain object (not a class) so it's easy to inspect from the
 * dev console and trivial to serialise for debugging.
 */

import type {
  InputPayload,
  KickedPayload,
  PlayerStateDto,
  ProjectileStateDto,
  Vec3,
  Vec4,
} from '@flying-tung-tung/shared';

/** Single sample in a remote-player interpolation buffer. */
export interface RemotePlayerSample {
  serverTimeMs: number;
  position: Vec3;
  velocity: Vec3;
  orientation: Vec4;
}

/** Single sample in a remote-projectile interpolation buffer. */
export interface RemoteProjectileSample {
  serverTimeMs: number;
  position: Vec3;
  velocity: Vec3;
  ttl: number;
}

/** Locally-buffered input that we sent to the server but haven't been ack'd yet. */
export interface PendingInput {
  seq: number;
  payload: InputPayload;
  /** Predicted local-player pose AFTER applying this input. */
  predictedAfter: { position: Vec3; orientation: Vec4 };
}

export interface NetState {
  // ===== Connection =====
  connected: boolean;
  ready: boolean; // true after WELCOME has populated selfId + spawn
  selfId: string | null;
  citySeed: number | null;
  serverTickHz: number;
  snapshotHz: number;

  // ===== Clock sync =====
  clockOffsetMs: number;
  smoothedRttMs: number;
  lastSnapshotServerTimeMs: number | null;
  lastSnapshotClientRecvMs: number | null;

  // ===== Remote interpolation buffers =====
  remotePlayerBuffers: Map<string, RemotePlayerSample[]>;
  remoteProjectileBuffers: Map<number, RemoteProjectileSample[]>;
  /** Last-known stepwise server state for self (used for HUD + reconcile). */
  lastSelfDto: PlayerStateDto | null;
  /** Set of projectile ids we've seen at least once. */
  knownProjectileIds: Set<number>;

  // ===== Prediction =====
  inputRing: PendingInput[];
  nextInputSeq: number;
  lastAckedSeq: number;
  /** Edge flag set by mouse handler; consumed on next outgoing input. */
  pendingFire: boolean;
  pendingDodge: boolean;

  // ===== Lifecycle / errors =====
  kickedReason: KickedPayload | null;
  lastDisconnectReason: string | null;
}

export function createNetState(): NetState {
  return {
    connected: false,
    ready: false,
    selfId: null,
    citySeed: null,
    serverTickHz: 30,
    snapshotHz: 20,

    clockOffsetMs: 0,
    smoothedRttMs: 0,
    lastSnapshotServerTimeMs: null,
    lastSnapshotClientRecvMs: null,

    remotePlayerBuffers: new Map(),
    remoteProjectileBuffers: new Map(),
    lastSelfDto: null,
    knownProjectileIds: new Set(),

    inputRing: [],
    nextInputSeq: 1,
    lastAckedSeq: 0,
    pendingFire: false,
    pendingDodge: false,

    kickedReason: null,
    lastDisconnectReason: null,
  };
}

/** Best estimate of the server's `serverTimeMs` right now. */
export function serverTimeNow(net: NetState): number {
  return performance.now() + net.clockOffsetMs;
}

export function getOffsetMs(net: NetState): number {
  return net.clockOffsetMs;
}

export function getRttMs(net: NetState): number {
  return net.smoothedRttMs;
}

/** Stored sample for the most recent live projectile of a given id. */
export interface RemoteProjectileEntity {
  id: number;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  ttl: number;
  alive: boolean;
}
