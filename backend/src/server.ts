import { Hono } from 'hono';

/**
 * Minimal HTTP service: exposes `/health` and a hello-world index.
 * The Socket.IO game traffic runs on its own port (see [`backend/src/index.ts`](backend/src/index.ts))
 * because `@socket.io/bun-engine` 0.0.3 doesn't yet support same-port wiring
 * cleanly. Once the engine matures we can fold both into a single Bun.serve.
 */
export function createServer(): { fetch: (req: Request) => Response | Promise<Response> } {
  const app = new Hono();

  app.get('/', (c) => c.text('flying-tung-tung backend ok'));
  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'flying-tung-tung-backend',
      uptimeSec: Math.round(process.uptime?.() ?? 0),
    })
  );

  return {
    fetch: app.fetch as unknown as (req: Request) => Response | Promise<Response>,
  };
}
