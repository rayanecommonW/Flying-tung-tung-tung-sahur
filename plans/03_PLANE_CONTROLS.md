# 03 — Plane Controls (Cursor-Follow)

## Feel target

The plane has **constant forward velocity** along its own local +Z axis. Moving the mouse offsets the cursor from the screen center; the plane smoothly tilts and turns toward where the cursor points. **No pointer lock.** The cursor is freely visible (it's the aim reticle).

This gives a "Star Fox / Crimson Skies arcade" feel: easy to learn, no stall mechanics, always moving forward.

## Inputs

| Source | Action |
|--------|--------|
| Mouse position | Steering target (cursor follow). |
| Left mouse button (down) | Fire one projectile (edge-triggered). |
| Right mouse button (held) | Turbo on while held. |
| `contextmenu` event | `preventDefault()` so right-click doesn't open menu. |
| `Esc` (optional) | Pause menu (post-MVP). |

## Math

Let `mouseNdc = { x ∈ [-1, 1], y ∈ [-1, 1] }` be the normalized cursor (origin = screen center, +y up).

Define a **target angular velocity** proportional to `mouseNdc`:

```
targetYawRate   = -mouseNdc.x * MAX_YAW_RATE
targetPitchRate =  mouseNdc.y * MAX_PITCH_RATE
```

Apply rate damping toward the target each tick:

```
yawRate   += (targetYawRate   - yawRate)   * (1 - exp(-dt / TAU_YAW))
pitchRate += (targetPitchRate - pitchRate) * (1 - exp(-dt / TAU_PITCH))
```

Integrate orientation:

```
yaw   += yawRate   * dt
pitch += pitchRate * dt
pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH)   // optional safety
```

Roll is a **visual lean** computed from yaw rate (banking into turns):

```
targetRoll = -yawRate / MAX_YAW_RATE * MAX_ROLL
roll      += (targetRoll - roll) * (1 - exp(-dt / TAU_ROLL))
```

Forward velocity:

```
speed     = turboHeld ? CRUISE_SPEED * TURBO_MULT : CRUISE_SPEED
forward   = quaternionFromYawPitch(yaw, pitch) * (0, 0, 1)
position += forward * speed * dt
```

The mesh is set from `(position, yaw, pitch, roll)` after the update.

## Tunables (in `packages/shared/src/config.ts`)

```ts
export const PLANE = {
  CRUISE_SPEED:    60,    // units / sec
  TURBO_MULT:      2.2,
  MAX_YAW_RATE:    1.6,   // rad / sec
  MAX_PITCH_RATE:  1.2,   // rad / sec
  MAX_ROLL:        0.9,   // rad (~52°)
  MAX_PITCH:       1.2,   // rad (~70°)
  TAU_YAW:         0.18,  // sec — smaller = snappier
  TAU_PITCH:       0.20,
  TAU_ROLL:        0.12,
  WORLD_FLOOR_Y:   2,     // never dive below this (clamps + small bounce)
  WORLD_CEIL_Y:    400,
  WORLD_HALF_SIZE: 1500,  // soft wrap or clamp at edges
};
```

All values are intended to be tuned live; they live in `shared` so future server-authoritative simulation matches the client.

## Cursor handling without pointer lock

```ts
window.addEventListener('mousemove', (e) => {
  const x = (e.clientX / window.innerWidth)  * 2 - 1;
  const y = -((e.clientY / window.innerHeight) * 2 - 1);
  state.input.cursorNdc.x = x;
  state.input.cursorNdc.y = y;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousedown', (e) => {
  if (e.button === 0) state.input.shootPressed = true;     // edge
  if (e.button === 2) state.input.turbo = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) state.input.turbo = false;
});
```

A small **dead zone** (e.g. `|ndc| < 0.05 → 0`) prevents jitter when the cursor sits dead-center.

## Camera coupling

Chase camera follows the plane with a slight lag so banking is visible. Optional FOV pump on turbo (`fov: 70 → 82` over 0.2s) gives a strong speed sensation without changing actual physics.

## Boundary behavior (MVP)

- If `position.y < WORLD_FLOOR_Y` → clamp to floor; do not crash (we want forgiving arcade feel).
- If `|position.x|` or `|position.z|` > `WORLD_HALF_SIZE` → clamp and gently rotate yaw back toward origin (auto-turn). A future ribbon/wall visual can be added (see Garama's `mapBorder.ts` for a reference implementation).

## Edge cases

- Window blur: zero out `mouseNdc` and release turbo to prevent a "stuck" plane.
- Mobile / touch: out of scope for MVP; we'll just hide a "desktop only" warning.
- Tab throttling: the fixed-timestep loop already clamps elapsed to 0.25s.
