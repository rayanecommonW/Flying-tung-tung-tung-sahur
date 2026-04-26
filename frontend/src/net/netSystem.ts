/**
 * Top-level networking system. Wires socket events to the rest of the
 * client: the prediction ring, the interpolation buffers, the remote-player
 * factory, and the snapshot-driven HUD/death paths.
 *
 * Public surface (consumed by `main.ts` + `gameLoop`):
 *   startNetSystem(state, url, name) → NetSystem
 *   netUpdate(state, net, localTickIndex)
 *   netRender(state, net)
 */

import { EVENTS, FIXED_DT, NET, PROTOCOL_VERSION } from '@flying-tung-tung/shared';
import type {
  HelloPayload,
  InputPayload,
  KickedPayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
  SnapshotPayload,
  WelcomePayload,
} from '@flying-tung-tung/shared';

import type { GameState } from '../game/gameState';
import type { TypedSocket } from './socket';
import { createSocket } from './socket';
import { startClockSync, type ClockSyncHandle } from './clock';
import type { NetState } from './netState';
import { createNetState } from './netState';
import { ingestSnapshot, interpolateRemotes } from './interpolation';
import { pushAndSendInput, reconcile } from './prediction';

export interface NetSystem {
  net: NetState;
  socket: TypedSocket;
  /** Resolves once `welcome` has landed; rejects on `kicked` / connect error. */
  ready: Promise<WelcomePayload>;
  shutdown(): void;
}

export interface StartNetOptions {
  serverUrl: string;
  playerName: string;
  /** Optional UI hooks fired on lifecycle events (loading screen, etc.). */
  onWelcome?: (msg: WelcomePayload) => void;
  onKicked?: (msg: KickedPayload) => void;
  onPlayerJoined?: (msg: PlayerJoinedPayload) => void;
  onPlayerLeft?: (msg: PlayerLeftPayload) => void;
  onDisconnected?: (reason: string) => void;
}

export function startNetSystem(state: GameState, opts: StartNetOptions): NetSystem {
  const net = createNetState();
  const socket = createSocket(opts.serverUrl);
  let clockHandle: ClockSyncHandle | null = null;

  let resolveReady: (msg: WelcomePayload) => void = () => {};
  let rejectReady: (err: Error) => void = () => {};
  const ready = new Promise<WelcomePayload>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  socket.onConnect(() => {
    net.connected = true;
    console.info('[net] connected — sending hello');
    const hello: HelloPayload = {
      name: opts.playerName,
      protocolVersion: PROTOCOL_VERSION,
      clientTimeMs: performance.now(),
    };
    socket.emitHello(hello);
    clockHandle = startClockSync(socket, net);
  });

  socket.onDisconnect((reason) => {
    net.connected = false;
    net.lastDisconnectReason = reason;
    console.warn('[net] disconnected:', reason);
    opts.onDisconnected?.(reason);
    if (!net.ready) {
      rejectReady(new Error(`Disconnected before welcome (${reason})`));
    }
  });

  socket.onWelcome((msg: WelcomePayload) => {
    net.selfId = msg.playerId;
    net.citySeed = msg.citySeed;
    net.serverTickHz = msg.serverTickHz;
    net.snapshotHz = msg.snapshotHz;
    net.ready = true;

    // Snap local plane to the server-chosen spawn.
    state.player.id = msg.playerId;
    state.player.position.x = msg.spawn.position.x;
    state.player.position.y = msg.spawn.position.y;
    state.player.position.z = msg.spawn.position.z;
    state.player.orientation.x = msg.spawn.orientation.x;
    state.player.orientation.y = msg.spawn.orientation.y;
    state.player.orientation.z = msg.spawn.orientation.z;
    state.player.orientation.w = msg.spawn.orientation.w;
    state.player.velocity.x = 0;
    state.player.velocity.y = 0;
    state.player.velocity.z = 0;
    state.citySeed = msg.citySeed;

    // Pre-create remote-player views from the existing roster so their
    // first-frame interpolation has somewhere to write into.
    for (const o of msg.others) {
      state.remotePlayers.set(o.id, {
        id: o.id,
        position: { ...o.position },
        velocity: { x: 0, y: 0, z: 0 },
        orientation: { ...o.orientation },
        hp: o.hp,
        lives: o.lives,
        alive: o.alive,
        turbo: false,
      });
      state.remotePlayerNames.set(o.id, o.name);
    }

    console.info(
      `[net] welcome: id=${msg.playerId} citySeed=${msg.citySeed} others=${msg.others.length}`
    );
    opts.onWelcome?.(msg);
    resolveReady(msg);
  });

  socket.onPlayerJoined((msg) => {
    if (state.remotePlayers.has(msg.player.id)) return;
    state.remotePlayers.set(msg.player.id, {
      id: msg.player.id,
      position: { ...msg.player.position },
      velocity: { x: 0, y: 0, z: 0 },
      orientation: { ...msg.player.orientation },
      hp: msg.player.hp,
      lives: msg.player.lives,
      alive: msg.player.alive,
      turbo: false,
    });
    state.remotePlayerNames.set(msg.player.id, msg.player.name);
    console.info(`[net] +playerJoined id=${msg.player.id} name="${msg.player.name}"`);
    opts.onPlayerJoined?.(msg);
  });

  socket.onPlayerLeft((msg) => {
    state.remotePlayers.delete(msg.id);
    state.remotePlayerNames.delete(msg.id);
    state.remotePlayerVisuals.get(msg.id)?.dispose();
    state.remotePlayerVisuals.delete(msg.id);
    net.remotePlayerBuffers.delete(msg.id);
    console.info(`[net] -playerLeft id=${msg.id} reason=${msg.reason}`);
    opts.onPlayerLeft?.(msg);
  });

  socket.onKicked((msg) => {
    net.kickedReason = msg;
    console.warn(`[net] kicked: ${msg.reason} — ${msg.message}`);
    opts.onKicked?.(msg);
    rejectReady(new Error(`Kicked: ${msg.reason} ${msg.message}`));
    socket.disconnect();
  });

  socket.onSnapshot((snap: SnapshotPayload) => {
    handleSnapshot(snap, state, net);
  });

  return {
    net,
    socket,
    ready,
    shutdown(): void {
      clockHandle?.stop();
      socket.disconnect();
    },
  };
}

