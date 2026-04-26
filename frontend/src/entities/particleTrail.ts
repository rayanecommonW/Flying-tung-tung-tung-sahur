import * as THREE from 'three';
import { PARTICLES } from '@flying-tung-tung/shared';

/**
 * GPU-friendly particle trail backing object.
 *
 * Storage layout
 * --------------
 * - One slot per particle in the pool (PARTICLES.POOL_SIZE).
 * - Per-slot GPU attributes:
 *     position   (vec3)  — current world-space position
 *     aBirth     (float) — sim-time at spawn
 *     aLifetime  (float) — slot's lifetime (so turbo particles can outlive normal ones)
 *     aSize      (float) — base size in pixels
 *     aColor     (vec3)  — base color
 * - Per-slot CPU-only mirrors:
 *     velocities (Float32Array of 3 * POOL_SIZE) — applied each tick
 *     alive      (Uint8Array)   — quick "is this slot live?" lookup for the system
 *
 * Rendering
 * ---------
 * Custom ShaderMaterial that fades alpha as `(now - aBirth) / aLifetime`
 * grows from 0 to 1, plus a soft circular falloff in the fragment shader.
 * Additive blending + depthWrite off → glowing, doesn't clip on translucent
 * geometry. Dead slots are pushed off-screen by setting position to (0, -1e6, 0).
 */
export interface ParticleTrail {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  attributes: {
    position: THREE.BufferAttribute;
    aBirth: THREE.BufferAttribute;
    aLifetime: THREE.BufferAttribute;
    aSize: THREE.BufferAttribute;
    aColor: THREE.BufferAttribute;
  };
  /** CPU-only per-slot velocity (3 floats per slot). */
  velocities: Float32Array;
  /** CPU-only liveness flags (1 byte per slot). */
  alive: Uint8Array;
  /** Uniform reference for the per-frame `uTime` push. */
  uTime: { value: number };
  /** Number of slots in the pool (== PARTICLES.POOL_SIZE). */
  capacity: number;
}

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uPixelScale;

  attribute float aBirth;
  attribute float aLifetime;
  attribute float aSize;
  attribute vec3  aColor;

  varying float vLifeT;
  varying vec3  vColor;

  void main() {
    float age = uTime - aBirth;
    float lifeT = clamp(age / max(aLifetime, 0.0001), 0.0, 1.0);
    vLifeT = lifeT;
    vColor = aColor;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Brief grow-in then steady fade. Depth-attenuated so distant particles
    // shrink, near particles don't blow up. The shader caps gl_PointSize at
    // ~32 px (after dpr) so even a particle right next to the camera stays
    // a small dot rather than a screen-sized splat.
    float grow = mix(0.65, 1.0, smoothstep(0.0, 0.15, lifeT));
    float fade = 1.0 - lifeT;
    float depth = max(-mvPosition.z, 1.0);
    float pixels = aSize * grow * fade * (uPixelScale / depth);
    pixels = min(pixels, 32.0);
    gl_PointSize = pixels * uPixelRatio;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying float vLifeT;
  varying vec3  vColor;

  void main() {
    // Soft circular sprite.
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float disc = smoothstep(0.5, 0.15, d);

    float alpha = disc * (1.0 - vLifeT);
    if (alpha <= 0.0) discard;

    gl_FragColor = vec4(vColor, alpha);
  }
`;

export function createParticleTrail(): ParticleTrail {
  const capacity = PARTICLES.POOL_SIZE;

  const positions = new Float32Array(capacity * 3);
  const births = new Float32Array(capacity);
  const lifetimes = new Float32Array(capacity);
  const sizes = new Float32Array(capacity);
  const colors = new Float32Array(capacity * 3);

  // Park every slot off-screen + already expired so nothing renders before
  // the first emission.
  for (let i = 0; i < capacity; i++) {
    positions[i * 3 + 0] = 0;
    positions[i * 3 + 1] = -1e6;
    positions[i * 3 + 2] = 0;
    births[i] = -1000;
    lifetimes[i] = 0.0001;
    sizes[i] = 0;
    colors[i * 3 + 0] = 1;
    colors[i * 3 + 1] = 1;
    colors[i * 3 + 2] = 1;
  }

  const geometry = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(positions, 3);
  const aBirth = new THREE.BufferAttribute(births, 1);
  const aLifetime = new THREE.BufferAttribute(lifetimes, 1);
  const aSize = new THREE.BufferAttribute(sizes, 1);
  const aColor = new THREE.BufferAttribute(colors, 3);

  aPos.setUsage(THREE.DynamicDrawUsage);
  aBirth.setUsage(THREE.DynamicDrawUsage);
  aLifetime.setUsage(THREE.DynamicDrawUsage);
  aSize.setUsage(THREE.DynamicDrawUsage);
  aColor.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('position', aPos);
  geometry.setAttribute('aBirth', aBirth);
  geometry.setAttribute('aLifetime', aLifetime);
  geometry.setAttribute('aSize', aSize);
  geometry.setAttribute('aColor', aColor);

  // Big bounding sphere so the trail isn't frustum-culled if the camera
  // momentarily looks the other way during sharp maneuvers.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const uTime = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime,
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uPixelScale: { value: PARTICLES.PIXEL_SCALE },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5; // above ground/buildings, below HUD

  return {
    points,
    geometry,
    material,
    attributes: { position: aPos, aBirth, aLifetime, aSize, aColor },
    velocities: new Float32Array(capacity * 3),
    alive: new Uint8Array(capacity),
    uTime,
    capacity,
  };
}
