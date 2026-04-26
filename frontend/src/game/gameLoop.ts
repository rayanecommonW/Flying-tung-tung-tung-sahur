import { FIXED_DT } from '@flying-tung-tung/shared';

export interface GameLoopOptions {
  update: (dt: number) => void;
  render: (alpha: number) => void;
}

/**
 * Fixed-timestep game loop with a render alpha for interpolation.
 * Returns a stopper.
 */
export function startGameLoop(opts: GameLoopOptions): () => void {
  let last = performance.now();
  let acc = 0;
  let stopped = false;

  const frame = (now: number): void => {
    if (stopped) return;

    // Clamp huge deltas (tab unfocus etc.) so we don't spiral.
    const elapsed = Math.min((now - last) / 1000, 0.25);
    last = now;
    acc += elapsed;

    let safety = 0;
    while (acc >= FIXED_DT && safety < 8) {
      opts.update(FIXED_DT);
      acc -= FIXED_DT;
      safety += 1;
    }

    opts.render(acc / FIXED_DT);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);

  return () => {
    stopped = true;
  };
}
