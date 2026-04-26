/**
 * Process-monotonic id allocator for projectiles. Never reused while the
 * server is alive. At a generous 30 Hz cooldown × 16 players × 12 hours
 * uptime that's ~2.1 M ids — comfortably inside JS's safe-integer range.
 */

let _nextProj = 1;

export function nextProjectileId(): number {
  return _nextProj++;
}
