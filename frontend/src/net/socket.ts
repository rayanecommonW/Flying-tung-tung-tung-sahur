/**
 * Thin typed wrapper over `socket.io-client`.
 *
 * The wrapper exists for two reasons:
 *  1. Discriminated emit/on signatures so call sites can't typo an event
 *     name. All events come from `EVENTS` in the shared package.
 *  2. Wire-up of common error/disconnect logging in one place.
 *
 * The client connects directly to the Socket.IO standalone listener
 * (default `http://localhost:3001`) — see `backend/src/index.ts` for the
 * port-split rationale.
 */

import { io, type Socket } from 'socket.io-client';
import type {
  HelloPayload,
  InputPayload,
  KickedPayload,
  PingPayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
  PongPayload,
  SnapshotPayload,
  WelcomePayload,
} from '@flying-tung-tung/shared';
import { EVENTS } from '@flying-tung-tung/shared';

export interface TypedSocket {
  raw: Socket;
  emitHello(p: HelloPayload): void;
  emitPing(p: PingPayload): void;
  emitInput(p: InputPayload): void;
  onConnect(cb: () => void): void;
  onDisconnect(cb: (reason: string) => void): void;
  onWelcome(cb: (p: WelcomePayload) => void): void;
  onPong(cb: (p: PongPayload) => void): void;
  onSnapshot(cb: (p: SnapshotPayload) => void): void;
  onPlayerJoined(cb: (p: PlayerJoinedPayload) => void): void;
  onPlayerLeft(cb: (p: PlayerLeftPayload) => void): void;
  onKicked(cb: (p: KickedPayload) => void): void;
  disconnect(): void;
}

export function createSocket(url: string): TypedSocket {
  const raw = io(url, {
    transports: ['websocket', 'polling'],
    reconnection: false,
    timeout: 5000,
  });

  raw.on('connect_error', (err: Error) => {
    console.warn('[net] connect_error:', err.message);
  });
  raw.on('error', (err: Error) => {
    console.warn('[net] error:', err);
  });

  return {
    raw,
    emitHello: (p) => raw.emit(EVENTS.HELLO, p),
    emitPing: (p) => raw.emit(EVENTS.PING, p),
    emitInput: (p) => raw.emit(EVENTS.INPUT, p),
    onConnect: (cb) => {
      raw.on('connect', cb);
    },
    onDisconnect: (cb) => {
      raw.on('disconnect', cb);
    },
    onWelcome: (cb) => {
      raw.on(EVENTS.WELCOME, cb);
    },
    onPong: (cb) => {
      raw.on(EVENTS.PONG, cb);
    },
    onSnapshot: (cb) => {
      raw.on(EVENTS.SNAPSHOT, cb);
    },
    onPlayerJoined: (cb) => {
      raw.on(EVENTS.PLAYER_JOINED, cb);
    },
    onPlayerLeft: (cb) => {
      raw.on(EVENTS.PLAYER_LEFT, cb);
    },
    onKicked: (cb) => {
      raw.on(EVENTS.KICKED, cb);
    },
    disconnect: () => raw.disconnect(),
  };
}
