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
import {
  renderRemoteProjectiles,
  updateProjectileSystem,
} from './game/systems/projectileSystem';
import { updateCollisionSystem } from './game/systems/collisionSystem';
import { updatePlayerCollisionSystem } from './game/systems/playerCollisionSystem';
import { updateDeathSystem } from './game/systems/deathSystem';
import { updateCameraSystem } from './game/systems/cameraSystem';
import { updateParticleSystem } from './game/systems/particleSystem';
import { updateNetEventsSystem } from './game/systems/netEventsSystem';
import {
  ensureRemotePlane,
  renderRemotePlanes,
  tickRemoteMixers,
} from './game/systems/remotePlanesSystem';
import { hideLoading, setLoadingMessage, updateHud } from './game/systems/hudSystem';
import { startNetSystem, netUpdate, netRender } from './net/netSystem';

/** Default Socket.IO server URL — see `backend/src/index.ts` for the port split. */
const DEFAULT_SERVER_URL = `http://${window.location.hostname || 'localhost'}:3101`;

function timeoutAfter<T>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
}

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

  // ===== State + input =====
  const state = createGameState();
  attachMouse(canvas, state.input);

  // ===== Pilot name + connect =====
  setLoadingMessage('Pick a pilot name…');
  const promptedName = window.prompt('Pilot name?', 'Tung') ?? 'Tung';
  const pilotName = promptedName.slice(0, 24).trim() || 'Tung';

  setLoadingMessage(`Connecting as ${pilotName}…`);
  const serverUrl = (() => {
    const fromQs = new URLSearchParams(window.location.search).get('server');
    return fromQs ?? DEFAULT_SERVER_URL;
  })();

  const netSys = startNetSystem(state, {
    serverUrl,
    playerName: pilotName,
    onKicked: (msg) => setLoadingMessage(`Kicked: ${msg.reason} — ${msg.message}`),
    onDisconnected: (reason) => {
      // Surface a soft notice; we don't auto-reconnect in v1.
      console.warn('[main] disconnected:', reason);
    },
  });

  let online = false;
  try {
    await Promise.race([netSys.ready, timeoutAfter<unknown>(10000, 'Welcome')]);
    online = true;
    state.isNetworked = true;
    console.info('[main] networked play enabled');
  } catch (err) {
    console.warn('[main] connection failed — falling back to single-player:', err);
    setLoadingMessage('Server unreachable — flying offline.');
    netSys.shutdown();
    state.isNetworked = false;
  }

  // ===== Asset preload =====
  setLoadingMessage('Loading city props…');
  const lib = await preloadPropLibrary((msg) => setLoadingMessage(msg));

  setLoadingMessage('Loading character…');
  const plane = await createPlane('/models/character/tung-tung.glb');
  scene.add(plane.group);

  setLoadingMessage('Generating city…');
  // Server's authoritative seed is propagated through `state.citySeed`. The
  // current `buildCity` reads `CITY.SEED` directly so for v1 we rely on the
  // backend using the same constant; per-room seeds is future work.
  const city = buildCity(scene, lib);

  // ===== Projectiles =====
  const pmesh = createProjectileMesh();
  scene.add(pmesh.core);
  scene.add(pmesh.halo);

  // ===== Particle trail =====
  const trail = createParticleTrail();
  scene.add(trail.points);

  // ===== Remote-plane visuals (network mode) =====
  if (online) {
    // Spawn visuals for everyone already in the room when we joined.
    for (const id of state.remotePlayers.keys()) {
      void ensureRemotePlane(state, scene, id);
    }
    // Subsequent joins are pushed by netSystem callbacks — re-attach here.
    netSys.socket.onPlayerJoined((msg) => {
      void ensureRemotePlane(state, scene, msg.player.id);
    });
  }

  // ===== Loop =====
  hideLoading();
  startGameLoop({
    update: (dt) => {
      state.time += dt;
      updatePlaneController(state, dt);

      if (state.isNetworked) {
        // Server-authoritative path: drain events, send input, render
        // remote bullets directly from netState. Local projectile spawn
        // is suppressed — `state.input.shootPressed` is consumed by
        // `netUpdate` instead.
        updateNetEventsSystem(state, trail);
        netUpdate(state, netSys);
        // Advance remote-plane animation mixers with a real dt so their
        // wing flaps etc. don't jitter on the render-loop alpha.
        tickRemoteMixers(dt);
      } else {
        updateProjectileSystem(state, plane, pmesh, trail, dt);
        updateCollisionSystem(state, city, trail);
      }

      // Player-vs-building collision runs in BOTH modes. The server
      // currently has no city geometry (see `backend/src/sim/room.ts`),
      // so the client owns building damage in v1. The reconcile path in
      // `prediction.ts` is intentionally min-clamped on `lives` so it
      // can't undo a client-side hit on the next snapshot.
      updatePlayerCollisionSystem(state, city, trail);

      updateDeathSystem(state, plane, canvas);
      updateCameraSystem(camera, state, dt);
      updateParticleSystem(state, plane, trail, dt);
      if (!state.player.dead) applyPose(plane, state.player);
      if (plane.mixer && !state.player.dead) plane.mixer.update(dt);

      // Flicker the local plane mesh during post-hit / post-respawn immunity.
      if (!state.player.dead) {
        const immune = state.time < state.immunityUntil;
        plane.group.visible = !immune || Math.floor(state.time * 14) % 2 === 0;
      }

      updateHud(state);
    },
    render: (alpha) => {
      if (state.isNetworked) {
        netRender(state, netSys);
        renderRemoteProjectiles(state, pmesh);
        renderRemotePlanes(state);
      }
      // `alpha` is the inter-tick render fraction; currently unused by
      // the renderer itself but kept for future smoothed visuals.
      void alpha;
      renderer.render(scene, camera);
    },
  });
}

bootstrap().catch((err) => {
  console.error('[boot] failed', err);
  setLoadingMessage('Failed to start: ' + (err instanceof Error ? err.message : String(err)));
});
