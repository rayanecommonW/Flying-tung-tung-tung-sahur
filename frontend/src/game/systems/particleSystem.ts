import * as THREE from 'three';
import { PARTICLES } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import type { PlaneEntity } from '../../entities/plane';
import { planeForward, planeTail } from '../../entities/plane';
import type { ParticleTrail } from '../../entities/particleTrail';

// Scratch math objects.
const _tail = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _scatter = new THREE.Vector3();

// Cool/normal palette — pale blue-white smoke.
const COLOR_NORMAL = new THREE.Color(0x9fd6ff);
// Hot/turbo palette — warm orange flame.
const COLOR_TURBO = new THREE.Color(0xff7a2d);

// Pre-built impact-burst color objects so we don't allocate at hit time.
const COLOR_BURST_BUILDING = new THREE.Color(PARTICLES.BURST_COLOR_BUILDING);
const COLOR_BURST_GROUND = new THREE.Color(PARTICLES.BURST_COLOR_GROUND);
const COLOR_BURST_PLAYER_DEATH = new THREE.Color(PARTICLES.BURST_COLOR_PLAYER_DEATH);

export const BurstKind = {
  Building: 'building',
  Ground: 'ground',
  PlayerDeath: 'player-death',
} as const;
export type BurstKind = (typeof BurstKind)[keyof typeof BurstKind];

interface BurstProfile {
  count: number;
  speed: number;
  lifetime: number;
  size: number;
  color: THREE.Color;
  /** If true, velocity Y is biased upward so the puff floats. */
  upward: boolean;
}

function getBurstProfile(kind: BurstKind): BurstProfile {
  switch (kind) {
    case BurstKind.Building:
      return {
        count: PARTICLES.BURST_BUILDING_COUNT,
        speed: PARTICLES.BURST_SPEED,
        lifetime: PARTICLES.BURST_LIFETIME,
        size: PARTICLES.BURST_SIZE,
        color: COLOR_BURST_BUILDING,
        upward: false,
      };
    case BurstKind.Ground:
      return {
        count: PARTICLES.BURST_GROUND_COUNT,
        speed: PARTICLES.BURST_SPEED,
        lifetime: PARTICLES.BURST_LIFETIME,
        size: PARTICLES.BURST_SIZE,
        color: COLOR_BURST_GROUND,
        upward: true,
      };
    case BurstKind.PlayerDeath:
    default:
      return {
        count: PARTICLES.BURST_PLAYER_DEATH_COUNT,
        speed: PARTICLES.BURST_PLAYER_DEATH_SPEED,
        lifetime: PARTICLES.BURST_PLAYER_DEATH_LIFETIME,
        size: PARTICLES.BURST_PLAYER_DEATH_SIZE,
        color: COLOR_BURST_PLAYER_DEATH,
        upward: false,
      };
  }
}

/**
 * Per-tick particle emitter + advancer.
 *
 * Emission
 * --------
 * Burns a fractional budget so emit rate is exact even when (rate * dt) < 1.
 * Rate, lifetime, size, and color all swap based on `state.player.turbo`,
 * giving an obvious visual punch when the player holds right-click.
 *
 * Update
 * ------
 * For each live slot: position += velocity * dt; if age >= lifetime → kill
 * (park position far below the world). Updates GPU attributes only when the
 * data they hold actually changed this tick to keep upload cost minimal.
 */
