/**
 * Wire-protocol event names + payload shapes for future PvP networking.
 *
 * Today these are unused — the backend ships as a stub. They exist so both
 * sides type-check the *intent* of the protocol and so adding networking
 * later is purely additive.
 */

import type { PlayerState, ProjectileState, Vec3 } from './types';

export const EVENTS = {
  // client -> server
  JOIN: 'player:join',
  INPUT: 'player:input',
  SHOOT: 'player:shoot',
  // server -> client
  WELCOME: 'player:welcome',
  STATE: 'world:state',
  PLAYER_HIT: 'player:hit',
  PLAYER_LEFT: 'player:left',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface JoinPayload {
  name: string;
}

export interface InputPayload {
  /** Server tick (filled by client when sending). */
  tick: number;
  /** Accumulated mouse pixel deltas since the last input frame. */
  mouseDelta: { x: number; y: number };
  turbo: boolean;
}

export interface ShootPayload {
  tick: number;
}

export interface WelcomePayload {
  selfId: string;
  /** Authoritative city seed so all clients render the same map. */
  citySeed: number;
}

export interface WorldStatePayload {
  tick: number;
  players: PlayerState[];
  projectiles: Pick<ProjectileState, 'id' | 'ownerId' | 'position'>[];
}

export interface PlayerHitPayload {
  victimId: string;
  attackerId: string;
  position: Vec3;
}

export interface PlayerLeftPayload {
  id: string;
}
