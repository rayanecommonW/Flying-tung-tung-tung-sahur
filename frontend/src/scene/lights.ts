import * as THREE from 'three';

export interface SceneLights {
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
}

export function addLights(scene: THREE.Scene): SceneLights {
  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0xa6c8ff, 0x4a3a25, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0d0, 1.4);
  sun.position.set(300, 500, 200);
  sun.castShadow = false; // shadows off in MVP for perf
  scene.add(sun);

  return { sun, ambient, hemi };
}
