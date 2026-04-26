# Flying Tung Tung — Plans

This directory contains the design and implementation plan for **Flying Tung Tung**, a Three.js arcade flight game where the player pilots a Tung Tung character (plane-style) over a procedurally generated city, shoots projectiles, and boosts with turbo.

The plans here are *living documents*. They describe what we are building, why, and the order in which to build it. Implementation work will be tracked in the workspace todo list and executed in **Code mode**.

## Document index

| # | File | Purpose |
|---|------|---------|
| 00 | [`00_OVERVIEW.md`](00_OVERVIEW.md) | High-level vision, scope, MVP definition, glossary |
| 01 | [`01_ARCHITECTURE.md`](01_ARCHITECTURE.md) | Turborepo layout, package boundaries, tech choices |
| 02 | [`02_FRONTEND_STRUCTURE.md`](02_FRONTEND_STRUCTURE.md) | Vite + Three.js folder layout, game loop, modules |
| 03 | [`03_PLANE_CONTROLS.md`](03_PLANE_CONTROLS.md) | Cursor-follow flight model, turbo, math reference |
| 04 | [`04_PROJECTILES.md`](04_PROJECTILES.md) | Shooting, pooling, lifetime, collision |
| 05 | [`05_CITY_MAP.md`](05_CITY_MAP.md) | Procedural city + GLB props, ground, skybox, fog |
| 06 | [`06_ASSETS.md`](06_ASSETS.md) | Character GLBs, free city packs, licensing, pipeline |
| 07 | [`07_BACKEND_STUB.md`](07_BACKEND_STUB.md) | Bun + Hono scaffold today, real-time PvP later |
| 08 | [`08_ROADMAP.md`](08_ROADMAP.md) | Ordered milestones from scaffold → MVP → polish → PvP |
| 09 | [`09_INPUT_AND_PARTICLES.md`](09_INPUT_AND_PARTICLES.md) | Pointer-lock input model + GPU particle trail |
| 10 | [`10_DODGE_AND_DEATH.md`](10_DODGE_AND_DEATH.md) | Side-barrel dodge, lives, death/respawn flow |
| ↳ | [`networking/`](networking/00_OVERVIEW.md) | **Multiplayer PvP v1** — protocol, clock sync, server sim, client prediction, interpolation, hit reg, rooms, FE/BE integration. Ten markdown files. |

### Networking sub-index

| # | File | Purpose |
|---|------|---------|
| 00 | [`networking/00_OVERVIEW.md`](networking/00_OVERVIEW.md) | Goals, non-goals, tech choices, key numerical parameters |
| 01 | [`networking/01_PROTOCOL.md`](networking/01_PROTOCOL.md) | Wire protocol: every event, payload, direction, frequency |
| 02 | [`networking/02_CLOCK_SYNC.md`](networking/02_CLOCK_SYNC.md) | NTP-style ping/pong, EMA smoothing, drift resync |
| 03 | [`networking/03_SERVER_SIM.md`](networking/03_SERVER_SIM.md) | Server tick loop, input application, physics, hit detection |
| 04 | [`networking/04_CLIENT_PREDICTION.md`](networking/04_CLIENT_PREDICTION.md) | Local-player prediction + reconciliation thresholds |
| 05 | [`networking/05_INTERPOLATION.md`](networking/05_INTERPOLATION.md) | Remote-player buffered interpolation with Vec3 lerp + Quat slerp |
| 06 | [`networking/06_HIT_REGISTRATION.md`](networking/06_HIT_REGISTRATION.md) | v1 server-current-time sphere checks; lag-comp roadmap |
| 07 | [`networking/07_ROOMS_AND_LIFECYCLE.md`](networking/07_ROOMS_AND_LIFECYCLE.md) | Single global room, join/leave, spawn picker, heartbeat timeout |
| 08 | [`networking/08_FRONTEND_INTEGRATION.md`](networking/08_FRONTEND_INTEGRATION.md) | New `frontend/src/net/` folder + `gameLoop` rewire |
| 09 | [`networking/09_BACKEND_STRUCTURE.md`](networking/09_BACKEND_STRUCTURE.md) | Concrete `backend/src/` file layout (sim/, net/, utils/) |

## Current focus

**Multiplayer PvP v1** — see the networking subfolder. The single-player MVP (Milestones 1–10 in [`08_ROADMAP.md`](08_ROADMAP.md)) is shipped; the next phase is real-time PvP on top, tracked in the new "Phase: Multiplayer" section of the roadmap.

## Source of truth for decisions

Already locked in by the project owner:

- **Stack:** Vite + plain Three.js (TypeScript), imperative game loop.
- **Map:** Hybrid — procedural city block layout populated with free GLB props (Kenney / Quaternius).
- **Controls:** Cursor-follow tilt, constant forward speed, left-click shoots, right-click held = turbo, no pointer lock.
- **Monorepo:** Turborepo with bun workspaces, mirroring `Garama/` (`frontend/`, `backend/`, `packages/shared`).
- **Assets:** Existing `assets/tung-tung.glb` and `assets/angelic-tung-tung.glb` are the player models.
