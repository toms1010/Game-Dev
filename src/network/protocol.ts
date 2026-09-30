/**
 * Neon Vanguard — wire protocol.
 *
 * One schema, shared by `src/network/client.ts` and the C++ server in
 * `server/src/network/`. Any change here must be made there too, and the
 * `PROTOCOL_VERSION` bumped.
 *
 * Format
 * ------
 * JSON with single-letter keys, sized for a mobile radio rather than for
 * readability. Entities are flat numeric arrays instead of objects, which
 * removes every key from the payload — a 12-entity snapshot is roughly a
 * third of the bytes of the equivalent object form.
 *
 * The encoder is deliberately separated from the transport so the binary
 * protocol (a later step) can reuse the same `pack`/`unpack` layout: the
 * numeric arrays below map one-to-one onto a packed binary layout with no
 * reshaping of the game logic.
 *
 * Trust model
 * -----------
 * The client may only send *intent* (`INPUT`, `ABILITY`). It never sends
 * positions, damage, health, kills or score; the server derives all of those.
 * See `server/src/security/ServerValidator.cpp`.
 */

import type { Vec } from '../game/entities';

export const PROTOCOL_VERSION = 1;

/** Fixed simulation rate the server runs at. The client mirrors it. */
export const SERVER_TICK_RATE = 60;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;

export type MatchMode = 'arena' | 'coop';
export type AbilityKind = 'dash' | 'bomb';

/** Connection lifecycle, surfaced verbatim in the UI status pill. */
export type NetStatus =
  | 'offline'      // never connected / deliberately disabled
  | 'connecting'   // socket opening or handshaking
  | 'authenticating'
  | 'connected'    // in a match
  | 'reconnecting' // lost, backing off
  | 'error';       // rejected by the server

// ---------------------------------------------------------------------------
// Entity wire records
// ---------------------------------------------------------------------------

/** Bit flags packed into the trailing element of a player record. */
export const PF_FIRING = 1 << 0;
export const PF_DASHING = 1 << 1;
export const PF_DEAD = 1 << 2;

/** Enemy archetype ids. Must match `ENEMY_KINDS` in the server. */
export const ENEMY_KINDS = ['grunt', 'rusher', 'tank', 'shooter', 'splitter', 'healer', 'boss'] as const;
export type EnemyKindId = (typeof ENEMY_KINDS)[number];

/** `[id, kindId, x, y, r, hp, angle]` */
export type EnemyWire = [number, number, number, number, number, number, number];
/** `[id, x, y, vx, vy, angle, hp, maxHp, flags]` */
export type PlayerWire = [number, number, number, number, number, number, number, number, number];

