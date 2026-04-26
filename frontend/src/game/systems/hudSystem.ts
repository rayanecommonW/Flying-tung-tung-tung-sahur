import type { GameState } from '../gameState';

interface HudRefs {
  speed: HTMLElement | null;
  turbo: HTMLElement | null;
  hudRoot: HTMLElement | null;
  pointerHint: HTMLElement | null;
  livesContainer: HTMLElement | null;
  lifeNodes: HTMLElement[];
}

let refs: HudRefs | null = null;
let lastUpdateAt = 0;
let lastPointerLocked: boolean | null = null;
let lastLivesRendered = -1;

function ensureRefs(): HudRefs {
  if (!refs) {
    const livesContainer = document.getElementById('hud-lives');
    const lifeNodes = livesContainer
      ? Array.from(livesContainer.querySelectorAll<HTMLElement>('.hud__life'))
      : [];
    refs = {
      speed: document.getElementById('hud-speed'),
      turbo: document.getElementById('hud-turbo'),
      hudRoot: document.getElementById('hud'),
      pointerHint: document.getElementById('pointer-hint'),
      livesContainer,
      lifeNodes,
    };
  }
  return refs;
}

/**
 * Pushes throttled values into the DOM HUD. Throttled to ~10 Hz so we
 * don't churn the layout on every fixed tick. Pointer-hint visibility
 * is updated immediately (no throttle) so it never lags the lock state.
 *
 * The death system (`updateDeathSystem`) owns the respawn modal and may
 * also force-hide the pointer-hint while dead — we only manage the
 * "alive" case here.
 */
export function updateHud(state: GameState): void {
  const r = ensureRefs();

  // Pointer-lock overlay — instant, only writes when state actually flips.
  // Suppressed entirely while the player is dead (the modal takes over).
  if (state.player.dead) {
    if (r.pointerHint) r.pointerHint.classList.add('is-hidden');
    lastPointerLocked = null;
  } else if (lastPointerLocked !== state.input.pointerLocked) {
    lastPointerLocked = state.input.pointerLocked;
    if (r.pointerHint) r.pointerHint.classList.toggle('is-hidden', state.input.pointerLocked);
  }

  // Lives bar — only re-renders DOM when the value actually changes.
  if (lastLivesRendered !== state.player.lives) {
    lastLivesRendered = state.player.lives;
    for (let i = 0; i < r.lifeNodes.length; i++) {
      const node = r.lifeNodes[i]!;
      node.classList.toggle('is-lost', i >= state.player.lives);
    }
  }

  const now = performance.now();
  if (now - lastUpdateAt < 100) return;
  lastUpdateAt = now;

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
