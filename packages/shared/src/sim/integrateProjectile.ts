/**
 * Pure projectile integrator: position += velocity * dt; ttl -= dt.
 *
 * Consumed by both the server tick loop and (eventually) the client's
 * predicted-projectile path. The caller checks `ttl <= 0` and despawns.
 */

import type { Vec3 } from '../types';

export interface ProjectileSimState {
  position: Vec3;
  velocity: Vec3;
  /** Sim-seconds remaining before lifetime expiry. */
  ttl: number;
}

export function integrateProjectile(p: ProjectileSimState, dt: number): void {
  p.position.x += p.velocity.x * dt;
  p.position.y += p.velocity.y * dt;
  p.position.z += p.velocity.z * dt;
  p.ttl -= dt;
}
