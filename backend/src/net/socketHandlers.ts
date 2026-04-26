/**
 * Wires every Socket.IO event listed in `plans/networking/01_PROTOCOL.md` to
 * the supplied `Room`. Handlers here are deliberately thin — they validate
 * the payload shape, then defer to room methods.
 */

import type { Server, Socket } from 'socket.io';
import {
  EVENTS,
  NET,
  PROTOCOL_VERSION,
} from '@flying-tung-tung/shared';
import type {
  HelloPayload,
  InputPayload,
  KickedPayload,
  PingPayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
  PongPayload,
  WelcomePayload,
} from '@flying-tung-tung/shared';

import type { Room } from '../sim/room';
import { createServerPlayer, toPlayerStateDto } from '../sim/player';
import { getServerTimeMs } from '../utils/clock';

function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Pilot';
  // strip control chars + cap to 24 chars + trim.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'Pilot';
}

function isInputPayloadShape(x: unknown): x is InputPayload {
  if (!x || typeof x !== 'object') return false;
  const i = x as Record<string, unknown>;
  if (typeof i.seq !== 'number' || !Number.isFinite(i.seq)) return false;
  if (typeof i.dt !== 'number' || !Number.isFinite(i.dt)) return false;
  if (typeof i.clientTimeMs !== 'number') return false;
  const a = i.axes as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== 'object') return false;
  if (typeof a.pitch !== 'number' || typeof a.yaw !== 'number') return false;
  return true;
}

export function registerSocketHandlers(io: Server, room: Room): void {
  io.on('connection', (socket) => {
    console.info(`[socket] +connect id=${socket.id} (players=${room.players.size}/${room.players.size + 1})`);

    // === 5 s "must hello" deadline ===
    const helloDeadline = setTimeout(() => {
      const kick: KickedPayload = { reason: 'banned', message: 'No hello in time' };
      try {
        socket.emit(EVENTS.KICKED, kick);
      } catch {
        /* swallow — socket may already be gone */
      }
      socket.disconnect(true);
    }, NET.HELLO_DEADLINE_MS);

    socket.on(EVENTS.HELLO, (msg: HelloPayload) => {
      clearTimeout(helloDeadline);
      handleHello(socket, msg, room);
    });

    socket.on(EVENTS.PING, (msg: PingPayload) => handlePing(socket, msg, room));

    socket.on(EVENTS.INPUT, (msg: InputPayload) => handleInput(socket, msg, room));

    socket.on('disconnect', (reason) => {
      clearTimeout(helloDeadline);
      handleDisconnect(socket, reason, room);
    });

    socket.on('error', (err: Error) => {
      console.warn(`[socket] error id=${socket.id}: ${err.message}`);
    });
  });
}

