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
  /** Z-offset of the tail in local space (positive value, used as `-tailOffset`). */
  tailOffset: number;
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

  // Recompute bbox to derive nose/tail offsets along the Z axis.
  const bbox2 = new THREE.Box3().setFromObject(model);
  const noseOffset = bbox2.max.z + 0.5;
  const tailOffset = -bbox2.min.z + 0.2;

  const group = new THREE.Group();
  group.add(model);

  let mixer: THREE.AnimationMixer | null = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(model);
    const clip = gltf.animations[0]!;
    mixer.clipAction(clip).play();
  }

  return { group, model, noseOffset, tailOffset, mixer };
}

// Scratch objects to avoid per-frame allocations.
const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _rollAxis = new THREE.Vector3(0, 0, 1);

/**
 * Apply orientation quaternion + visual roll(s) to the plane group.
 *
 * Composition: orientation × banking roll × dodge roll. Both rolls are
 * visual-only (not stored back into orientation) so they decay/end cleanly
 * without leaving the plane in a tilted heading.
 */
export function applyPose(plane: PlaneEntity, state: PlayerState): void {
  plane.group.position.set(state.position.x, state.position.y, state.position.z);
  _q.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);
  const totalRoll = state.roll + state.dodgeRoll;
  if (totalRoll !== 0) {
    _qRoll.setFromAxisAngle(_rollAxis, totalRoll);
    _q.multiply(_qRoll);
  }
  plane.group.quaternion.copy(_q);
}

const _fwdScratch = new THREE.Quaternion();

/** Compute world-space forward unit vector (local +Z transformed by orientation). */
export function planeForward(state: PlayerState, out = new THREE.Vector3()): THREE.Vector3 {
  _fwdScratch.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);
  out.set(0, 0, 1).applyQuaternion(_fwdScratch);
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

/** Compute world-space tail position (used as the particle emission anchor). */
export function planeTail(plane: PlaneEntity, state: PlayerState, out = new THREE.Vector3()): THREE.Vector3 {
  planeForward(state, out).multiplyScalar(-plane.tailOffset);
  out.x += state.position.x;
  out.y += state.position.y;
  out.z += state.position.z;
  return out;
}
