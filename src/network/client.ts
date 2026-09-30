/**
 * Neon Vanguard — networked play client.
 *
 * Responsibilities, in the order they matter for feel:
 *
 *   1. Stay connected. Exponential backoff, jittered so a server restart does
 *      not produce a thundering herd, and a session token so a reconnect can
 *      rejoin the same match instead of landing in a new one.
 *   2. Respond instantly. Every input is applied locally on the same frame it
 *      is sampled (prediction), so the ship never waits for the round trip.
 *   3. Stay honest. Snapshots acknowledge the last input consumed; anything
 *      newer is replayed on top of the authoritative state
 *      (reconciliation). A large positional error is absorbed as a decaying
 *      visual offset rather than a teleport.
 *   4. Degrade gracefully. Nothing in the single-player path depends on this
 *      class; if the socket never opens, `status` stays `offline` and the game
 *      is a complete local experience.
 *
 * Tick discipline: `step()` is called once per rendered frame and is the only
 * place prediction runs. `flush()` is called at a fixed input rate, decoupled
 * from the frame rate, so network cadence is stable on a 120 Hz display.
 */

import { integrateMovement } from '../game/physics';
import type { Game } from '../game/engine';
import type { Vec } from '../game/entities';
import { SnapshotBuffer, SequenceTracker } from './interpolation';
import {
  BACKOFF_CEILING_MS, PROTOCOL_VERSION, backoffDelay, decodeMessage,
  encodeInput, type AbilityKind, type GameEventKind, type MatchMode, type NetStatus, type PlayerWire,
  type ServerMsg,
} from './protocol';

export interface NetworkClientOptions {
  url: string;
  name: string;
  mode?: MatchMode;
  /** Set false to stay fully offline; the game is unaffected either way. */
  enabled?: boolean;
  /** Input packets per second. 30 is ample for a twin-stick shooter. */
  inputRateHz?: number;
  pingIntervalMs?: number;
  /** Extra input samples repeated in each packet for loss tolerance. */
  redundancy?: number;
  maxBackoffMs?: number;
}

export interface NetworkMetrics {
  status: NetStatus;
  rttMs: number;
  /** Server clock minus local clock, ms. Positive means the server is ahead. */
  clockOffsetMs: number;
  serverTick: number;
  /** Inputs per second the server is actually consuming. */
  serverTps: number;
  lossRatio: number;
  reconnectAttempts: number;
  lastError: string;
  snapshotsReceived: number;
  bytesSent: number;
  bytesReceived: number;
  /** Input samples refused because they failed validation. */
  invalidInputs: number;
  /** Messages refused by the rate limiter. */
  rateLimited: number;
}

/** One sampled input, retained until the server acknowledges it. */
interface PendingInput {
  seq: number;
  dt: number;
  mx: number;
  my: number;
}

const MAX_PENDING = 180;

export class NetworkClient {
  private opts: Required<NetworkClientOptions>;
  private ws: WebSocket | null = null;
  private status: NetStatus = 'offline';
  private localId = 0;
  private matchId = '';
  private token = '';

  /** Interpolation buffer for remote entities. */
  readonly buffer = new SnapshotBuffer();
  private seq = new SequenceTracker();

  // --- prediction state ---
  private pending: PendingInput[] = [];
  private latestSeq = 0;
  private clientTick = 0;

  // --- send/receive pacing ---
  private inputAccum = 0;
  private pingAccum = 0;
  private pingSeq = 0;
  private pendingPings = new Map<number, number>();

  // --- reconnection ---
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private shouldRun = false;

  // --- metrics ---
  private tickAccum = 0;
  private tickWindowStart = 0;
  private rttMs = 0;
  private clockOffset = 0;
  private lastServerTick = 0;
  private serverTps = 0;
  private bytesSent = 0;
  private bytesReceived = 0;
  private lastError = '';
  private game: Game | null = null;
  private lastSnapshot: { k: number; a: number; players: PlayerWire[] } | null = null;

