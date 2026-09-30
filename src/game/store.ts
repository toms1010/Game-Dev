/**
 * Neon Vanguard — external stores.
 *
 * The rule this module exists to enforce: **per-frame game state never goes
 * through React state.**
 *
 * The game loop runs at 60 Hz. Calling `setState` from it would schedule a
 * React render on every frame, and each render would diff the entire HUD
 * tree. That is the single easiest way to turn a fast game into a slow one on
 * a phone, and it shows up as input lag long before it shows up as dropped
 * frames.
 *
 * Instead the loop writes to a plain mutable object here, and pushes a
 * notification only when a value the UI actually shows has *changed*, at a
 * fixed low rate. React subscribes with `useSyncExternalStore`, so the
 * component tree renders a handful of times a second instead of sixty.
 *
 * The mutation path is deliberately allocation-free: `publish` compares field
 * by field and only allocates a new snapshot object when something moved.
 */

import { useSyncExternalStore } from 'react';
import type { Quality, WeaponType } from './entities';
import type { NetStatus } from '../network/protocol';

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

/** Everything the HUD displays. Mirrors what the engine owns. */
export interface HudSnapshot {
  score: number;
  hp: number;
  maxHp: number;
  wave: number;
  level: number;
  enemiesLeft: number;
  combo: number;
  power: number;
  kills: number;
  shield: number;
  rapid: number;
  bombCharges: number;
  weapon: WeaponType;
}

const EMPTY_HUD: HudSnapshot = {
  score: 0, hp: 100, maxHp: 100, wave: 1, level: 1, enemiesLeft: 0,
  combo: 1, power: 1, kills: 0, shield: 0, rapid: 0, bombCharges: 2,
  weapon: 'blaster',
};

const HUD_FIELDS: (keyof HudSnapshot)[] = [
  'score', 'hp', 'maxHp', 'wave', 'level', 'enemiesLeft',
  'combo', 'power', 'kills', 'shield', 'rapid', 'bombCharges', 'weapon',
];

function sameHud(a: HudSnapshot, b: HudSnapshot): boolean {
  for (let i = 0; i < HUD_FIELDS.length; i++) {
    const key = HUD_FIELDS[i]!;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

class HudStore {
  private current: HudSnapshot = EMPTY_HUD;
  private listeners = new Set<() => void>();
  /** Wall-clock gate. 10 Hz is well above what the eye reads on a number. */
  private lastPublish = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): HudSnapshot => this.current;

  /**
   * Called from the game loop. Mutates in place, then publishes at most once
   * per `minIntervalMs` — and only if something actually changed, so an idle
   * frame costs one comparison and no React work at all.
   */
  update(next: HudSnapshot, nowMs: number, minIntervalMs = 100): void {
    const target = this.current;
    target.score = next.score;
    target.hp = next.hp;
    target.maxHp = next.maxHp;
    target.wave = next.wave;
    target.level = next.level;
    target.enemiesLeft = next.enemiesLeft;
    target.combo = next.combo;
    target.power = next.power;
    target.kills = next.kills;
    target.shield = next.shield;
    target.rapid = next.rapid;
    target.bombCharges = next.bombCharges;
    target.weapon = next.weapon;

    if (nowMs - this.lastPublish < minIntervalMs) return;
    this.lastPublish = nowMs;
    // Compare against the last published value, not against itself: the
    // object above is mutated in place, so a separate record is needed.
    if (sameHud(this.published, target)) return;
    this.published = { ...target };
    for (const listener of this.listeners) listener();
  }

  /** Forces a publish; used when a phase change needs the HUD immediately. */
  flush(): void {
    this.published = { ...this.current };
    for (const listener of this.listeners) listener();
  }

  private published: HudSnapshot = { ...EMPTY_HUD };
}

export const hudStore = new HudStore();

export function useHud(): HudSnapshot {
  return useSyncExternalStore(hudStore.subscribe, hudStore.getSnapshot, hudStore.getSnapshot);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  quality: Quality;
  /** The player pinned the tier, so the auto-tune watchdog must not touch it. */
  qualityPinned: boolean;
  muted: boolean;
  /** 0 = off (used by the performance overlay). */
  debugOverlay: boolean;
  hapticFeedback: boolean;
}

const SETTINGS_KEY = 'neon-vanguard-settings';

function readSettings(): Settings {
  const defaults: Settings = {
    quality: 'high',
    qualityPinned: false,
    muted: false,
    debugOverlay: false,
    hapticFeedback: true,
  };
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (parsed.quality === 'low' || parsed.quality === 'medium' || parsed.quality === 'high') {
      defaults.quality = parsed.quality;
    }
    return {
      ...defaults,
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : defaults.muted,
      debugOverlay: typeof parsed.debugOverlay === 'boolean' ? parsed.debugOverlay : defaults.debugOverlay,
      hapticFeedback: typeof parsed.hapticFeedback === 'boolean' ? parsed.hapticFeedback : defaults.hapticFeedback,
      qualityPinned: defaults.quality !== 'high',
    };
  } catch {
    return defaults;
  }
}

