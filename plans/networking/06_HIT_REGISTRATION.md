# Networking — 06 — Hit Registration

The server is authoritative for damage. The client never decides "I shot you" — it sends inputs that include `fire`, the server spawns the projectile, the server integrates it, the server checks it against players, the server emits the resulting hits/deaths in the next snapshot. This document describes how that check works in v1 and what we knowingly defer.

## v1 model: server-current-time, no rewind

For each tick, after projectiles have been integrated and before the snapshot is emitted, the server runs a single-pass check:

```ts
// backend/src/sim/hitDetection.ts
function detectProjectileVsPlayerHits(
  projectiles: Map<number, ServerProjectile>,
  players:     Map<string, ServerPlayer>,
  now:         number,
  events:      EventsBuffer,
): void {
  const r2 = (NET.HIT_RADIUS_PLAYER + NET.HIT_RADIUS_PROJECTILE) ** 2;   // (2.5 + 0.7)² = 10.24

  for (const p of projectiles.values()) {
    if (!p.alive) continue;
    for (const target of players.values()) {
      if (!target.alive) continue;
      if (target.id === p.ownerId) continue;
      if (now < target.immunityUntil) continue;

      const dx = p.position.x - target.position.x;
      const dy = p.position.y - target.position.y;
      const dz = p.position.z - target.position.z;
      if (dx*dx + dy*dy + dz*dz > r2) continue;

      // Hit!
      target.lives        = Math.max(0, target.lives - NET.PROJECTILE_DAMAGE);
      target.hp           = target.lives;
      target.immunityUntil = now + PLAYER.IMMUNITY_SEC * 1000;

      events.hits.push({
        tick: room.tick, victimId: target.id, attackerId: p.ownerId,
        projectileId: p.id, position: { ...p.position },
        livesLeft: target.lives,
      });

      p.alive = false;
      events.despawns.push({
        tick: room.tick, projectileId: p.id, reason: 'hit-player',
        position: { ...p.position },
      });

      if (target.lives === 0) {
        target.alive = false;
        target.pendingRespawnAt = now + DEATH.RESPAWN_DELAY_SEC * 1000;
        events.deaths.push({
          tick: room.tick, victimId: target.id, attackerId: p.ownerId,
          position: { ...target.position },
        });
      }
      break;     // one bullet, one victim
    }
  }
}
```

## Tunables

```ts
NET.HIT_RADIUS_PLAYER        = 2.5;     // > PLANE.COLLIDER_RADIUS (1.8) for forgiveness
NET.HIT_RADIUS_PROJECTILE    = 0.7;     // matches PROJECTILE.RADIUS for visual consistency
NET.PROJECTILE_DAMAGE        = 1;       // 1 hit = 1 life
PLAYER.IMMUNITY_SEC          = 1.0;     // already exists, reused for post-hit grace
```

The combined hit radius (3.2 m) is roughly the plane's visual silhouette. We deliberately err on the *generous* side for the shooter — chasing-and-shooting at 60 m/s with 100 ms latency is hard enough; tight hitboxes would feel unfair. v2 can shrink this once lag-comp is in.

## Why this is "naïve" and what it gets wrong

The server checks `projectile.position` against `target.position` at the **server's current tick**. The shooter, however, fired based on what they saw on their screen — which is `INTERP_DELAY_MS + RTT/2` *behind* the server. So:

1. Shooter A sees player B at world position `(10, 80, 0)`. A aims, A fires.
2. Input arrives at server `~RTT/2 ≈ 50 ms` later. Server spawns projectile at A's nose. By now, B has moved to `(10, 80, 3)` on the server (3 m forward at cruise).
3. Projectile flies toward `(10, 80, 0)` at 220 m/s ≈ 100 m / 450 ms → roughly the position A aimed at, but B is no longer there.
4. Outcome: shots that "felt right" miss. **Lead the target manually.** Standard "low-tech" hit-reg behaviour.

This is what Garama also does (its `attack_release` checks against `now()` server state — see [`combat.ts` line 49](../../../Garama/backend/src/combat.ts:49)). Tight melee with cooldowns hides it well; ranged projectiles expose it more, but for a first iteration on LAN it's playable.

## Trade-offs vs full lag compensation

