import * as THREE from 'three';
import { CAMERA } from '@flying-tung-tung/shared';

export function createCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    CAMERA.FOV_NORMAL,
    window.innerWidth / window.innerHeight,
    0.1,
    5000
  );
  camera.position.set(0, 30, 30);
  camera.lookAt(0, 0, 0);
  return camera;
}
