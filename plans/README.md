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

## Current focus

**Frontend MVP only.** The backend is scaffolded so the monorepo shape matches [`Garama/`](../../Garama/), but no real-time gameplay is implemented yet. PvP is explicitly deferred (see [`07_BACKEND_STUB.md`](07_BACKEND_STUB.md)).

## Source of truth for decisions

Already locked in by the project owner:

- **Stack:** Vite + plain Three.js (TypeScript), imperative game loop.
- **Map:** Hybrid — procedural city block layout populated with free GLB props (Kenney / Quaternius).
- **Controls:** Cursor-follow tilt, constant forward speed, left-click shoots, right-click held = turbo, no pointer lock.
- **Monorepo:** Turborepo with bun workspaces, mirroring `Garama/` (`frontend/`, `backend/`, `packages/shared`).
- **Assets:** Existing `assets/tung-tung.glb` and `assets/angelic-tung-tung.glb` are the player models.
