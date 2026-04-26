/**
 * Small math helpers shared across systems.
 */

export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent damping. Pulls `current` toward `target`
 * with a time constant `tau` (seconds). Smaller tau = snappier.
 */
export function damp(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

/** Apply `damp` to a NDC value but zero out values inside the dead zone. */
export function deadZone(v: number, threshold: number): number {
  if (Math.abs(v) < threshold) return 0;
  // Re-scale so the response stays continuous outside the dead zone.
  const sign = v < 0 ? -1 : 1;
  const t = (Math.abs(v) - threshold) / (1 - threshold);
  return sign * clamp(t, 0, 1);
}
