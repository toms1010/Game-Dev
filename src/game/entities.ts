/**
 * Neon Vanguard — shared entity types, tuning constants and object pools.
 *
 * This module is the base of the `src/game` dependency graph: it imports
 * nothing, so every other game module (physics, weapons, enemies, renderer,
 * engine) can depend on it without creating a cycle.
 *
 * Everything here is designed for the hot path. Entities are plain mutable
 * structs (no classes, no getters) and are recycled through fixed-size pools
 * so a busy frame performs zero allocations.
 */

export const TAU = Math.PI * 2;

/** Baseline arena size the simulation is tuned around (16:10). */
export const BASE_W = 960;
export const BASE_H = 600;
/**
 * The arena is reshaped to the device aspect ratio while holding this area
 * constant, so difficulty (enemy density, travel distances, dodge windows)
 * is identical on every screen — only the shape of the battlefield changes.
 */
export const BASE_AREA = BASE_W * BASE_H;

/** Aspect ratios the arena is allowed to stretch to before it letterboxes. */
export const MIN_ASPECT = 1.25;
export const MAX_ASPECT = 2.6;

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const randInt = (a: number, b: number) => a + ((Math.random() * (b - a + 1)) | 0);
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Waves completed per difficulty tier before the enemies get stronger. */
export const WAVES_PER_LEVEL = 5;

export type Vec = { x: number; y: number };

export interface Input {
  up: boolean; down: boolean; left: boolean; right: boolean;
  aim: Vec | null;      // world-space aim point
  firing: boolean;
  move: Vec;            // analog stick vector (-1..1)
}

export const emptyInput = (): Input => ({
  up: false, down: false, left: false, right: false,
  aim: null, firing: false, move: { x: 0, y: 0 },
});

export type Quality = 'low' | 'medium' | 'high';

export type WeaponType = 'blaster' | 'spread' | 'homing';

// ---------------------------------------------------------------------------
// Quality profiles
// ---------------------------------------------------------------------------

/**
 * A single quality tier. Render + simulation knobs are resolved once into a
 * flat `FxProfile` so the per-frame code branches on plain booleans instead
 * of comparing strings 60 times a second.
 */
export interface QualityPreset {
  label: string;
  /** Hard ceiling on live particles. */
  maxParticles: number;
  /** Canvas backing-store multiplier, before the device pixel ratio cap. */
  renderScale: number;
  /** Multiplier applied to every particle burst request. */
  particleScale: number;
  /** Gaussian-style glow (ctx.shadowBlur) — the single most expensive effect. */
  shadows: boolean;
  /** Neon background grid lines. */
  grid: boolean;
  /** Orbiting decorative dots on the reticle / reticle dot ring. */
  reticleDots: boolean;
  /** Comet trails behind projectiles. */
  trails: boolean;
  /** Golden combo aura around the ship. */
  comboAura: boolean;
  /** Concurrent enemy cap, as a fraction of the difficulty-derived cap. */
  enemyCapScale: number;
  /** Spatial-hash cell size in world units (bigger = fewer cells, more tests). */
  cellSize: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: {
    label: 'LOW',
    maxParticles: 380,
    renderScale: 1,
    particleScale: 0.5,
    shadows: false,
    grid: false,
    reticleDots: false,
    trails: false,
    comboAura: false,
    enemyCapScale: 0.7,
    cellSize: 96,
  },
  medium: {
    label: 'MEDIUM',
    maxParticles: 700,
    renderScale: 1,
    particleScale: 0.8,
    shadows: true,
    grid: true,
    reticleDots: false,
    trails: true,
    comboAura: true,
    enemyCapScale: 0.85,
    cellSize: 72,
  },
  high: {
    label: 'HIGH',
    maxParticles: 1000,
    renderScale: 1,
    particleScale: 1,
    shadows: true,
    grid: true,
    reticleDots: true,
    trails: true,
    comboAura: true,
    enemyCapScale: 1,
    cellSize: 64,
  },
};

/** Flat, branch-friendly view of a quality preset used by the hot path. */
export interface FxProfile {
  quality: Quality;
  maxParticles: number;
  particleScale: number;
  renderScale: number;
  shadows: boolean;
  grid: boolean;
  reticleDots: boolean;
  trails: boolean;
  comboAura: boolean;
  enemyCapScale: number;
  cellSize: number;
  /** True for the lowest tier; kept because the render path tests it most. */
  low: boolean;
}

export function resolveFx(quality: Quality): FxProfile {
  const p = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
  return {
    quality: p === QUALITY_PRESETS.low ? 'low' : p === QUALITY_PRESETS.medium ? 'medium' : 'high',
    maxParticles: p.maxParticles,
    particleScale: p.particleScale,
    renderScale: p.renderScale,
    shadows: p.shadows,
    grid: p.grid,
    reticleDots: p.reticleDots,
    trails: p.trails,
    comboAura: p.comboAura,
    enemyCapScale: p.enemyCapScale,
    cellSize: p.cellSize,
    low: p === QUALITY_PRESETS.low,
  };
}

/**
 * Picks a starting tier from coarse device signals. Deliberately conservative:
 * a wrong guess is corrected by the frame-time watchdog in the game loop
 * (see `engine.autoTune`), and the player can always override in Settings.
 */
