# 02 — Frontend Structure (Vite + Three.js)

## Goals

- Single deterministic game loop with fixed-timestep updates and decoupled rendering.
- Clear separation: **scene setup** (one-shot) vs **systems** (per-tick) vs **entities** (data + mesh).
- Easy to swap local input for networked input later.

## Folder layout

```
frontend/src/
├── main.ts                       # entry: bootstraps app, kicks game loop
├── game/
│   ├── gameLoop.ts               # fixed-timestep accumulator, pause/resume
│   ├── gameState.ts              # the single mutable GameState object
│   ├── config.ts                 # re-export from @flying-tung-tung/shared
│   └── systems/
│       ├── planeController.ts    # cursor-follow steering, turbo
│       ├── projectileSystem.ts   # spawn, advance, expire
│       ├── collisionSystem.ts    # AABB checks vs world
│       └── hudSystem.ts          # updates DOM HUD from state
├── scene/
│   ├── renderer.ts               # WebGLRenderer + resize
│   ├── camera.ts                 # chase camera follow + smoothing
│   ├── lights.ts                 # sun + ambient
│   ├── sky.ts                    # Three.Sky or gradient
│   └── fog.ts
├── entities/
│   ├── plane.ts                  # loads tung-tung.glb, exposes mesh + nose anchor
│   ├── projectile.ts             # pooled mesh + lifetime
│   └── building.ts               # instanced prop wrapper
├── world/
│   ├── city.ts                   # procedural grid generator
│   ├── propLibrary.ts            # loads + caches GLB building props
│   └── ground.ts                 # textured plane
├── input/
│   ├── mouse.ts                  # normalized cursor + button state
│   └── keyboard.ts               # optional debug keys
├── ui/
│   ├── hud.html.ts               # template fragment
│   └── hud.css                   # crosshair, speedometer
├── utils/
│   ├── loaders.ts                # GLTFLoader singleton, draco optional
│   ├── math.ts                   # damping, lerp, smoothstep
│   └── pool.ts                   # generic object pool
└── types.ts                      # frontend-only types
```

## Game loop (fixed timestep)

```ts
// pseudocode
const FIXED_DT = 1 / 60;
let acc = 0;
let last = performance.now();

function frame(now: number) {
  const elapsed = Math.min((now - last) / 1000, 0.25); // clamp pause spikes
  last = now;
  acc += elapsed;
  while (acc >= FIXED_DT) {
    update(FIXED_DT);   // runs all systems on GameState
    acc -= FIXED_DT;
  }
  render(acc / FIXED_DT); // alpha for interpolation if needed
  requestAnimationFrame(frame);
}
```

`update(dt)` runs systems in this order each tick:

1. `mouseSystem` snapshot (latest cursor + button state into `state.input`).
2. `planeController` — apply steering and turbo to `state.player`.
3. `projectileSystem` — advance, age out.
4. `collisionSystem` — projectile vs world.
5. `cameraSystem` — chase the plane.
6. `hudSystem` — push values to DOM (throttled).

## GameState shape

```ts
// packages/shared/src/types.ts (excerpt)
export interface Vec3 { x: number; y: number; z: number; }

export interface PlayerState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;     // radians
  pitch: number;
  roll: number;
  turbo: boolean;
}

export interface ProjectileState {
  id: number;
  position: Vec3;
  velocity: Vec3;
  ageSec: number;
  alive: boolean;
}

export interface PlayerInput {
  cursorNdc: { x: number; y: number };  // -1..1
  shoot: boolean;                        // edge-triggered
  turbo: boolean;                        // held
}
```

`frontend/src/game/gameState.ts` exports a single mutable object with `player`, `projectiles[]`, `input`, `time`. No React, no signals — direct mutation by systems.

## Rendering

- `WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })`.
- One `THREE.Scene`. Buildings live in instanced meshes per-prop-type.
- Chase camera: position lerped behind plane, look-at slightly ahead of plane.
- `THREE.Fog` color matched to sky for distance falloff (also helps hide draw distance).
- Optional: `THREE.PMREMGenerator` for environment IBL on the GLB.

## HUD

A minimal absolutely-positioned DOM overlay (no canvas overlap):

- Center crosshair (CSS pseudo-element).
- Bottom-left: speed in “km/h” (made up units).
- Bottom-right: turbo gauge (cooldown not required for MVP).
- Top-center: small hint “Move mouse to steer · Click to shoot · Right-click to turbo”.

DOM is preferred over `THREE.Sprite` for crisper text and zero z-fight.

## Asset loading flow

1. On boot, `main.ts` shows a loading screen.
2. `propLibrary.preload([...glbUrls])` resolves all GLBs in parallel via a shared `GLTFLoader`.
3. Plane GLB loaded.
4. City generated (synchronous, deterministic with a seed) using preloaded props.
5. Loading screen hides; game loop starts.

## Future PvP hook points

- `state.input` is populated each tick from `input/mouse.ts`. Later, a `net/inputBuffer.ts` will replace this for *remote* players.
- `state.players: Map<id, PlayerState>` will replace single `state.player` (the local player is just `state.players.get(localId)`).
- `entities/plane.ts` already takes `PlayerState` as input — works for remote players too.
