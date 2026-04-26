import type { GameState } from '../gameState';

interface HudRefs {
  speed: HTMLElement | null;
  turbo: HTMLElement | null;
  hudRoot: HTMLElement | null;
}

let refs: HudRefs | null = null;
let lastUpdateAt = 0;

function ensureRefs(): HudRefs {
  if (!refs) {
    refs = {
      speed: document.getElementById('hud-speed'),
      turbo: document.getElementById('hud-turbo'),
      hudRoot: document.getElementById('hud'),
    };
  }
  return refs;
}

/**
 * Pushes throttled values into the DOM HUD. Throttled to ~10 Hz so we
 * don't churn the layout on every fixed tick.
 */
export function updateHud(state: GameState): void {
  const now = performance.now();
  if (now - lastUpdateAt < 100) return;
  lastUpdateAt = now;

  const r = ensureRefs();
  const v = state.player.velocity;
  const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

  if (r.speed) r.speed.textContent = String(Math.round(speed));
  if (r.turbo) r.turbo.textContent = state.player.turbo ? 'ON' : 'OFF';
  if (r.hudRoot) r.hudRoot.classList.toggle('turbo-active', state.player.turbo);
}

export function hideLoading(): void {
  const el = document.getElementById('loading');
  if (el) el.classList.add('is-hidden');
}

export function setLoadingMessage(msg: string): void {
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = msg;
}
