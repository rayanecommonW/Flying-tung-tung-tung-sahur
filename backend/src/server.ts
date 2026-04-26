import { Hono } from 'hono';
import { Server } from 'socket.io';

/**
 * Backend server scaffold for Flying Tung Tung.
 *
 * This is intentionally minimal — only a /health route is wired up.
 * The Socket.IO server is constructed but no event handlers are attached,
 * so it simply waits to be plugged in once we begin real-time PvP work.
 *
 * See plans/07_BACKEND_STUB.md for the migration plan.
 */
export function createServer(): { fetch: (req: Request) => Response | Promise<Response>; io: Server } {
  const app = new Hono();

  app.get('/', (c) => c.text('flying-tung-tung backend ok'));
  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'flying-tung-tung-backend',
      uptimeSec: Math.round(process.uptime?.() ?? 0),
    })
  );

  // Socket.IO instance ready for future PvP. Intentionally no listeners.
  const io = new Server({
    cors: { origin: '*' },
  });

  return {
    fetch: app.fetch as unknown as (req: Request) => Response | Promise<Response>,
    io,
  };
}
