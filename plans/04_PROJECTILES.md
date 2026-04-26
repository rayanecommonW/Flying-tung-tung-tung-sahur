# 04 — Projectiles

## Goal

Left-click spawns a single projectile from the plane's nose. Projectile flies straight along the plane's forward vector at spawn time, has a short lifetime, and despawns on hit or timeout.

## Data

```ts
interface Projectile {
  id: number;
  position: Vec3;
  velocity: Vec3;       // set once at spawn; no curving in MVP
  ageSec: number;
  alive: boolean;
  meshIndex: number;    // index into the InstancedMesh
}
```

State lives in `gameState.projectiles: Projectile[]` (a fixed-size pool, e.g. 256).

## Tunables (`shared/src/config.ts`)

```ts
export const PROJECTILE = {
  POOL_SIZE:     256,
  SPEED:         200,    // units/sec; > plane cruise
  LIFETIME_SEC:  2.5,
  COOLDOWN_SEC:  0.12,   // anti-spam
  RADIUS:        0.3,    // collision sphere
  COLOR:         0xfff09a,
};
```

## Spawning

When `state.input.shootPressed` and `now - state.lastShotAt > COOLDOWN_SEC`:

1. Find the first `!alive` slot in the pool.
2. Compute the **nose anchor** of the plane (offset along local +Z by ~plane length / 2 + a small forward bias).
3. Set `position = noseWorldPos`, `velocity = forward * SPEED`.
4. `alive = true`, `ageSec = 0`.
5. Update the corresponding instance matrix in the projectile `InstancedMesh`.
6. Reset `state.input.shootPressed = false` (edge consumed).
7. (Optional) play `pew.mp3`.

## Per-tick update

```ts
for (const p of state.projectiles) {
  if (!p.alive) continue;
  p.ageSec += dt;
  if (p.ageSec >= PROJECTILE.LIFETIME_SEC) {
    despawn(p);
    continue;
  }
  p.position.x += p.velocity.x * dt;
  p.position.y += p.velocity.y * dt;
  p.position.z += p.velocity.z * dt;
  // collision check (below)
}
// after loop: write all instance matrices, mark .instanceMatrix.needsUpdate = true
```

## Rendering with `InstancedMesh`

One `THREE.InstancedMesh(geom, mat, POOL_SIZE)` is created at startup. Each pool slot maps 1:1 to an instance index. Despawned projectiles get their matrix scaled to `0` (cheaper than reorganizing). The mesh has `frustumCulled = false` because the instances move every frame.

Geometry: `SphereGeometry(0.3, 8, 6)` with `MeshBasicMaterial` (additive blending optional) — no lighting cost.

## Collision (MVP)

Simple, no spatial structure yet:

1. **Ground**: `if (p.position.y <= 0) despawn`.
2. **Buildings**: each building footprint is an AABB stored in the city manager (`world/city.ts`). For each live projectile, test against the AABB list. Early-out by city cell index (we know which grid cell the projectile is in from `floor(p.position.x / CELL)`).

```ts
function aabbContains(p: Vec3, b: Box3): boolean {
  return p.x >= b.min.x && p.x <= b.max.x &&
         p.y >= b.min.y && p.y <= b.max.y &&
         p.z >= b.min.z && p.z <= b.max.z;
}
```

3. On hit: despawn projectile, spawn a tiny visual puff (a short-lived expanding sphere) — purely cosmetic in MVP.

Future improvements (not in MVP):

- BVH / spatial grid for collision once building counts grow.
- Damage model + destructible blocks.
- Hit registration on remote players (server-authoritative).

## Pool sizing rationale

At `COOLDOWN_SEC = 0.12` and `LIFETIME_SEC = 2.5`, max in-flight ≈ `2.5 / 0.12 ≈ 21`. Pool of 256 gives huge headroom for future weapons and remote players' shots.

## Hooks for PvP later

- `Projectile` already has an `id`. When networking, ids will be authoritative from the server; the client will reconcile.
- Spawn function will be split into `spawnLocalProjectile` (predicts) and `applyServerProjectile` (corrects). The data shape doesn't change.
