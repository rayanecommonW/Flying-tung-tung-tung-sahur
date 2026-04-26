import { DEATH } from '@flying-tung-tung/shared';

import type { GameState } from '../gameState';
import { resetForRespawn } from '../gameState';
import type { PlaneEntity } from '../../entities/plane';

interface DeathRefs {
  modal: HTMLElement | null;
  button: HTMLButtonElement | null;
  pointerHint: HTMLElement | null;
}

let refs: DeathRefs | null = null;
let respawnRequested = false;
let lastModalShown = false;
let lastDead = false;
let buttonHandlerAttached = false;

function ensureRefs(): DeathRefs {
  if (!refs) {
    refs = {
      modal: document.getElementById('respawn-modal'),
      button: document.getElementById('respawn-btn') as HTMLButtonElement | null,
      pointerHint: document.getElementById('pointer-hint'),
    };
  }
  return refs;
}

/**
 * Wire the respawn button. The click handler runs in a *user-gesture*
 * context, so we use it to immediately request pointer lock on the canvas
 * — that means clicking "Respawn" puts the player straight back into play
 * without an extra click.
 */
function ensureButtonHandler(canvas: HTMLCanvasElement, state: GameState): void {
  if (buttonHandlerAttached) return;
  const r = ensureRefs();
  if (!r.button) return;
  r.button.addEventListener('click', () => {
    respawnRequested = true;
    // We want pointer lock back. Since this click is a user gesture we can
    // request it synchronously.
    state.input.allowLock = true;
    if (document.pointerLockElement !== canvas) {
      const maybe = canvas.requestPointerLock() as unknown;
      if (maybe && typeof (maybe as Promise<void>).then === 'function') {
        (maybe as Promise<void>).catch(() => {
          /* user denied or browser blocked it — fall back to the click-to-play overlay */
        });
      }
    }
  });
  buttonHandlerAttached = true;
}

/**
 * Death + respawn lifecycle. Driven once per fixed tick from the game loop.
 *
 * - Hides the plane group while dead.
 * - When the player flips from alive → dead, exits pointer lock and sets
 *   `input.allowLock = false` so canvas clicks no longer recapture (the
 *   modal needs the OS cursor).
 * - Toggles `#respawn-modal` after `DEATH.RESPAWN_DELAY_SEC`.
 * - On a respawn click, `resetForRespawn(state)` restores lives, position,
 *   orientation, and re-shows the model.
 */
export function updateDeathSystem(
  state: GameState,
  plane: PlaneEntity,
  canvas: HTMLCanvasElement
): void {
  ensureButtonHandler(canvas, state);
  const r = ensureRefs();

  // Detect alive → dead transition: release pointer lock so the modal is clickable.
  if (state.player.dead && !lastDead) {
    state.input.allowLock = false;
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
    }
  }
  lastDead = state.player.dead;

  // Plane visibility tracks alive state.
  plane.group.visible = !state.player.dead;

  // Respawn click consumed?
  if (respawnRequested) {
    respawnRequested = false;
    if (state.player.dead) {
      resetForRespawn(state);
      plane.group.visible = true;
    }
  }

  const dead = state.player.dead;
  const elapsed = dead ? state.time - state.deathTime : 0;
  const showModal = dead && elapsed >= DEATH.RESPAWN_DELAY_SEC;

  if (showModal !== lastModalShown) {
    lastModalShown = showModal;
    if (r.modal) r.modal.classList.toggle('is-hidden', !showModal);
  }

  // The modal owns the screen while dead — keep the click-to-play hint hidden.
  if (dead && r.pointerHint) {
    r.pointerHint.classList.add('is-hidden');
  }
}
