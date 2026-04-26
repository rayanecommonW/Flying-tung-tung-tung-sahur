/**
 * Backend entry point.
 *
 * Two listeners side by side, on separate ports:
 *  - `HTTP_PORT`  (default 3000): Hono `/health` endpoint via `Bun.serve`.
 *  - `IO_PORT`    (default 3001): Socket.IO standalone listener.
 *
 * Splitting them avoids the experimental same-port wiring of
 * `@socket.io/bun-engine` 0.0.3, which doesn't yet expose stable hooks for
 * sharing a `Bun.serve` socket with Engine.IO. The frontend connects to
 * the IO_PORT directly (see `frontend/src/net/socket.ts`).
 */

import { Server as IOServer } from 'socket.io';
import { CITY, NET } from '@flying-tung-tung/shared';

import { createServer } from './server';
import { Room } from './sim/room';
import { registerSocketHandlers } from './net/socketHandlers';

const HTTP_PORT = Number(process.env.PORT ?? 3102);
const IO_PORT = Number(process.env.IO_PORT ?? 3101);

// HTTP /health endpoint. Non-critical: if the port is busy we skip it
// rather than killing the entire server, since the game traffic lives on
// the Socket.IO listener below.
const { fetch } = createServer();
let httpRunning = false;
try {
  Bun.serve({ port: HTTP_PORT, fetch });
  httpRunning = true;
} catch (err) {
  console.warn(`[server] HTTP /health unavailable on :${HTTP_PORT}: ${(err as Error).message}`);
}

// Socket.IO + Room game loop.
// CORS is wide-open in v1 — TODO: tighten to dev origins (Vite=5173) before production.
const io = new IOServer(IO_PORT, {
  cors: { origin: '*' },
  // Reasonable defaults; Socket.IO 4.x picks ws+polling.
  pingInterval: 25000,
  pingTimeout: 20000,
});

const room = new Room(io, CITY.SEED);
registerSocketHandlers(io, room);
room.start();

// eslint-disable-next-line no-console
console.info(
  `[server] Listening on :${IO_PORT}, tick ${NET.SERVER_TICK_HZ} Hz, snapshot ${NET.SNAPSHOT_HZ} Hz`
);
if (httpRunning) {
  // eslint-disable-next-line no-console
  console.info(`[server] HTTP /health on :${HTTP_PORT}`);
}
// eslint-disable-next-line no-console
console.info(`[server] room seed=${room.seed}`);

// Graceful shutdown on SIGINT/SIGTERM so the watcher restart cycle is clean.
const shutdown = (sig: string): void => {
  // eslint-disable-next-line no-console
  console.info(`[server] ${sig} received — stopping room + closing IO`);
  room.stop();
  io.close();
  setTimeout(() => process.exit(0), 100);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
