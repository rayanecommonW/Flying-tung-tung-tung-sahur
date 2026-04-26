/**
 * Pure quaternion + vec3 math for the shared sim layer. Conventions match
 * three.js: a quaternion is `{x,y,z,w}` with `w` scalar; multiplication is
 * Hamilton product `out = a * b` (right-multiply), and rotating a vector
 * `v` by `q` is `q * v * q^-1` resolved into the closed-form below.
 *
 * Stays framework-free so the same math runs on the Bun server (no three.js
 * dep) and the browser client (where THREE.Quaternion does the same thing).
 */

import type { Vec3, Vec4 } from '../types';

/** In-place: normalize the quaternion. Returns it. */
export function quatNormalize(q: Vec4): Vec4 {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len === 0) {
    q.x = 0;
    q.y = 0;
    q.z = 0;
    q.w = 1;
  } else {
    q.x /= len;
    q.y /= len;
    q.z /= len;
    q.w /= len;
  }
  return q;
}

/**
 * In-place right-multiply: `out = out * b`. Matches `THREE.Quaternion.multiply`.
 * Uses scratch locals so it's safe to pass `out === b`.
 */
export function quatMul(out: Vec4, b: Vec4): Vec4 {
  const ax = out.x;
  const ay = out.y;
  const az = out.z;
  const aw = out.w;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  const bw = b.w;
  out.x = ax * bw + aw * bx + ay * bz - az * by;
  out.y = ay * bw + aw * by + az * bx - ax * bz;
  out.z = az * bw + aw * bz + ax * by - ay * bx;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * Build a quaternion from an axis (must be unit-length) and an angle (radians).
 * Writes into `out` and returns it.
 */
export function quatFromAxisAngle(out: Vec4, ax: number, ay: number, az: number, angle: number): Vec4 {
  const half = angle * 0.5;
  const s = Math.sin(half);
  out.x = ax * s;
  out.y = ay * s;
  out.z = az * s;
  out.w = Math.cos(half);
  return out;
}

/**
 * Rotate vector `v` by quaternion `q`. Closed-form (no temporary quaternion):
 *   v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
 * Writes into `out` and returns it.
 */
export function quatRotateVec(out: Vec3, q: Vec4, vx: number, vy: number, vz: number): Vec3 {
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + qw * t + cross(q.xyz, t)
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * In-place spherical linear interpolation: `out = slerp(a, b, t)`. `t` clamps
 * to [0, 1]. Picks the shorter arc by negating one quaternion when their dot
 * is negative.
 */
export function quatSlerp(out: Vec4, a: Vec4, b: Vec4, t: number): Vec4 {
  if (t <= 0) {
    out.x = a.x;
    out.y = a.y;
    out.z = a.z;
    out.w = a.w;
    return out;
  }
  if (t >= 1) {
    out.x = b.x;
    out.y = b.y;
    out.z = b.z;
    out.w = b.w;
    return out;
  }

  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;

  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  // Linear fallback when very close: avoids 1/sin(0) blow-up.
  if (dot > 0.9995) {
    out.x = a.x + (bx - a.x) * t;
    out.y = a.y + (by - a.y) * t;
    out.z = a.z + (bz - a.z) * t;
    out.w = a.w + (bw - a.w) * t;
    return quatNormalize(out);
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  out.x = a.x * wa + bx * wb;
  out.y = a.y * wa + by * wb;
  out.z = a.z * wa + bz * wb;
  out.w = a.w * wa + bw * wb;
  return out;
}

// =============================================================================
// Vec3 helpers
// =============================================================================

export function vec3Lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function vec3Copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function vec3SqDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function quatCopy(out: Vec4, a: Vec4): Vec4 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  out.w = a.w;
  return out;
}

/** Get a unit forward vector (local +Z transformed by `q`). */
export function quatForward(out: Vec3, q: Vec4): Vec3 {
  return quatRotateVec(out, q, 0, 0, 1);
}

/** Get a unit right vector (local +X transformed by `q`). */
export function quatRight(out: Vec3, q: Vec4): Vec3 {
  return quatRotateVec(out, q, 1, 0, 0);
}
