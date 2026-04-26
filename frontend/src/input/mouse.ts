import type { PlayerInput } from '@flying-tung-tung/shared';

/**
 * Wires window mouse events into the supplied PlayerInput object.
 * No pointer lock — the cursor is the aim reticle.
 *
 * Returns a teardown function for SSR/HMR safety.
 */
export function attachMouse(input: PlayerInput): () => void {
  const onMove = (e: MouseEvent): void => {
    input.cursorNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
    input.cursorNdc.y = -((e.clientY / window.innerHeight) * 2 - 1);
  };

  const onDown = (e: MouseEvent): void => {
    if (e.button === 0) input.shootPressed = true;
    if (e.button === 2) input.turbo = true;
  };

  const onUp = (e: MouseEvent): void => {
    if (e.button === 2) input.turbo = false;
  };

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  const onBlur = (): void => {
    input.cursorNdc.x = 0;
    input.cursorNdc.y = 0;
    input.turbo = false;
    input.shootPressed = false;
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mousedown', onDown);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('blur', onBlur);
  };
}
