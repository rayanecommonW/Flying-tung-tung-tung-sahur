/**
 * Manages the `THREE.Group` instances that render remote players. The
 * netSystem owns the *data* (interpolated pose in `state.remotePlayers`);
 * this system owns the *visuals* (`state.remotePlayerVisuals`).
 *
 * On each render frame we:
 *  1. Spawn a visual for any remote player we don't yet have one for.
 *  2. Pose every visual from its data counterpart.
 *  3. Despawn visuals whose data entry was deleted (player left).
 */

import * as THREE from 'three';
import type { GameState, RemotePlayerVisual } from '../gameState';
import { applyRawPose } from '../../entities/plane';
import { createPlane } from '../../entities/plane';

let activeMixers: THREE.AnimationMixer[] = [];

/**
 * Per-render-frame: pose existing remote planes. New planes are added via
 * the `ensureRemotePlane` async path (called from `main.ts` on welcome /
 * playerJoined since GLB load is async).
 *
 * NOTE: animation mixers are advanced separately by `tickRemoteMixers(dt)`
 * during the fixed-timestep update so they receive a real `dt` (in seconds)
 * rather than the render-loop interpolation alpha.
 */
export function renderRemotePlanes(state: GameState): void {
  // 1. Pose existing visuals.
  for (const [id, view] of state.remotePlayers) {
    const visual = state.remotePlayerVisuals.get(id);
    if (!visual) continue;
    visual.group.visible = view.alive;
    if (view.alive) {
      applyRawPose(visual.group, view.position, view.orientation);
    }
  }

  // 2. Drop visuals whose data entry was removed.
  for (const id of [...state.remotePlayerVisuals.keys()]) {
    if (!state.remotePlayers.has(id)) {
      const v = state.remotePlayerVisuals.get(id);
      v?.dispose();
      state.remotePlayerVisuals.delete(id);
    }
  }
}

/**
 * Per-fixed-tick: advance every active remote-plane animation mixer by
 * the supplied `dt` (seconds). Called from the game loop's `update`
 * callback so the dt is consistent (1/60 s), not the render alpha.
 */
export function tickRemoteMixers(dt: number): void {
  for (const m of activeMixers) m.update(dt);
}

/**
 * Async helper to load + parent a plane GLB for a freshly-joined remote
 * player. Cached per-id so repeated calls are no-ops. Mounts under the
 * supplied scene, registers a disposer that detaches + frees animations.
 */
export async function ensureRemotePlane(
  state: GameState,
  scene: THREE.Scene,
  id: string,
  modelUrl = '/models/character/tung-tung.glb'
): Promise<void> {
  if (state.remotePlayerVisuals.has(id)) return;
  if (!state.remotePlayers.has(id)) return;

  const plane = await createPlane(modelUrl);
  scene.add(plane.group);

  // Auto-play any embedded animation clip so remote planes don't appear frozen.
  if (plane.mixer) activeMixers.push(plane.mixer);

  const visual: RemotePlayerVisual = {
    id,
    group: plane.group,
    mixer: plane.mixer,
    model: plane.model,
    dispose: (): void => {
      scene.remove(plane.group);
      if (plane.mixer) {
        activeMixers = activeMixers.filter((m) => m !== plane.mixer);
      }
    },
  };
  state.remotePlayerVisuals.set(id, visual);
}