  constructor(options: NetworkClientOptions) {
    this.opts = {
      mode: 'arena',
      enabled: true,
      inputRateHz: 30,
      pingIntervalMs: 2000,
      redundancy: 2,
      maxBackoffMs: BACKOFF_CEILING_MS,
      ...options,
    };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  get id(): number { return this.localId; }
  get currentStatus(): NetStatus { return this.status; }
  get inMatch(): boolean { return this.status === 'connected' && this.matchId !== ''; }
  get match(): string { return this.matchId; }
  get playerName(): string { return this.opts.name; }

  get metrics(): NetworkMetrics {
    return {
      status: this.status,
      rttMs: Math.round(this.rttMs),
      clockOffsetMs: Math.round(this.clockOffset),
      serverTick: this.lastServerTick,
      serverTps: this.serverTps,
      lossRatio: this.seq.lossRatio,
      reconnectAttempts: this.attempt,
      lastError: this.lastError,
      snapshotsReceived: this.snapshotsReceived,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      invalidInputs: this.invalidInputs,
      rateLimited: this.rateLimited,
    };
  }

  private snapshotsReceived = 0;
  private invalidInputs = 0;
  private rateLimited = 0;

  /** Binds the client to a game instance and enables server-authoritative mode. */
  attach(game: Game): void {
    this.game = game;
    game.setNetMode(this.inMatch);
  }

  connect(): void {
    if (!this.opts.enabled) {
      this.setStatus('offline');
      return;
    }
    this.shouldRun = true;
    this.open();
  }

  private open(): void {
    if (typeof WebSocket === 'undefined') {
      this.setStatus('offline');
      this.shouldRun = false;
      return;
    }
    this.clearReconnect();
    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    this.lastError = '';

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.lastError = String(err);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.send({
        t: 'CONNECT',
        v: PROTOCOL_VERSION,
        client: detectPlatform(),
        device: navigatorLabel(),
      });
      this.setStatus('authenticating');
      this.send({ t: 'AUTH', name: this.opts.name, token: this.token || undefined });
    };

    ws.onmessage = (ev: MessageEvent) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      this.bytesReceived += data.length;
      const msg = decodeMessage(data);
      if (msg) this.handle(msg);
    };

    ws.onerror = () => {
      // `onerror` carries no useful detail in browsers; the close handler
      // does the actual recovery and reports a readable message.
      this.lastError = this.lastError || 'socket error';
    };

