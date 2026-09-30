/**
 * Neon Vanguard — snapshot buffering and entity interpolation.
 *
 * Remote entities are rendered at a fixed delay behind the newest snapshot
 * (default 100 ms). That costs a little latency and buys immunity to jitter:
 * two snapshots either side of the render time are always available, so a
 * late or reordered packet shows up as a slightly different path instead of a
 * visible stutter. When the buffer starves, positions extrapolate briefly
 * from the last known velocity before freezing — a dead stop is far more
 * noticeable than a short overshoot.
 *
 * The output array is reused between frames: interpolation must not allocate,
 * because it runs once per frame for every remote entity.
 */

import type { RemotePlayer } from '../game/entities';
import type { EnemyWire, PlayerWire } from './protocol';

export interface InterpolatorConfig {
  /** How far behind the newest snapshot to render, in ms. */
  delayMs: number;
  /** Cap on forward extrapolation when the buffer is empty, in ms. */
  maxExtrapolationMs: number;
  /** Snapshots retained; 2 is the minimum for interpolation. */
  historySize: number;
  /** Smooth an angle across the ±π wrap instead of spinning the long way. */
  shortestAngle: boolean;
}

export const DEFAULT_INTERPOLATION: InterpolatorConfig = {
  delayMs: 100,
  maxExtrapolationMs: 250,
  historySize: 32,
  shortestAngle: true,
};