function handleHello(socket: Socket, msg: HelloPayload, room: Room): void {
  if (!msg || typeof msg !== 'object') {
    kick(socket, { reason: 'banned', message: 'Malformed hello' });
    return;
  }
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    kick(socket, {
      reason: 'version-mismatch',
      message: `Protocol version mismatch: client=${msg.protocolVersion} server=${PROTOCOL_VERSION}`,
      serverProtocolVersion: PROTOCOL_VERSION,
    });
    return;
  }
  if (room.isFull()) {
    kick(socket, {
      reason: 'room-full',
      message: `Room is full (${room.players.size}/${(room.constructor as typeof Room).MAX_PLAYERS}). Try again in a minute.`,
    });
    return;
  }

  const now = getServerTimeMs();
  const name = sanitizeName(msg.name);
  const spawn = room.spawnPicker.choose(room.players);
  const player = createServerPlayer(socket, name, spawn, now);
  room.players.set(player.id, player);
  socket.join((room.constructor as typeof Room).ID);

  const welcome: WelcomePayload = {
    playerId: player.id,
    serverTick: room.tick,
    serverTimeMs: now,
    serverTickHz: NET.SERVER_TICK_HZ,
    snapshotHz: NET.SNAPSHOT_HZ,
    citySeed: room.seed,
    spawn: {
      position: { ...spawn.position },
      orientation: { ...spawn.orientation },
    },
    others: [...room.players.values()]
      .filter((p) => p.id !== player.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        position: { x: p.position.x, y: p.position.y, z: p.position.z },
        orientation: {
          x: p.orientation.x,
          y: p.orientation.y,
          z: p.orientation.z,
          w: p.orientation.w,
        },
        hp: p.hp,
        lives: p.lives,
        alive: p.alive,
      })),
    clientTimeMs: typeof msg.clientTimeMs === 'number' ? msg.clientTimeMs : 0,
  };
  socket.emit(EVENTS.WELCOME, welcome);

  const joined: PlayerJoinedPayload = {
    player: {
      id: player.id,
      name: player.name,
      position: { x: player.position.x, y: player.position.y, z: player.position.z },
      orientation: {
        x: player.orientation.x,
        y: player.orientation.y,
        z: player.orientation.z,
        w: player.orientation.w,
      },
      hp: player.hp,
      lives: player.lives,
      alive: player.alive,
    },
  };
  socket.to((room.constructor as typeof Room).ID).emit(EVENTS.PLAYER_JOINED, joined);

  console.info(
    `[room] +join id=${player.id} name="${player.name}" players=${room.players.size}/${(room.constructor as typeof Room).MAX_PLAYERS}`
  );
}

function handlePing(socket: Socket, msg: PingPayload, room: Room): void {
  const now = getServerTimeMs();
  const player = room.players.get(socket.id);
  if (player) player.lastHeardAt = now;

  const reply: PongPayload = {
    clientSendTimeMs: typeof msg?.clientSendTimeMs === 'number' ? msg.clientSendTimeMs : 0,
    serverTimeMs: now,
    serverTick: room.tick,
  };
  socket.emit(EVENTS.PONG, reply);
}

function handleInput(socket: Socket, msg: InputPayload, room: Room): void {
  if (!isInputPayloadShape(msg)) return;
  const now = getServerTimeMs();
  // Defensive: clamp dt to a sane window.
  const safe: InputPayload = {
    seq: Math.floor(msg.seq),
    dt: Math.max(0, Math.min(0.5, msg.dt)),
    clientTimeMs: msg.clientTimeMs,
    axes: {
      pitch: clamp(msg.axes.pitch, -1, 1),
      yaw: clamp(msg.axes.yaw, -1, 1),
      roll: typeof msg.axes.roll === 'number' ? clamp(msg.axes.roll, -1, 1) : 0,
      throttle:
        typeof msg.axes.throttle === 'number' ? clamp(msg.axes.throttle, 0, 1) : 1,
    },
    turbo: !!msg.turbo,
    fire: !!msg.fire,
    dodge: !!msg.dodge,
  };
  room.enqueueInput(socket.id, safe, now);
}

function handleDisconnect(socket: Socket, reason: string, room: Room): void {
  const player = room.players.get(socket.id);
  if (!player) {
    console.info(`[socket] -disconnect id=${socket.id} reason=${reason} (no player)`);
    return;
  }
  room.players.delete(socket.id);
  const left: PlayerLeftPayload = {
    id: socket.id,
    reason: reason === 'ping timeout' ? 'timeout' : 'disconnect',
  };
  room.io.to((room.constructor as typeof Room).ID).emit(EVENTS.PLAYER_LEFT, left);
  console.info(
    `[room] -left id=${socket.id} reason=${reason} players=${room.players.size}/${(room.constructor as typeof Room).MAX_PLAYERS}`
  );
}

function kick(socket: Socket, payload: KickedPayload): void {
  try {
    socket.emit(EVENTS.KICKED, payload);
  } catch {
    /* socket may have died — disconnect anyway */
  }
  console.warn(`[room] kicked id=${socket.id} reason=${payload.reason}`);
  socket.disconnect(true);
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