| Approach | Pros | Cons |
|----------|------|------|
| **v1 (this doc): current-tick** | Trivially correct, can't be exploited via doctored timestamps, no buffers, no rewind. | Shooter must lead targets by RTT-equivalent travel distance. Ranged feels "off" at >50 ms RTT. |
| **Lag-comp via rewind** (v2) | Shots that look like hits on the shooter's screen are hits on the server. Industry-standard for FPS. | Server keeps a 1 s ring buffer of every player's pose; rewinds targets by the firing client's `INTERP_DELAY_MS + RTT/2` before checking. Vulnerable to inflated client timestamps if not bounded. |
| **Hitscan only** (alt) | No projectile travel; instant resolution. | Removes the entire visual identity of "bullets in the air" that the project's already built. |

We're picking v1's simple approach because (a) v1 explicitly targets LAN play where RTT is <10 ms and the lead-error is sub-metre, and (b) all the infrastructure for lag-comp can be added on top of this without restructuring.

## What the client does on a hit

Nothing speculative. When a snapshot lands containing `events.hits[victimId == localPlayer.id]`:

- HUD does a damage flash (driven off the existing `state.immunityUntil` mechanism — when `lives` decreases between snapshots, set `immunityUntil = serverTimeNow() + PLAYER.IMMUNITY_SEC` for visual flicker).
- A small particle burst at `events.hits.position` via the existing [`spawnBurst`](../../frontend/src/game/systems/particleSystem.ts) (`BurstKind.Building` colors are fine for hit puffs in v1).

When the local player **shoots and hits**, they get the burst at the same `events.hits[i].position` (since *both* shooter and victim see the same event). No "kill confirmed" feedback in v1 beyond the bullet vanishing and the target's plane visibly losing a life.

## What we do NOT check in v1

- **Projectile vs city / building.** The server does not know the city geometry yet (see open question in [`03_SERVER_SIM.md`](03_SERVER_SIM.md)). Bullets fly through buildings on the server — but the local client's [`collisionSystem.ts`](../../frontend/src/game/systems/collisionSystem.ts) already despawns bullets that hit buildings *visually*. So locally bullets stop at walls; on the server, they keep going until lifetime or a player hit. **This means a player can shoot through a wall and hit someone on the other side, server-confirmed.** Acceptable for v1; deferred to v2 when the server gets city geometry.
- **Plane vs plane collision.** Two planes ramming each other does no damage. Easy to add later by extending `detectHits` with a sphere-vs-sphere player loop.
- **Projectile vs projectile.** Bullets pass through each other. Not adding.
- **Falloff / damage zones / area effects.** Damage is binary: 1 hit = 1 life off, regardless of distance.

## Anti-cheat surface area (v1)

The only client→server damage-relevant message is `input.fire`. The server controls:

- Cooldown: refuses to spawn a second projectile until `PROJECTILE.COOLDOWN_SEC` after the last one fired by that player.
- Spawn pose: server uses *its* copy of the player's `position` and `orientation`, not anything the client sent. A client cannot fake a bullet from another player's nose.
- Hit window: server uses *its* copy of every player's `position`. A client cannot fake "I shot the guy at this position" because they don't get to specify a position.

The remaining client choices that affect outcomes are:

- *When* to fire (timing). Bots could automate this; v1 has no rate-limit beyond cooldown.
- *Direction* (axes in input). A "smart aim" bot could feed pre-saturated `axes.yaw/pitch` aimed at the closest target. v1 trusts axes; v2 could clamp angular delta per tick (already partly enforced by `MAX_TURN_PER_TICK`).

These are out of scope for v1.

## Future work (post-v1)

1. **Lag-compensated hit registration.** Server keeps a `Map<string, RingBuffer<{tick, position, orientation}>>` of the last 60 ticks (~2 s). When a projectile fired by player A *spawns* (not when it hits), record `A.viewLagMs = NET.INTERP_DELAY_MS + (A.smoothedRttMs / 2)`. On hit-check, look up each candidate target's pose `viewLagMs` ago and use *that* for the sphere test. Requires per-player RTT tracking on the server, which the maintenance pings already provide.
2. **Projectile vs city** server-side. Generate the same `cellLookup` from `WELCOME.citySeed` on the server (port [`world/city.ts`](../../frontend/src/world/city.ts) into shared).
3. **Hitscan weapons** as a separate weapon class.
4. **Damage variance** by hit location (head/body) — needs a real bone hierarchy server-side, not a single sphere. Probably never; this is an arcade game.
5. **Hit confirmation client side** — let the firing client predict-hit when its predicted projectile passes through a remote interpolated target, draw an early flash, then unflash if the server disagrees on the next snapshot. Very flashy, very bug-prone — defer.