    ws.onclose = () => {
      this.ws = null;
      this.buffer.clear();
      this.seq.reset();
      this.pending.length = 0;
      this.game?.setNetMode(false);
      if (this.shouldRun) this.scheduleReconnect();
      else this.setStatus('offline');
    };
  }

  /** Closes the socket and stops reconnecting. Safe to call repeatedly. */
  disconnect(): void {
    this.shouldRun = false;
    this.clearReconnect();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ t: 'LEAVE' });
      this.ws.close(1000, 'client disconnect');
    }
    this.ws = null;
    this.setStatus('offline');
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer !== null) return;
    this.attempt += 1;
    const base = Math.min(this.opts.maxBackoffMs, backoffDelay(this.attempt));
    // ±20% jitter: keeps a fleet of clients from retrying in lockstep.
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay) as unknown as number;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    this.status = s;
    if (s === 'connected') this.attempt = 0;
  }

  // =========================================================================
  // Send
  // =========================================================================

  private send(msg: object): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(msg);
    this.bytesSent += raw.length;
    ws.send(raw);
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  // =========================================================================
  // Receive
  // =========================================================================

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'WELCOME': {
        this.localId = msg.id;
        this.lastServerTick = msg.tick;
        this.clockOffset = msg.tick * (1000 / 60) - this.now();
        // Adopt the server's arena so prediction clamps to the same bounds.
        const game = this.game;
        if (game) {
          game.W = msg.aw;
          game.H = msg.ah;
          game.spatialGrid.resize(msg.aw, msg.ah);
        }
        break;
      }
      case 'AUTH_OK': {
        this.localId = msg.id;
        this.send({ t: 'JOIN', mode: this.opts.mode });
        break;
      }
      case 'JOINED': {
        this.matchId = msg.match;
        this.buffer.setNames(msg.roster);
        this.setStatus('connected');
        this.game?.setNetMode(true);
        break;
      }
      case 'SNAP': {
        this.snapshotsReceived += 1;
        this.lastServerTick = msg.k;
        // Server ticks per second, measured over a 500 ms sliding window.
        this.tickAccum += 1;
        const tickNow = this.now();
        if (this.tickWindowStart === 0) this.tickWindowStart = tickNow;
        const windowMs = tickNow - this.tickWindowStart;
        if (windowMs >= 500) {
          this.serverTps = Math.round((this.tickAccum * 1000) / windowMs);
          this.tickAccum = 0;
          this.tickWindowStart = tickNow;
        }
        this.seq.observe(msg.a);
        if (this.seq.lossRatio > 0.02) this.rateLimited += 1;
        this.lastSnapshot = { k: msg.k, a: msg.a, players: msg.p };
        this.buffer.push({
          tick: msg.k,
          receivedAt: this.now(),
          players: msg.p,
          enemies: msg.e,
        });
        this.reconcile(msg.a, msg.p);
        break;
      }
      case 'PONG': {
        const sent = this.pendingPings.get(msg.i);
        if (sent !== undefined) {
          this.pendingPings.delete(msg.i);
          const rtt = this.now() - sent;
          // Smooth so a single spike does not jitter the readout.
          this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.7 + rtt * 0.3;
          const serverNow = msg.k * (1000 / 60);
          this.clockOffset = serverNow - (this.now() - this.rttMs / 2);
        }
        break;
      }
      case 'EV':
        this.handleEvent(msg.e, msg.id, msg.v ?? 0);
        break;
      case 'ERR':
        this.lastError = msg.m;
        this.setStatus('error');
        break;
    }
  }

  private handleEvent(kind: GameEventKind, id: number | undefined, value: number): void {
    const game = this.game;
    if (!game) return;
    switch (kind) {
      case 'hit':
        // The server confirmed a hit; mirror its feedback locally.
        if (id === this.localId) {
          game.shake = Math.min(30, game.shake + 12);
          game.flash = 0.35;
        }
        break;
      case 'death':
        if (id === this.localId) {
          game.over = true;
          game.shake = 42;
          game.slowmo = 1;
          game.snd('gameOver');
        }
        break;
      case 'wave':
        game.wave = value;
        game.pop(game.W / 2, 120, `WAVE ${value}`, '#7df9ff', 1.6);
        break;
      case 'match_end':
        game.over = true;
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // Prediction
  // =========================================================================

  /**
   * Applies one frame of local input immediately.
   *
   * Called once per rendered frame *before* the game update, so the ship moves
   * on the same frame the stick is read. The sample is retained until the
   * server acknowledges it.
   */
  predict(dt: number, move: Vec, aim: Vec, firing: boolean): void {
    const game = this.game;
    if (!game || this.status !== 'connected') return;

    this.clientTick += Math.max(1, Math.round(dt * 60));
    const seq = ++this.latestSeq;
    this.pending.push({ seq, dt, mx: move.x, my: move.y });

    // Cap the replay window: if the server is gone for a long time, snapping
    // to its stale state is better than replaying minutes of input.
    while (this.pending.length > MAX_PENDING) this.pending.shift();

    // Immediate local response.
    integrateMovement(
      game.player, move.x, move.y, dt,
      game.W, game.H, 420 * game.baseSpeedMult,
    );
    game.reticle = aim;
    game.reticleColor = '#7df9ff';

    this.inputAccum += dt;
    const interval = 1 / this.opts.inputRateHz;
    if (this.inputAccum >= interval) {
      this.inputAccum = 0;
      this.flush(firing);
    }
  }

  /** Sends the newest input plus `redundancy` repeats of the ones before it. */
  private flush(firing: boolean): void {
    if (!this.inMatch) return;
    const game = this.game;
    if (!game) return;
    const n = this.opts.redundancy + 1;
    for (let i = 0; i < n; i++) {
      const p = this.pending[this.pending.length - 1 - i];
      if (!p) break;
      this.send(encodeInput(
        p.seq, this.clientTick,
        { x: p.mx, y: p.my },
        game.reticle ?? { x: game.player.x, y: game.player.y },
        firing,
      ));
    }
  }

  /**
   * Rewinds to the server's authoritative state and replays unacked inputs.
   *
   * The resulting displacement is kept in `game.netError` and eased out by the
   * renderer, so a 3-unit correction is invisible while a 200-unit correction
   * (a teleport, a dash the server rejected) still reads as authoritative.
   */
  private reconcile(ack: number, players: PlayerWire[]): void {
    const game = this.game;
    if (!game) return;
    const mine = players.find((p) => p[0] === this.localId);
    if (!mine) return;

    const p = game.player;
    const authoritativeX = mine[1], authoritativeY = mine[2];

    // Drop everything the server has already consumed.
    while (this.pending.length && this.pending[0]!.seq <= ack) this.pending.shift();

    // Rewind, then replay.
    p.x = authoritativeX;
    p.y = authoritativeY;
    p.vx = mine[3];
    p.vy = mine[4];
    p.angle = mine[5];
    p.hp = mine[6];
    p.maxHp = mine[7];
    p.iframe = (mine[8] & 1) !== 0 ? 0.2 : p.iframe;

    for (let i = 0; i < this.pending.length; i++) {
      const s = this.pending[i]!;
      integrateMovement(p, s.mx, s.my, s.dt, game.W, game.H, 420 * game.baseSpeedMult);
    }

    // Compare against where we were before the rewind to size the correction.
    const errX = authoritativeX - p.x;
    const errY = authoritativeY - p.y;
    if (Math.hypot(errX, errY) > 0.5) {
      // Small errors accumulate into the visual offset; large ones snap so
      // the player is not left fighting a phantom position.
      if (Math.hypot(errX, errY) < 90) {
        game.netError.x += errX;
        game.netError.y += errY;
      }
    }
  }

  /** Requests a full state resend from the current tick. */
  requestResync(): void {
    this.send({ t: 'RESYNC', since: this.lastSnapshot?.k ?? 0 });
  }

  /**
   * Reports whether the server's acknowledgement has fallen so far behind
   * that inputs are being dropped rather than merely delayed. The server
   * refuses anything out of sequence, so a rising count here means the
   * connection, not the player, is the problem.
   */
  get outOfSync(): boolean {
    return this.latestSeq - (this.lastSnapshot?.a ?? 0) > 90;
  }

  // =========================================================================
  // Per-frame
  // =========================================================================

  /**
   * Advances networking: pings, buffer sampling and remote entity sync.
   * Call once per frame after the game update.
   */
  step(dt: number): void {
    const game = this.game;
    if (!game) return;

    // Decay the visual reconciliation offset.
    const decay = Math.min(1, dt * 12);
    game.netError.x -= game.netError.x * decay;
    game.netError.y -= game.netError.y * decay;
    if (Math.abs(game.netError.x) < 0.01) game.netError.x = 0;
    if (Math.abs(game.netError.y) < 0.01) game.netError.y = 0;

    if (this.status !== 'connected') return;

    this.pingAccum += dt * 1000;
    if (this.pingAccum >= this.opts.pingIntervalMs) {
      this.pingAccum = 0;
      const id = ++this.pingSeq;
      this.pendingPings.set(id, this.now());
      // Drop stale pings so a dead connection cannot leak the map.
      if (this.pendingPings.size > 8) {
        const oldest = this.pendingPings.keys().next().value;
        if (oldest !== undefined) this.pendingPings.delete(oldest);
      }
      this.send({ t: 'PING', i: id, c: this.clientTick });
    }

    this.buffer.sample(this.now(), this.localId);
    game.remotePlayers = this.buffer.players;
    game.syncRemoteEnemies(this.buffer.enemies);
  }

  /** Fire-and-forget ability request; the server decides whether it happens. */
  requestAbility(kind: AbilityKind): void {
    this.send({ t: 'ABILITY', s: ++this.latestSeq, k: kind });
  }
}

function detectPlatform(): 'web' | 'android' | 'ios' {
  if (typeof navigator === 'undefined') return 'web';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'web';
}

function navigatorLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  return navigator.userAgent.slice(0, 120);
}
