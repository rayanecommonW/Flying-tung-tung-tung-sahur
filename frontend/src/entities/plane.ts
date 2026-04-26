import * as THREE from 'three';

import { loadGLTF } from '../utils/loaders';
import type { PlayerState } from '@flying-tung-tung/shared';

const PLAYER_LENGTH = 6; // target length in world units after scaling

export interface PlaneEntity {
  /** Top-level group whose transform we manipulate per-frame. */
  group: THREE.Group;
  /** The loaded model, parented to `group` so we can swap skins later. */
  model: THREE.Object3D;
  /** Z-offset of the nose in local space (positive = forward). */
  noseOffset: number;
  /** Animation mixer if the GLB has clips. */
  mixer: THREE.AnimationMixer | null;
}

export async function createPlane(modelUrl: string): Promise<PlaneEntity> {
  const gltf = await loadGLTF(modelUrl);
  const model = gltf.scene;

  // Normalize size.
  const bbox = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const scale = PLAYER_LENGTH / longest;
  model.scale.setScalar(scale);

  // Re-center model so the group origin is the model's centroid.
  const center = new THREE.Vector3();
  bbox.getCenter(center).multiplyScalar(scale);
  model.position.sub(center);

  // Recompute bbox to derive nose offset along +Z.
  const bbox2 = new THREE.Box3().setFromObject(model);
  const noseOffset = bbox2.max.z + 0.5;

  const group = new THREE.Group();
  group.add(model);

  let mixer: THREE.AnimationMixer | null = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(model);
    const clip = gltf.animations[0]!;
    mixer.clipAction(clip).play();
  }

  return { group, model, noseOffset, mixer };
}

/**
 * Apply (position, yaw, pitch, roll) to the plane group.
 * Convention: yaw around Y, then pitch around X, then roll around Z.
 * Local -Z would be "forward" for default Three.js cameras; we use +Z
 * here so positive forward speed pushes the plane in the direction
 * `group.getWorldDirection()` points.
 */
export function applyPose(plane: PlaneEntity, state: PlayerState): void {
  plane.group.position.set(state.position.x, state.position.y, state.position.z);
  plane.group.rotation.set(0, 0, 0);
  plane.group.rotateY(state.yaw);
  plane.group.rotateX(state.pitch);
  plane.group.rotateZ(state.roll);
}

/** Compute world-space forward unit vector (+Z in local). */
export function planeForward(state: PlayerState, out = new THREE.Vector3()): THREE.Vector3 {
  // Same rotation convention as applyPose.
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(state.pitch, state.yaw, state.roll, 'YXZ');
  q.setFromEuler(e);
  out.set(0, 0, 1).applyQuaternion(q);
  return out;
}

/** Compute world-space nose position. */
export function planeNose(plane: PlaneEntity, state: PlayerState, out = new THREE.Vector3()): THREE.Vector3 {
  planeForward(state, out).multiplyScalar(plane.noseOffset);
  out.x += state.position.x;
  out.y += state.position.y;
  out.z += state.position.z;
  return out;
}
