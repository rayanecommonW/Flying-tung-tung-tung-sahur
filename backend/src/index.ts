import { createServer } from './server';

const port = Number(process.env.PORT ?? 3001);

const { fetch } = createServer();

Bun.serve({
  port,
  fetch,
});

// eslint-disable-next-line no-console
console.info(`[backend] flying-tung-tung listening at http://localhost:${port}`);
// eslint-disable-next-line no-console
console.info(`[backend] health: http://localhost:${port}/health`);
