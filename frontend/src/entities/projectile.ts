import * as THREE from 'three';
import { PROJECTILE } from '@flying-tung-tung/shared';

export interface ProjectileMesh {
  mesh: THREE.InstancedMesh;
  /** Re-usable Matrix4 / scratch math objects to avoid allocation. */
  scratch: {
    matrix: THREE.Matrix4;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
    scale: THREE.Vector3;
    zero: THREE.Vector3;
  };
}

export function createProjectileMesh(): ProjectileMesh {
  const geom = new THREE.SphereGeometry(PROJECTILE.RADIUS, 8, 6);
  const mat = new THREE.MeshBasicMaterial({
    color: PROJECTILE.COLOR,
    transparent: true,
    opacity: 0.95,
  });
  const mesh = new THREE.InstancedMesh(geom, mat, PROJECTILE.POOL_SIZE);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Initialize all instances to scale 0 (invisible).
  const m = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < PROJECTILE.POOL_SIZE; i++) {
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;

  return {
    mesh,
    scratch: {
      matrix: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      zero: new THREE.Vector3(),
    },
  };
}
