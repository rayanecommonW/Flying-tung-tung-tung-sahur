# 07 — Backend Stub (PvP-Ready, but Inert)

## Why a stub now?

The owner explicitly asked to **set up Turborepo like Garama's backend, but focus entirely on the frontend**. We therefore scaffold a backend workspace so:

1. `turbo dev` already runs both apps, no migration cost later.
2. The shared package (`packages/shared`) is consumed by both sides today, locking the wire-protocol types in.
3. When PvP arrives, we add files — we don't reshape the repo.

The backend ships **without any gameplay logic**.

## Stack

Mirrors [`Garama/backend`](../../Garama/backend):

- **Bun** runtime.
- **Hono** for HTTP.
- **Socket.IO** (`@socket.io/bun-engine`) for future real-time. *(Imported only — no game handlers yet.)*

## Files

```
backend/
├── package.json          # name: "backend", scripts: dev/start/lint/typecheck
├── tsconfig.json
└── src/
    ├── index.ts          # entry: starts server.ts
    └── server.ts         # Hono app + Socket.IO attach + /health route
```

## Minimum implementation

```ts
// backend/src/server.ts (sketch)
import { Hono } from 'hono';
import { Server } from 'socket.io';
import { BunEngine } from '@socket.io/bun-engine';

export function createServer() {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, service: 'flying-tung-tung-backend' }));

  const io = new Server({ cors: { origin: '*' } });
  // (intentionally no event handlers yet)
  // io.on('connection', socket => { ... LATER ... });

  return { app, io };
}
```

```ts
// backend/src/index.ts (sketch)
import { createServer } from './server';
const { app, io } = createServer();

const port = Number(process.env.PORT ?? 3001);
Bun.serve({ port, fetch: app.fetch });
console.log(`[backend] http://localhost:${port}/health`);
```

## What the frontend does with it (today)

**Nothing.** It does not connect. It does not import socket.io-client. The presence of the backend is purely architectural.

A small dev-only health probe in `frontend/src/main.ts` is OK if useful:

```ts
fetch('http://localhost:3001/health').catch(() => {/* fine, optional */});
```

…but not required for the MVP.

## Shared types ready for PvP

`packages/shared/src/events.ts` will declare the future protocol so both sides type-check today even with empty implementations:

```ts
export const EVENTS = {
  // client -> server
  JOIN:        'player:join',
  INPUT:       'player:input',
  SHOOT:       'player:shoot',
  // server -> client
  STATE:       'world:state',
  PLAYER_HIT:  'player:hit',
  PLAYER_LEFT: 'player:left',
} as const;

export interface JoinPayload   { name: string; }
export interface InputPayload  { tick: number; cursorNdc: { x: number; y: number; }; turbo: boolean; }
export interface ShootPayload  { tick: number; }
export interface WorldState    { tick: number; players: Array<{ id: string; pos: Vec3; yaw: number; pitch: number; roll: number; turbo: boolean; }>; projectiles: Array<{ id: number; pos: Vec3; }>; }
```

These names + shapes are a draft; they can change before any real-time work begins. Their job today is to compile-check the *intent*.

## Future work (not now)

- Authoritative simulation tick (60 Hz) running the same plane/projectile math the client runs (imported from `shared`).
- Client-side prediction + reconciliation.
- Lobby / room management.
- Matchmaking / persistence.

Everything above will live in `backend/src/game/*` and `frontend/src/game/net/*` — no other restructuring needed.
