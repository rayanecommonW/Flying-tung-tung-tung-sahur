import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

import type { SceneLights } from './lights';

export interface SkyHandle {
  sky: Sky;
  /** Color the fog should match for a seamless horizon. */
  horizonColor: THREE.Color;
}

export function addSky(scene: THREE.Scene, lights: SceneLights): SkyHandle {
  const sky = new Sky();
  sky.scale.setScalar(10000);
  scene.add(sky);

  const u = sky.material.uniforms;
  u['turbidity']!.value = 6;
  u['rayleigh']!.value = 1.6;
  u['mieCoefficient']!.value = 0.005;
  u['mieDirectionalG']!.value = 0.78;

  // Match sun position with sky's sun direction.
  const sunDir = lights.sun.position.clone().normalize();
  u['sunPosition']!.value.copy(sunDir);

  // Approximate horizon color for fog tinting.
  const horizonColor = new THREE.Color(0xb8d3ff);

  return { sky, horizonColor };
}
