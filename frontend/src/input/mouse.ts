import type { PlayerInput } from '@flying-tung-tung/shared';

/**
 * Wires Pointer-Lock-driven input into the supplied PlayerInput object.
 *
 * Control mapping (see `plans/10_DODGE_AND_DEATH.md`):
 * - **Left mouse held**  → `input.turbo`
 * - **Right mouse click**→ `input.dodgePressed` (edge trigger)
 * - **K key down**       → `input.shootPressed` (edge trigger)
 *
 * Pointer Lock is engaged on click; while locked, only `e.movementX/Y` is
 * accumulated into `input.mouseDelta` and the OS cursor stays trapped at
 * canvas center. Esc releases the lock; clicking re-acquires it.
 *
 * Returns a teardown function for SSR/HMR safety.
 */
export function attachMouse(canvas: HTMLCanvasElement, input: PlayerInput): () => void {
  const onClick = (): void => {
    // Don't try to relock while the death modal is up — the OS cursor needs
    // to remain visible so the player can click "Respawn".
    if (!input.allowLock) return;
    if (document.pointerLockElement !== canvas) {
      const maybe = canvas.requestPointerLock() as unknown;
      if (maybe && typeof (maybe as Promise<void>).then === 'function') {
        (maybe as Promise<void>).catch(() => {
          /* user denied or browser already in transition — silently ignore */
        });
      }
    }
  };

  const onMove = (e: MouseEvent): void => {
    if (document.pointerLockElement !== canvas) return;
    input.mouseDelta.x += e.movementX;
    input.mouseDelta.y += e.movementY;
  };

  // Buttons that browsers map to navigation by default. Always swallowed so
  // the player can't accidentally back/forward out of the game or middle-click
  // to open a new tab while flying.
  const NAV_BUTTONS = new Set([1, 3, 4]); // 1=middle, 3=back, 4=forward

  const onDown = (e: MouseEvent): void => {
    if (NAV_BUTTONS.has(e.button)) e.preventDefault();
    if (document.pointerLockElement !== canvas) return;
    if (e.button === 0) input.turbo = true; // left = turbo (held)
    if (e.button === 2) input.dodgePressed = true; // right = dodge (edge)
  };

  const onUp = (e: MouseEvent): void => {
    if (NAV_BUTTONS.has(e.button)) e.preventDefault();
    if (e.button === 0) input.turbo = false;
  };

  const onAuxClick = (e: MouseEvent): void => {
    // `auxclick` fires for buttons 1, 3, 4 in modern browsers; this is the
    // event that triggers history navigation in Chrome/Edge for back/forward.
    if (NAV_BUTTONS.has(e.button)) e.preventDefault();
  };

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  const onWheel = (e: WheelEvent): void => {
    // Block touchpad two-finger horizontal swipes from triggering page
    // back/forward (Chrome/Safari overscroll navigation).
    if (Math.abs(e.deltaX) > 0) e.preventDefault();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Don't steal keys from typeable elements (search inputs etc.). With our
    // current UI there are none, but be defensive.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (e.repeat) return;
    if (e.key === 'k' || e.key === 'K') {
      input.shootPressed = true;
    }
  };

  const onPointerLockChange = (): void => {
    input.pointerLocked = document.pointerLockElement === canvas;
    if (!input.pointerLocked) {
      // Drop in-flight inputs so the plane doesn't drift while the player
      // is on a menu screen or alt-tabbed.
      input.mouseDelta.x = 0;
      input.mouseDelta.y = 0;
      input.turbo = false;
      input.shootPressed = false;
      input.dodgePressed = false;
    }
  };

  const onPointerLockError = (): void => {
    input.pointerLocked = false;
  };

  const onBlur = (): void => {
    input.mouseDelta.x = 0;
    input.mouseDelta.y = 0;
    input.turbo = false;
    input.shootPressed = false;
    input.dodgePressed = false;
  };

  canvas.addEventListener('click', onClick);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('auxclick', onAuxClick);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', onPointerLockError);
  window.addEventListener('blur', onBlur);

  return () => {
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mousedown', onDown);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('auxclick', onAuxClick);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('pointerlockerror', onPointerLockError);
    window.removeEventListener('blur', onBlur);
  };
}