class SettingsStore {
  private current: Settings = readSettings();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): Settings => this.current;

  set(patch: Partial<Settings>): void {
    const next = { ...this.current, ...patch };
    // Choosing a tier explicitly is a decision; stop second-guessing it.
    if (patch.quality !== undefined) next.qualityPinned = true;
    this.current = next;
    try {
      if (typeof localStorage !== 'undefined') {
        const { quality, muted, debugOverlay, hapticFeedback } = next;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality, muted, debugOverlay, hapticFeedback }));
      }
    } catch { /* private browsing, quota: settings just do not persist */ }
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.current = readSettings();
    try { localStorage?.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
    for (const listener of this.listeners) listener();
  }
}

export const settingsStore = new SettingsStore();

export function useSettings(): Settings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
}

// ---------------------------------------------------------------------------
// Network status
// ---------------------------------------------------------------------------

export interface NetSnapshot {
  status: NetStatus;
  rttMs: number;
  serverTps: number;
  lossRatio: number;
  match: string;
  players: number;
}

const EMPTY_NET: NetSnapshot = {
  status: 'offline', rttMs: 0, serverTps: 0, lossRatio: 0, match: '', players: 0,
};

class NetStore {
  private current: NetSnapshot = EMPTY_NET;
  private listeners = new Set<() => void>();
  private lastPublish = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): NetSnapshot => this.current;

  update(next: NetSnapshot, nowMs: number, minIntervalMs = 500): void {
    const target = this.current;
    const changed =
      target.status !== next.status ||
      target.match !== next.match ||
      target.players !== next.players ||
      Math.abs(target.rttMs - next.rttMs) >= 5 ||
      Math.abs(target.lossRatio - next.lossRatio) >= 0.02 ||
      Math.abs(target.serverTps - next.serverTps) >= 2;

    target.status = next.status;
    target.rttMs = next.rttMs;
    target.serverTps = next.serverTps;
    target.lossRatio = next.lossRatio;
    target.match = next.match;
    target.players = next.players;

    if (!changed) return;
    if (nowMs - this.lastPublish < minIntervalMs && target.status === next.status) return;
    this.lastPublish = nowMs;
    for (const listener of this.listeners) listener();
  }
}

export const netStore = new NetStore();

export function useNet(): NetSnapshot {
  return useSyncExternalStore(netStore.subscribe, netStore.getSnapshot, netStore.getSnapshot);
}

// ---------------------------------------------------------------------------
// A generic event bus for things that are neither state nor per-frame data.
// ---------------------------------------------------------------------------

type Handler = () => void;

/** Minimal typed emitter for discrete events (toasts, unlocks, game over). */
class Emitter<M extends string> {
  private handlers = new Map<M, Set<Handler>>();

  on(event: M, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  emit(event: M): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) handler();
  }
}

export type GameEvent = 'game-over' | 'upgrade' | 'unlock' | 'pause' | 'resume';
export const gameEvents = new Emitter<GameEvent>();