export function detectQuality(): Quality {
  if (typeof navigator === 'undefined') return 'medium';
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (cores <= 4 || mem <= 3) return 'low';
  if (coarse || cores <= 6) return 'medium';
  return 'high';
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

interface Entity { x: number; y: number; vx: number; vy: number; r: number; dead?: boolean }

export type EnemyKind = 'grunt' | 'rusher' | 'tank' | 'shooter' | 'splitter' | 'healer' | 'boss';

export interface Enemy extends Entity {
  hp: number; maxHp: number; kind: EnemyKind;
  color: string; hit: number; score: number; cd: number; spin: number;
  mini?: boolean; freeze: number; level: number; pulse: number;
  spd?: number;             // global level-based speed multiplier, captured at spawn
  phase?: number;           // boss attack-phase state machine
  phaseTimer?: number;      // time until next boss phase switch
  spiralAngle?: number;     // current angle of the spiral nova emitter
}

export interface Bullet extends Entity {
  life: number; dmg: number; foe: boolean; color: string;
  px: number; py: number;   // previous position, for swept collision + trails
  homing?: boolean;
}

export type ParticleShape = 'circle' | 'spark' | 'star';

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; r: number; color: string;
  glow?: boolean; shape?: ParticleShape; spin?: number; spinV?: number;
}

export type PickupKind = 'health' | 'power' | 'shield' | 'rapid' | 'freeze';

export interface Pickup extends Entity { kind: PickupKind; t: number }

export interface Pop {
  x: number; y: number; text: string; life: number; max: number;
  color: string; scale: number; vy: number;
}

export interface Shockwave {
  x: number; y: number; r: number; maxR: number;
  life: number; maxLife: number; color: string; width: number; fill?: boolean;
}

export interface Ghost { x: number; y: number; angle: number; life: number; max: number }

/** A wave-clear reward the player picks from three random options. */
export interface WeaponUpgrade {
  id: 'fire_rate' | 'damage' | 'spread_weapon' | 'homing_weapon' | 'bullet_speed' | 'plasma_beam';
  title: string;
  description: string;
  /** Engine WeaponType this upgrade switches to, or null for pure stat buffs. */
  weapon: WeaponType | null;
  /** Short tag rendered on loadout cards. */
  tag: string;
  apply: (game: import('./engine').Game) => void;
}

export const ENEMY_CONFIG = {
  grunt: { r: 15, hp: 20, speed: 95, damage: 12, score: 100, color: '#ff4d6d' },
  rusher: { r: 11, hp: 14, speed: 205, damage: 12, score: 150, color: '#ffd166' },
  tank: { r: 26, hp: 90, speed: 55, damage: 22, score: 500, color: '#22d3ee' },
  shooter: { r: 17, hp: 30, speed: 75, damage: 10, score: 250, color: '#8b5cf6' },
  splitter: { r: 16, hp: 24, speed: 100, damage: 12, score: 180, color: '#fb7185' },
  healer: { r: 14, hp: 22, speed: 80, damage: 12, score: 220, color: '#4ade80' },
  boss: { r: 48, hp: 1200, speed: 35, damage: 30, score: 5000, color: '#a855f7' },
} as const;

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * A fixed-capacity free list. `acquire` never allocates once the pool is
 * warmed; `release` is a single array push. Capacity is enforced on release so
 * a burst of deaths can never balloon the heap.
 */
export class Pool<T> {
  private free: T[] = [];
  private readonly capacity: number;

  constructor(
    private readonly factory: () => T,
    private readonly reset: (o: T) => void,
    capacity: number,
  ) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) this.free.push(factory());
  }

  get available(): number { return this.free.length; }

  acquire(): T {
    const o = this.free.pop();
    if (o === undefined) return this.factory();
    this.reset(o);
    return o;
  }

  release(o: T): void {
    if (this.free.length < this.capacity) this.free.push(o);
  }
}

/**
 * Compacts `arr` in place, returning dead objects to `pool` via swap-and-pop.
 *
 * Order is not preserved, which is fine for every list in the simulation
 * (AI, collision and render are all order-independent) and it avoids the
 * per-frame array allocation that `Array.prototype.filter` would cause.
 */
export function sweepPooled<T extends { dead?: boolean }>(
  arr: T[],
  pool: Pool<T> | null,
): void {
  let n = arr.length;
  for (let i = n - 1; i >= 0; i--) {
    const o = arr[i];
    if (!o.dead) continue;
    arr[i] = arr[n - 1];
    arr.pop();
    n--;
    pool?.release(o);
  }
}

/** Same in-place compaction, for lists that expire on a timer instead of a
 *  `dead` flag (particles, floating text, shockwaves, dash trails). */
export function sweepByPooled<T>(arr: T[], pool: Pool<T> | null, alive: (o: T) => boolean): void {
  let n = arr.length;
  for (let i = n - 1; i >= 0; i--) {
    const o = arr[i]!;
    if (alive(o)) continue;
    arr[i] = arr[n - 1];
    arr.pop();
    n--;
    pool?.release(o);
  }
}

/** Compacts by a predicate (`life > 0`) without allocating a new array. */
export function sweepBy<T>(arr: T[], alive: (o: T) => boolean): void {
  let n = arr.length;
  for (let i = n - 1; i >= 0; i--) {
    if (alive(arr[i])) continue;
    arr[i] = arr[n - 1];
    arr.pop();
    n--;
  }
}
