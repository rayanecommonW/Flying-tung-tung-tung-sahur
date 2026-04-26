/**
 * Throw-away Bun smoke-test client. Connects to the running server, says
 * hello, sends a few inputs, prints the first snapshot, then disconnects.
 * Run with: `bun backend/test-client.ts`
 */

import { io as ioClient } from 'socket.io-client';
import { EVENTS, PROTOCOL_VERSION } from '@flying-tung-tung/shared';
import type {
  HelloPayload,
  InputPayload,
  PingPayload,
  PongPayload,
  SnapshotPayload,
  WelcomePayload,
} from '@flying-tung-tung/shared';

const url = process.env.SERVER_URL ?? 'http://localhost:3101';

const sock = ioClient(url, { transports: ['websocket'], reconnection: false, timeout: 4000 });

let snapshots = 0;
let myId: string | null = null;
let nextSeq = 1;

const startedAt = performance.now();

sock.on('connect', () => {
  console.log(`[test] connected id=${sock.id}`);
  const hello: HelloPayload = { name: 'TestBot', protocolVersion: PROTOCOL_VERSION, clientTimeMs: performance.now() };
  sock.emit(EVENTS.HELLO, hello);
});

sock.on(EVENTS.WELCOME, (msg: WelcomePayload) => {
  myId = msg.playerId;
  console.log(`[test] welcome: id=${msg.playerId} tick=${msg.serverTick} others=${msg.others.length} citySeed=${msg.citySeed} spawn=`, msg.spawn);

  // Burst 5 pings.
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      const ping: PingPayload = { clientSendTimeMs: performance.now() };
      sock.emit(EVENTS.PING, ping);
    }, i * 200);
  }

  // Send 6 inputs over 200 ms.
  for (let i = 0; i < 6; i++) {
    setTimeout(() => {
      const inp: InputPayload = {
        seq: nextSeq++,
        dt: 1 / 30,
        clientTimeMs: performance.now(),
        axes: { pitch: 0, yaw: 0, roll: 0, throttle: 1 },
        turbo: false,
        fire: i === 5, // fire on the last one
        dodge: false,
      };
      sock.emit(EVENTS.INPUT, inp);
    }, i * 33);
  }
});

sock.on(EVENTS.PONG, (msg: PongPayload) => {
  const rtt = performance.now() - msg.clientSendTimeMs;
  console.log(`[test] pong: rtt=${rtt.toFixed(1)}ms serverTime=${msg.serverTimeMs.toFixed(0)}`);
});

sock.on(EVENTS.SNAPSHOT, (msg: SnapshotPayload) => {
  snapshots++;
  if (snapshots <= 3) {
    const me = msg.players.find((p) => p.id === myId);
    console.log(
      `[test] snapshot #${snapshots} tick=${msg.tick} players=${msg.players.length} projectiles=${msg.projectiles.length}` +
        (me ? ` self pos=(${me.position.x.toFixed(1)},${me.position.y.toFixed(1)},${me.position.z.toFixed(1)}) lives=${me.lives}` : '')
    );
    if (msg.events.spawns.length) console.log('  spawns:', msg.events.spawns);
    if (msg.events.hits.length) console.log('  hits:', msg.events.hits);
  }
});

sock.on('disconnect', (reason) => {
  console.log(`[test] disconnected: ${reason}`);
});

setTimeout(() => {
  const elapsed = performance.now() - startedAt;
  console.log(`[test] done — saw ${snapshots} snapshots in ${elapsed.toFixed(0)}ms`);
  sock.disconnect();
  process.exit(0);
}, 2500);