export interface NetPlayer {
  id: number;
  /** Carried by the join roster, not by per-tick snapshots. */
  name?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  maxHp: number;
  flags: number;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface ConnectMsg { t: 'CONNECT'; v: number; client: 'web' | 'android' | 'ios'; device: string }
export interface AuthMsg { t: 'AUTH'; name: string; token?: string }
export interface JoinMsg { t: 'JOIN'; mode: MatchMode }
export interface LeaveMsg { t: 'LEAVE' }

/**
 * One input sample. Sent at `INPUT_RATE` Hz, and each packet repeats the
 * previous two samples so a single dropped datagram does not desync input.
 * `s` is a monotonic sequence number the server echoes back in snapshots.
 */
export interface InputMsg {
  t: 'INPUT';
  s: number;
  c: number;               // client monotonic tick counter
  mx: number; my: number;  // resolved movement vector, already normalised
  ax: number; ay: number;  // aim point in world space
  f: 0 | 1;                // trigger held
}

export interface AbilityMsg { t: 'ABILITY'; s: number; k: AbilityKind }
export interface PingMsg { t: 'PING'; i: number; c: number }
export interface ResyncMsg { t: 'RESYNC'; since: number }

export type ClientMsg =
  | ConnectMsg | AuthMsg | JoinMsg | LeaveMsg
  | InputMsg | AbilityMsg | PingMsg | ResyncMsg;

export interface WelcomeMsg {
  t: 'WELCOME';
  id: number;              // assigned player id
  tick: number;            // current server tick
  rate: number;            // tick rate (hz)
  aw: number; ah: number;  // arena size in world units
}
export interface AuthOkMsg { t: 'AUTH_OK'; id: number; name: string }
export interface JoinedMsg { t: 'JOINED'; match: string; roster: { id: number; name: string }[]; mode: MatchMode }

/** One authoritative simulation frame. */
export interface SnapshotMsg {
  t: 'SNAP';
  k: number;               // server tick
  a: number;               // last input sequence the server consumed
  p: PlayerWire[];         // every player, local included
  e: EnemyWire[];          // the shared enemy field
}

export type GameEventKind = 'hit' | 'death' | 'spawn' | 'wave' | 'match_end' | 'achievement';
export interface EventMsg {
  t: 'EV';
  e: GameEventKind;
  /** Subject of the event (player or enemy id). */
  id?: number;
  /** Kind-specific numeric payload (damage, wave number, score, ...). */
  v?: number;
}

export interface PongMsg { t: 'PONG'; i: number; c: number; k: number }
export interface ErrorMsg { t: 'ERR'; code: number; m: string }

export type ServerMsg =
  | WelcomeMsg | AuthOkMsg | JoinedMsg | SnapshotMsg | EventMsg | PongMsg | ErrorMsg;

// ---------------------------------------------------------------------------
// Quantisation
// ---------------------------------------------------------------------------

/**
 * Positions are sent to 0.1 world units (a 960-wide arena means 3 significant
 * figures is far finer than the 14-unit ship radius) and angles to 3 decimal
 * places. Velocities keep one decimal. This is a deliberate accuracy/bytes
 * trade and is the main lever on snapshot size.
 */
const q1 = (v: number) => Math.round(v * 10) / 10;
const q2 = (v: number) => Math.round(v * 100) / 100;
const q3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function encodePlayer(p: NetPlayer): PlayerWire {
  return [
    p.id,
    q1(p.x), q1(p.y),
    q1(p.vx), q1(p.vy),
    q3(p.angle),
    Math.round(p.hp),
    Math.round(p.maxHp),
    p.flags | 0,
  ];
}

export function decodePlayer(w: PlayerWire): NetPlayer {
  return {
    id: w[0], x: w[1], y: w[2], vx: w[3], vy: w[4], angle: w[5],
    hp: w[6], maxHp: w[7], flags: w[8],
  };
}

export function encodeEnemy(
  id: number, kind: EnemyKindId, x: number, y: number, r: number, hp: number, angle: number,
): EnemyWire {
  return [id, ENEMY_KINDS.indexOf(kind), q1(x), q1(y), q1(r), Math.round(hp), q3(angle)];
}

export function decodeEnemy(w: EnemyWire) {
  return {
    id: w[0],
    kind: ENEMY_KINDS[w[1]] ?? 'grunt',
    x: w[2], y: w[3], r: w[4], hp: w[5], angle: w[6],
  };
}

/**
 * One snapshot is at most a few hundred bytes, so it is sent as a single
 * JSON frame rather than a batch. The caller's send budget lives in
 * `client.ts` — this function is pure and has no transport knowledge.
 */
export function encodeSnapshot(msg: SnapshotMsg): string {
  return JSON.stringify(msg);
}

export function decodeMessage(raw: string): ServerMsg | null {
  try {
    const parsed = JSON.parse(raw) as ServerMsg;
    return parsed && typeof parsed === 'object' && 't' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** Client-side input frame. Kept in one place so the shape cannot drift. */
export function encodeInput(
  seq: number, clientTick: number,
  move: Vec, aim: Vec, firing: boolean,
): InputMsg {
  return {
    t: 'INPUT',
    s: seq,
    c: clientTick,
    mx: q2(move.x), my: q2(move.y),
    ax: q1(aim.x), ay: q1(aim.y),
    f: firing ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Reconnection / drift helpers
// ---------------------------------------------------------------------------

/**
 * Exponential backoff for reconnection attempts: 1s, 2s, 4s, 8s, 16s, then
 * held at the ceiling. `attempt` is 1-based.
 */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CEILING_MS = 30_000;
export function backoffDelay(attempt: number): number {
  if (attempt <= 1) return BACKOFF_BASE_MS;
  const d = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(BACKOFF_CEILING_MS, d);
}

/**
 * Rounds the server's input acknowledgement forward to the newest unacked
 * sample, so reconciliation replays only what is genuinely outstanding.
 */
export function reconciliationWindow(ack: number, latest: number, maxReplay = 120): number {
  return Math.max(0, Math.min(latest - ack, maxReplay));
}