/** One authoritative frame, with the wall-clock time it landed. */
export interface BufferedSnapshot {
  tick: number;
  /** Local receive time (performance.now) — the interpolation clock. */
  receivedAt: number;
  players: PlayerWire[];
  enemies: EnemyWire[];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpolates two angles along the shortest arc. */
function lerpAngle(a: number, b: number, t: number, shortest: boolean): number {
  if (!shortest) return lerp(a, b, t);
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * A ring buffer of recent snapshots plus the sampled view of the world at a
 * chosen render time.
 */
export class SnapshotBuffer {
  private cfg: InterpolatorConfig;
  private buf: BufferedSnapshot[] = [];
  /** Monotonic id → object, so ids keep their identity across frames. */
  private remoteIndex = new Map<number, RemotePlayer>();
  /** Scratch output, reused to keep the hot path allocation free. */
  private outPlayers: RemotePlayer[] = [];
  private outEnemies: { id: number; kind: string; x: number; y: number; r: number; hp: number; angle: number }[] = [];

  constructor(cfg: Partial<InterpolatorConfig> = {}) {
    this.cfg = { ...DEFAULT_INTERPOLATION, ...cfg };
  }

  get config(): InterpolatorConfig { return this.cfg; }

  setDelay(ms: number): void {
    this.cfg = { ...this.cfg, delayMs: Math.max(0, ms) };
  }

  get length(): number { return this.buf.length; }

  /** Newest tick held, or 0 when empty. */
  get latestTick(): number { return this.buf.length ? this.buf[this.buf.length - 1]!.tick : 0; }

  push(snap: BufferedSnapshot): void {
    // Out-of-order arrivals are dropped: a late snapshot is already
    // superseded, and letting it in would rewind the render clock.
    if (this.buf.length && snap.tick <= this.latestTick) return;
    this.buf.push(snap);
    while (this.buf.length > this.cfg.historySize) this.buf.shift();
  }

  clear(): void {
    this.buf.length = 0;
    this.remoteIndex.clear();
  }

  /**
   * Samples the world at `now - delayMs`.
   *
   * @param localId player id to omit (the local player is predicted, not
   *   interpolated)
   */
  sample(now: number, localId: number): void {
    const target = now - this.cfg.delayMs;
    this.outPlayers.length = 0;
    this.outEnemies.length = 0;
    if (this.buf.length === 0) {
      this.reapRemote();
      return;
    }

    const newest = this.buf[this.buf.length - 1]!;
    if (this.buf.length === 1 || target >= newest.receivedAt) {
      // Starved: extrapolate the single newest frame forward, but only for a
      // bounded time, then hold still.
      const ahead = Math.min(target - newest.receivedAt, this.cfg.maxExtrapolationMs);
      this.emit(newest, newest, ahead / 1000, localId);
      this.reapRemote();
      return;
    }

    // Find the bracketing pair.
    let older = this.buf[0]!;
    let newer = newest;
    for (let i = this.buf.length - 1; i > 0; i--) {
      const b = this.buf[i]!;
      const a = this.buf[i - 1]!;
      if (a.receivedAt <= target && target <= b.receivedAt) { older = a; newer = b; break; }
    }
    const span = newer.receivedAt - older.receivedAt;
    const t = span > 0 ? (target - older.receivedAt) / span : 0;
    this.emit(older, newer, t, localId);
    this.reapRemote();
  }

  /** Interpolates (or extrapolates) one bracketed pair into the output. */
  private emit(older: BufferedSnapshot, newer: BufferedSnapshot, t: number, localId: number): void {
    const byId = new Map<number, PlayerWire>();
    for (const w of older.players) byId.set(w[0], w);

    for (const b of newer.players) {
      if (b[0] === localId) continue;
      const a = byId.get(b[0]);
      if (!a) {
        // First sighting: no history, so show the authoritative position.
        this.touch(b[0], b[1], b[2], b[5], b[6], b[7]);
        continue;
      }
      this.touch(
        b[0],
        lerp(a[1], b[1], t),
        lerp(a[2], b[2], t),
        lerpAngle(a[5], b[5], t, this.cfg.shortestAngle),
        b[6], b[7],
      );
    }

    const seenEnemies = new Set<number>();
    const eById = new Map<number, EnemyWire>();
    for (const w of older.enemies) eById.set(w[0], w);
    for (const b of newer.enemies) {
      seenEnemies.add(b[0]);
      const a = eById.get(b[0]);
      if (!a) {
        this.outEnemies.push({ id: b[0], kind: '', x: b[2], y: b[3], r: b[4], hp: b[5], angle: b[6] });
        continue;
      }
      this.outEnemies.push({
        id: b[0], kind: '',
        x: lerp(a[2], b[2], t),
        y: lerp(a[3], b[3], t),
        r: b[4],
        hp: b[5],
        angle: lerpAngle(a[6], b[6], t, this.cfg.shortestAngle),
      });
    }
  }

  /**
   * Updates the stable object for `id` in place. Keeping one object per player
   * (rather than allocating a new one per frame) means the renderer and any
   * React bindings downstream see stable references.
   */
  private touch(id: number, x: number, y: number, angle: number, hp: number, maxHp: number): void {
    let rp = this.remoteIndex.get(id);
    if (!rp) {
      rp = { id, name: `P${id}`, x, y, r: 14, angle, hp, maxHp, colorIndex: id % 6 };
      this.remoteIndex.set(id, rp);
      this.outPlayers.push(rp);
      return;
    }
    rp.x = x;
    rp.y = y;
    rp.angle = angle;
    rp.hp = hp;
    rp.maxHp = maxHp;
    this.outPlayers.push(rp);
  }

  /** Drops players that have left the match, reusing their slots next time. */
  private reapRemote(): void {
    if (this.remoteIndex.size === this.outPlayers.length) return;
    const live = new Set(this.outPlayers.map((p) => p.id));
    for (const id of [...this.remoteIndex.keys()]) {
      if (!live.has(id)) this.remoteIndex.delete(id);
    }
  }

  /** Names learned from the join roster, applied to the stable objects. */
  setNames(roster: { id: number; name: string }[]): void {
    for (const r of roster) {
      let rp = this.remoteIndex.get(r.id);
      if (!rp) {
        rp = { id: r.id, name: r.name, x: 0, y: 0, r: 14, angle: 0, hp: 100, maxHp: 100, colorIndex: r.id % 6 };
        this.remoteIndex.set(r.id, rp);
      } else {
        rp.name = r.name;
      }
    }
  }

  /** The sampled remote players. Valid until the next `sample()` call. */
  get players(): readonly RemotePlayer[] { return this.outPlayers; }

  /** The sampled enemy field. Valid until the next `sample()` call. */
  get enemies(): readonly { id: number; kind: string; x: number; y: number; r: number; hp: number; angle: number }[] {
    return this.outEnemies;
  }
}

/**
 * Loss estimate from input-sequence gaps.
 *
 * The client numbers its inputs; the server echoes the last one it processed.
 * A jump larger than one means packets were dropped or delayed past the
 * reorder window. Reported as a 0..1 fraction over a sliding window, which is
 * what the debug overlay shows as "packet loss".
 */
export class SequenceTracker {
  private lastAck = 0;
  private expected = 0;
  private lost = 0;
  private received = 0;
  private readonly window = 200;

  /** Call with the `ack` field of every snapshot. */
  observe(ack: number): void {
    if (this.lastAck === 0) { this.lastAck = ack; return; }
    const gap = ack - this.lastAck - 1;
    if (gap > 0) this.lost += gap;
    this.received += 1;
    this.lastAck = ack;
    this.expected++;
    if (this.expected >= this.window) {
      this.lost = Math.round(this.lost * 0.5);
      this.expected = Math.round(this.expected * 0.5);
    }
  }

  get lossRatio(): number {
    const total = this.lost + this.received;
    return total === 0 ? 0 : this.lost / total;
  }

  reset(): void {
    this.lastAck = 0;
    this.lost = 0;
    this.received = 0;
    this.expected = 0;
  }
}
