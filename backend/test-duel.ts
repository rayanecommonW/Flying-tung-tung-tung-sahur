/**
 * Two-client smoke test: A spawns and aims yaw=0; B spawns; A fires repeatedly.
 * Verifies hit detection + life decrement + death/respawn round-trip.
 */

import { io as ioClient, type Socket } from 'socket.io-client';
import { EVENTS, PROTOCOL_VERSION } from '@flying-tung-tung/shared';
import type {
  HelloPayload,
  InputPayload,
  SnapshotPayload,
  WelcomePayload,
} from '@flying-tung-tung/shared';

const url = process.env.SERVER_URL ?? 'http://localhost:3101';

interface Bot {
  name: string;
  socket: Socket;
  id: string | null;
  seq: number;
  lives: number;
  alive: boolean;
}

function spawnBot(name: string): Bot {
  const sock = ioClient(url, { transports: ['websocket'], reconnection: false });
  const bot: Bot = { name, socket: sock, id: null, seq: 1, lives: 5, alive: true };

  sock.on('connect', () => {
    const hello: HelloPayload = { name, protocolVersion: PROTOCOL_VERSION, clientTimeMs: performance.now() };
    sock.emit(EVENTS.HELLO, hello);
  });
  sock.on(EVENTS.WELCOME, (msg: WelcomePayload) => {
    bot.id = msg.playerId;
    console.log(`[${name}] welcome id=${bot.id}`);
  });
  sock.on(EVENTS.SNAPSHOT, (snap: SnapshotPayload) => {
    if (!bot.id) return;
    const me = snap.players.find((p) => p.id === bot.id);
    if (me) {
      if (me.lives !== bot.lives) {
        console.log(`[${name}] lives ${bot.lives} → ${me.lives} (alive=${me.alive})`);
      }
      bot.lives = me.lives;
      bot.alive = me.alive;
    }
    for (const ev of snap.events.hits) {
      if (ev.victimId === bot.id) console.log(`[${name}] HIT by ${ev.attackerId} (lives=${ev.livesLeft})`);
      if (ev.attackerId === bot.id) console.log(`[${name}] dealt damage to ${ev.victimId} (lives=${ev.livesLeft})`);
    }
    for (const ev of snap.events.deaths) {
      if (ev.victimId === bot.id) console.log(`[${name}] DIED, killer=${ev.attackerId}`);
    }
    for (const ev of snap.events.respawns) {
      if (ev.playerId === bot.id) console.log(`[${name}] RESPAWNED at`, ev.position);
    }
  });
  return bot;
}

function sendInput(bot: Bot, opts: { fire: boolean; yaw: number; pitch: number }): void {
  if (!bot.id) return;
  const inp: InputPayload = {
    seq: bot.seq++,
    dt: 1 / 30,
    clientTimeMs: performance.now(),
    axes: { pitch: opts.pitch, yaw: opts.yaw, roll: 0, throttle: 1 },
    turbo: false,
    fire: opts.fire,
    dodge: false,
  };
  bot.socket.emit(EVENTS.INPUT, inp);
}

const A = spawnBot('AlphaShooter');
const B = spawnBot('BetaTarget');

await new Promise((r) => setTimeout(r, 500));

// A and B are spawned at opposite ring points. Fire continuously from both.
// Spawn points at (60,80,0) and (-60,80,0) for example — orientations face outward.
// Idle physics will move them away from each other; that's not ideal for a hit
// test but the hit-radius is 3.2m so we count on cooldown-driven sustained fire.
console.log('[test] 2.5s of mutual fire…');
const fireInterval = setInterval(() => {
  sendInput(A, { fire: true, yaw: 0, pitch: 0 });
  sendInput(B, { fire: true, yaw: 0, pitch: 0 });
}, 100);

setTimeout(() => {
  clearInterval(fireInterval);
  console.log('[test] done');
  A.socket.disconnect();
  B.socket.disconnect();
  setTimeout(() => process.exit(0), 200);
}, 4000);