function handleSnapshot(snap: SnapshotPayload, state: GameState, net: NetState): void {
  ingestSnapshot(snap, net, {
    remotePlayers: state.remotePlayers,
    remoteProjectiles: state.remoteProjectiles,
  });

  // Buffer recent events for one-shot consumers (death VFX, hit flash).
  for (const ev of snap.events.spawns) state.netEvents.spawns.push(ev);
  for (const ev of snap.events.despawns) state.netEvents.despawns.push(ev);
  for (const ev of snap.events.hits) state.netEvents.hits.push(ev);
  for (const ev of snap.events.deaths) state.netEvents.deaths.push(ev);
  for (const ev of snap.events.respawns) state.netEvents.respawns.push(ev);

  // Reconcile self.
  const selfDto = snap.players.find((p) => p.id === net.selfId);
  const myAck = snap.acks.find((a) => a.id === net.selfId);
  reconcile(selfDto, myAck?.seq ?? 0, state, net);
}

// =============================================================================
// Per-tick + per-render hooks
// =============================================================================

let localTickCounter = 0;

/**
 * Send `input` at 30 Hz upload (every 2nd 60 Hz local tick) once welcome
 * has arrived. The caller (`main.ts`) has already mutated `state.player`
 * for this tick via the existing controller.
 */
export function netUpdate(state: GameState, sys: NetSystem): void {
  const net = sys.net;
  if (!net.ready || !net.selfId) return;

  // Latch edges every local tick so we never miss a click between sends.
  if (state.input.shootPressed) {
    net.pendingFire = true;
    state.input.shootPressed = false;
  }
  if (state.input.dodgePressed) {
    net.pendingDodge = true;
    state.input.dodgePressed = false;
  }

  localTickCounter++;
  // Send every other 60 Hz tick.
  if (localTickCounter % 2 !== 0) return;

  const payload: InputPayload = {
    seq: net.nextInputSeq++,
    dt: FIXED_DT * 2,
    clientTimeMs: performance.now(),
    axes: {
      pitch: state.netInputAxes.pitch,
      yaw: state.netInputAxes.yaw,
      roll: 0,
      throttle: 1,
    },
    turbo: state.player.turbo,
    fire: net.pendingFire,
    dodge: net.pendingDodge,
  };
  // Edges consumed by this send.
  net.pendingFire = false;
  net.pendingDodge = false;

  pushAndSendInput(state, net, payload, (p) => sys.socket.emitInput(p));
}

/**
 * Per-render-frame interpolation update. Writes interpolated pose into
 * `state.remotePlayers` + `state.remoteProjectiles` so the render path can
 * read them.
 */
export function netRender(state: GameState, sys: NetSystem): void {
  if (!sys.net.ready) return;
  interpolateRemotes(sys.net, {
    remotePlayers: state.remotePlayers,
    remoteProjectiles: state.remoteProjectiles,
  });
}
