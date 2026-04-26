import * as THREE from 'three';

import { createCamera } from './scene/camera';
import { addLights } from './scene/lights';
import { addSky } from './scene/sky';
import { attachResize, createRenderer } from './scene/renderer';
import { addGround } from './world/ground';
import { buildCity } from './world/city';
import { preloadPropLibrary } from './world/propLibrary';
import { createPlane, applyPose } from './entities/plane';
import { createProjectileMesh } from './entities/projectile';
import { createParticleTrail } from './entities/particleTrail';
import { attachMouse } from './input/mouse';
import { createGameState } from './game/gameState';
import { startGameLoop } from './game/gameLoop';
import { updatePlaneController } from './game/systems/planeController';
import { updateProjectileSystem } from './game/systems/projectileSystem';
import { updateCollisionSystem } from './game/systems/collisionSystem';
import { updatePlayerCollisionSystem } from './game/systems/playerCollisionSystem';
import { updateDeathSystem } from './game/systems/deathSystem';
import { updateCameraSystem } from './game/systems/cameraSystem';
import { updateParticleSystem } from './game/systems/particleSystem';
import { hideLoading, setLoadingMessage, updateHud } from './game/systems/hudSystem';

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#game-canvas not found');

  // ===== Renderer + scene + camera =====
  const renderer = createRenderer(canvas);
  const scene = new THREE.Scene();
  const camera = createCamera();
  attachResize(renderer, camera);

  // ===== Environment =====
  const lights = addLights(scene);
  const sky = addSky(scene, lights);
  scene.fog = new THREE.FogExp2(sky.horizonColor.getHex(), 0.0008);
  scene.background = sky.horizonColor;
  addGround(scene);

  // ===== Asset preload =====
  setLoadingMessage('Loading city props…');
  const lib = await preloadPropLibrary((msg) => setLoadingMessage(msg));

  setLoadingMessage('Loading character…');
  const plane = await createPlane('/models/character/tung-tung.glb');
  scene.add(plane.group);

  setLoadingMessage('Generating city…');
  const city = buildCity(scene, lib);

  // ===== Projectiles =====
  const pmesh = createProjectileMesh();
  scene.add(pmesh.core);
  scene.add(pmesh.halo);

  // ===== Particle trail (also used as the impact-burst pool) =====
  const trail = createParticleTrail();
  scene.add(trail.points);

  // ===== State + input =====
  const state = createGameState();
  attachMouse(canvas, state.input);

  // ===== Loop =====
  hideLoading();
  startGameLoop({
    update: (dt) => {
      state.time += dt;
      updatePlaneController(state, dt);
      updateProjectileSystem(state, plane, pmesh, trail, dt);
      updateCollisionSystem(state, city, trail);
      updatePlayerCollisionSystem(state, city, trail);
      updateDeathSystem(state, plane, canvas);
      updateCameraSystem(camera, state, dt);
      updateParticleSystem(state, plane, trail, dt);
      if (!state.player.dead) applyPose(plane, state.player);
      if (plane.mixer && !state.player.dead) plane.mixer.update(dt);
      // Flicker the plane mesh during post-hit / post-respawn immunity.
      if (!state.player.dead) {
        const immune = state.time < state.immunityUntil;
        plane.group.visible = !immune || Math.floor(state.time * 14) % 2 === 0;
      }
      updateHud(state);
    },
    render: () => {
      renderer.render(scene, camera);
    },
  });
}

bootstrap().catch((err) => {
  console.error('[boot] failed', err);
  setLoadingMessage('Failed to start: ' + (err instanceof Error ? err.message : String(err)));
});
