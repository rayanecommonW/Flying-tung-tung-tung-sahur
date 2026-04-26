# Flying Tung Tung

Browser-based arcade flight game built with **Three.js**. Pilot Tung Tung over a procedurally generated city, shoot projectiles, and engage turbo. Single-player MVP with a multiplayer-ready monorepo for future PvP.

## Stack

- **Frontend** — Vite + TypeScript + Three.js (imperative game loop)
- **Backend** — Bun + Hono + Socket.IO (scaffold only, no real-time gameplay yet)
- **Shared** — TypeScript types/constants/event names consumed by both sides
- **Tooling** — Turborepo + bun workspaces + ESLint + Prettier

## Structure

```
flying-tung-tung/
├── assets/                # Source-of-truth GLBs (tung-tung, angelic-tung-tung)
├── backend/               # Bun + Hono server (PvP-ready stub)
├── frontend/              # Vite + Three.js client (primary deliverable)
├── packages/shared/       # Shared TS types/config
├── plans/                 # Design + implementation plans (read first)
├── package.json           # bun workspaces + turbo scripts
├── turbo.json
├── tsconfig.base.json
├── eslint.config.mjs
└── .prettierrc
```

See [`plans/README.md`](plans/README.md) for the full design index.

## Controls

- **Mouse** — Steer (cursor-follow tilt; no pointer lock)
- **Left click** — Shoot a projectile
- **Right click (held)** — Turbo boost

## Quick start

```bash
# Install everything (root + all workspaces)
bun install

# Run frontend + backend in parallel via Turborepo
bun run dev

# Or just one side
bun run dev:frontend
bun run dev:backend
```

Frontend runs at <http://localhost:5173>. Backend health check at <http://localhost:3001/health>.

## Available scripts

| Script | Purpose |
|--------|---------|
| `bun run dev` | Run all workspaces in dev mode (turbo) |
| `bun run build` | Build all workspaces |
| `bun run lint` | Lint all workspaces |
| `bun run lint:fix` | Lint + autofix |
| `bun run typecheck` | TypeScript noEmit across the monorepo |
| `bun run format` | Prettier write |
| `bun run format:check` | Prettier check |

## Status

Scaffolding & MVP single-player. PvP networking is **deferred** but the repo shape and shared types are ready for it (see [`plans/07_BACKEND_STUB.md`](plans/07_BACKEND_STUB.md)).

## Credits

- Tung Tung character GLBs — see [`assets/`](assets/).
- City props (planned) — Kenney `City Kit` + `Nature Kit` (CC0, https://kenney.nl).
- Three.js — MIT license.