export function updateParticleSystem(
  state: GameState,
  plane: PlaneEntity,
  trail: ParticleTrail,
  dt: number
): void {
  trail.uTime.value = state.time;

  // === 1. Compute emission count for this tick ===
  const emitRate = state.player.turbo ? PARTICLES.EMIT_RATE_TURBO : PARTICLES.EMIT_RATE_NORMAL;
  state.particleBudget += emitRate * dt;
  // Only emit while the user is actually playing (pointer locked).
  // This stops the trail from blasting out particles while they're
  // looking at the "Click to play" overlay.
  if (!state.input.pointerLocked) {
    state.particleBudget = 0;
  }
  let emitCount = Math.floor(state.particleBudget);
  state.particleBudget -= emitCount;

  // === 2. Get the spawn anchor + plane forward ===
  planeTail(plane, state.player, _tail);
  planeForward(state.player, _fwd);

  const positions = trail.attributes.position.array as Float32Array;
  const births = trail.attributes.aBirth.array as Float32Array;
  const lifetimes = trail.attributes.aLifetime.array as Float32Array;
  const sizes = trail.attributes.aSize.array as Float32Array;
  const colors = trail.attributes.aColor.array as Float32Array;
  const velocities = trail.velocities;
  const alive = trail.alive;

  let posDirty = false;
  let attrDirty = false; // birth/lifetime/size/color all change at spawn time

  // === 3. Spawn new trail particles in dead slots ===
  if (emitCount > 0) {
    const lifetime = state.player.turbo ? PARTICLES.LIFETIME_TURBO : PARTICLES.LIFETIME_NORMAL;
    const baseSize = state.player.turbo ? PARTICLES.SIZE_TURBO : PARTICLES.SIZE_NORMAL;
    const color = state.player.turbo ? COLOR_TURBO : COLOR_NORMAL;
    let scanStart = (state.time * 1000) | 0;

    for (let n = 0; n < emitCount; n++) {
      const slot = findDeadSlot(alive, trail.capacity, scanStart);
      if (slot < 0) break;
      scanStart = slot + 1;

      // Position: at the tail with a tiny perpendicular jitter.
      const jx = (Math.random() - 0.5) * 0.4;
      const jy = (Math.random() - 0.5) * 0.4;
      const jz = (Math.random() - 0.5) * 0.4;
      positions[slot * 3 + 0] = _tail.x + jx;
      positions[slot * 3 + 1] = _tail.y + jy;
      positions[slot * 3 + 2] = _tail.z + jz;

      // Velocity: backward (opposite of forward) + uniform-sphere scatter.
      _scatter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      const sl = _scatter.length() || 1;
      _scatter.multiplyScalar(PARTICLES.SCATTER_SPEED / sl);
      _vel.copy(_fwd).multiplyScalar(-PARTICLES.BACKWARD_SPEED).add(_scatter);
      velocities[slot * 3 + 0] = _vel.x;
      velocities[slot * 3 + 1] = _vel.y;
      velocities[slot * 3 + 2] = _vel.z;

      // Per-slot attributes for the shader.
      births[slot] = state.time;
      lifetimes[slot] = lifetime * (0.85 + Math.random() * 0.3);
      sizes[slot] = baseSize * (0.8 + Math.random() * 0.4);
      colors[slot * 3 + 0] = color.r;
      colors[slot * 3 + 1] = color.g;
      colors[slot * 3 + 2] = color.b;

      alive[slot] = 1;
      posDirty = true;
      attrDirty = true;
    }
  }

  // === 4. Advance live particles + retire expired ones ===
  const now = state.time;
  for (let i = 0; i < trail.capacity; i++) {
    if (alive[i] === 0) continue;
    const birth = births[i] as number;
    const lifetime = lifetimes[i] as number;
    const age = now - birth;
    if (age >= lifetime) {
      alive[i] = 0;
      // Park off-screen so even if a leftover frame reads it, it draws nothing.
      positions[i * 3 + 1] = -1e6;
      posDirty = true;
      continue;
    }
    const vx = velocities[i * 3 + 0] as number;
    const vy = velocities[i * 3 + 1] as number;
    const vz = velocities[i * 3 + 2] as number;
    positions[i * 3 + 0] = (positions[i * 3 + 0] as number) + vx * dt;
    positions[i * 3 + 1] = (positions[i * 3 + 1] as number) + vy * dt;
    positions[i * 3 + 2] = (positions[i * 3 + 2] as number) + vz * dt;
    posDirty = true;
  }

  // === 5. Flag the dirty GPU attributes ===
  if (posDirty) trail.attributes.position.needsUpdate = true;
  if (attrDirty) {
    trail.attributes.aBirth.needsUpdate = true;
    trail.attributes.aLifetime.needsUpdate = true;
    trail.attributes.aSize.needsUpdate = true;
    trail.attributes.aColor.needsUpdate = true;
  }
}

/**
 * Spawn a radial burst at `position` — used by the projectile + collision
 * systems for impact effects. Writes directly into `trail`'s particle
 * pool and flags the relevant GPU attributes dirty.
 *
 * The burst kind picks the count, color, and a tiny lifetime/size variation
 * so building hits read distinctly from ground hits.
 */
export function spawnBurst(
  trail: ParticleTrail,
  position: THREE.Vector3,
  kind: BurstKind,
  time: number
): void {
  const profile = getBurstProfile(kind);

  const positions = trail.attributes.position.array as Float32Array;
  const births = trail.attributes.aBirth.array as Float32Array;
  const lifetimes = trail.attributes.aLifetime.array as Float32Array;
  const sizes = trail.attributes.aSize.array as Float32Array;
  const colors = trail.attributes.aColor.array as Float32Array;
  const velocities = trail.velocities;
  const alive = trail.alive;

  let scanStart = (time * 1000) | 0;
  let spawned = 0;

  for (let n = 0; n < profile.count; n++) {
    const slot = findDeadSlot(alive, trail.capacity, scanStart);
    if (slot < 0) break; // pool exhausted — drop the rest of the burst
    scanStart = slot + 1;

    positions[slot * 3 + 0] = position.x;
    positions[slot * 3 + 1] = position.y;
    positions[slot * 3 + 2] = position.z;

    // Uniform-sphere outward velocity, optionally biased upward (ground/dust).
    let dxv = Math.random() - 0.5;
    let dyv = Math.random() - 0.5;
    let dzv = Math.random() - 0.5;
    const len = Math.sqrt(dxv * dxv + dyv * dyv + dzv * dzv) || 1;
    dxv /= len;
    dyv /= len;
    dzv /= len;
    if (profile.upward) dyv = Math.abs(dyv) * 0.8 + 0.4;

    const speed = profile.speed * (0.7 + Math.random() * 0.6);
    velocities[slot * 3 + 0] = dxv * speed;
    velocities[slot * 3 + 1] = dyv * speed;
    velocities[slot * 3 + 2] = dzv * speed;

    births[slot] = time;
    lifetimes[slot] = profile.lifetime * (0.8 + Math.random() * 0.4);
    sizes[slot] = profile.size * (0.75 + Math.random() * 0.5);
    colors[slot * 3 + 0] = profile.color.r;
    colors[slot * 3 + 1] = profile.color.g;
    colors[slot * 3 + 2] = profile.color.b;

    alive[slot] = 1;
    spawned++;
  }

  if (spawned > 0) {
    trail.attributes.position.needsUpdate = true;
    trail.attributes.aBirth.needsUpdate = true;
    trail.attributes.aLifetime.needsUpdate = true;
    trail.attributes.aSize.needsUpdate = true;
    trail.attributes.aColor.needsUpdate = true;
  }
}

/** Find the next dead slot starting from `scanStart`, or -1 if none free. */
function findDeadSlot(alive: Uint8Array, capacity: number, scanStart: number): number {
  for (let i = 0; i < capacity; i++) {
    const idx = (scanStart + i) % capacity;
    if (alive[idx] === 0) return idx;
  }
  return -1;
}
