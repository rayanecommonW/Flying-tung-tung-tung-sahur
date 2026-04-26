# 00 — Overview

## Vision

**Flying Tung Tung** is a browser-based arcade flight game built with Three.js. The player controls a Tung Tung character that flies like a plane over a stylized 3D city. The cursor steers the plane, left-click fires projectiles, and right-click held engages turbo. The feel target is *Pilotwings meets Tiny Wings* with a meme-y character on top.

## MVP scope (this iteration)

The MVP is **single-player only**, runs in a browser, and demonstrates:

1. A Turborepo monorepo with `frontend/`, `backend/` (stub), and `packages/shared/`.
2. A frontend Vite app with a Three.js scene, the Tung Tung GLB loaded and animated as a plane, sky, lighting, fog, and a chase camera.
3. **Cursor-follow flight model:** moving the mouse pitches/yaws the plane toward the cursor; forward speed is constant unless turbo is held.
4. **Shooting:** left-click spawns a projectile from the plane's nose with a small lifetime and trivial collision against ground/buildings.
5. **Turbo:** right-click held multiplies forward speed; releasing returns to normal. The browser context menu is suppressed.
6. A **procedural city** below the plane built from a grid of randomized blocks, populated with **free GLB building props** (Kenney / Quaternius), with roads, ground, skybox/fog.
7. A minimal HUD: crosshair, speed gauge, simple instructions.

## Out of scope (for now)

- Multiplayer / real-time PvP (backend is scaffolded but inert — see [`07_BACKEND_STUB.md`](07_BACKEND_STUB.md)).
- Persistent progression, accounts, leaderboards.
- Advanced physics (no aerodynamics, no stalls).
- Mobile/touch controls.
- Custom-authored buildings/cars/NPCs.

## Success criteria

- `bun install && bun run dev` (or `npm run dev`) at the repo root starts the frontend (and the backend health endpoint).
- The player sees Tung Tung flying over a city, can steer with the mouse, can shoot, can boost.
- 60 FPS on a mid-range laptop with the procedural city + ~hundreds of instanced building props.
- Code is organized so a future networking pass (PvP) only needs to touch a small set of files (state sync layer + `packages/shared` events).

## Glossary

| Term | Meaning |
|------|---------|
| **Plane** | The Tung Tung character treated as a flying entity. |
| **Cursor-follow** | Steering scheme where mouse position relative to viewport center drives pitch and yaw. |
| **Turbo** | Held right-mouse boost that multiplies forward velocity. |
| **City prop** | A pre-made GLB building from a free pack, loaded once and reused via instancing. |
| **Tile / block** | One cell of the procedural city grid; contains 0–N props plus a road border. |
| **Shared package** | `packages/shared` — TS module of types/constants used by both frontend and backend. |
