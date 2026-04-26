import * as THREE from 'three';
import { PROJECTILE } from '@flying-tung-tung/shared';

/**
 * GPU mesh + scratch math for the projectile pool.
 *
 * Two `InstancedMesh` layers per slot:
 *   - `core`: opaque-ish glowing sphere (the "bullet")
 *   - `halo`: bigger additive shell that gives the projectile its glow
 *
 * Both meshes share the same per-slot transform; the projectile system
 * writes to both each tick.
 */
export interface ProjectileMesh {
  core: THREE.InstancedMesh;
  halo: THREE.InstancedMesh;
  scratch: {
    matrix: THREE.Matrix4;
    haloMatrix: THREE.Matrix4;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
    scale: THREE.Vector3;
    haloScale: THREE.Vector3;
    zero: THREE.Vector3;
  };
}

export function createProjectileMesh(): ProjectileMesh {
  // Core bullet — solid bright sphere.
  const coreGeom = new THREE.SphereGeometry(PROJECTILE.RADIUS, 12, 8);
  const coreMat = new THREE.MeshBasicMaterial({
    color: PROJECTILE.COLOR,
    transparent: true,
    opacity: 0.95,
  });
  const core = new THREE.InstancedMesh(coreGeom, coreMat, PROJECTILE.POOL_SIZE);
  core.frustumCulled = false;
  core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Halo — additive glow shell.
  const haloGeom = new THREE.SphereGeometry(PROJECTILE.HALO_RADIUS, 16, 12);
  const haloMat = new THREE.MeshBasicMaterial({
    color: PROJECTILE.HALO_COLOR,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.InstancedMesh(haloGeom, haloMat, PROJECTILE.POOL_SIZE);
  halo.frustumCulled = false;
  halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  halo.renderOrder = 4;

  // Initialize all slots scaled to zero (invisible) on both layers.
  const m = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < PROJECTILE.POOL_SIZE; i++) {
    core.setMatrixAt(i, m);
    halo.setMatrixAt(i, m);
  }
  core.instanceMatrix.needsUpdate = true;
  halo.instanceMatrix.needsUpdate = true;

  return {
    core,
    halo,
    scratch: {
      matrix: new THREE.Matrix4(),
      haloMatrix: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      haloScale: new THREE.Vector3(1, 1, 1),
      zero: new THREE.Vector3(),
    },
  };
}
