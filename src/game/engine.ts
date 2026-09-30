/**
 * Neon Vanguard — authoritative game simulation.
 *
 * This is the single source of truth for gameplay. It is deliberately free of
 * DOM, React and canvas concerns: it takes an `Input`, advances by a fixed
 * timestep and mutates plain state, which is exactly what lets the same code
 * run (a) in the browser game loop, (b) behind the prediction/reconciliation
 * layer in `src/network`, and (c) conceptually mirrored by the C++ server in
 * `server/`.
 *
 * Performance contract
 * -------------------
 * * No allocation in the steady state. Bullets, particles, enemies and
 *   pickups come from fixed-capacity pools; every per-frame "filter" is an
 *   in-place compaction.
 * * Broad phase is a uniform spatial hash sized by the quality profile.
 * * Rendering is a pure function (`renderer.ts`) and never runs inside here.
 *
 * Fixed timestep
 * --------------
 * `update()` is written to be called with a clamped delta. Callers that need
 * deterministic behaviour (netcode replay, server parity) should use
 * `FIXED_DT` and call `stepFixed()` in a loop.
 */

import {
  BASE_AREA, BASE_H, BASE_W, MAX_ASPECT, MIN_ASPECT, Pool, TAU,
  clamp, detectQuality, emptyInput, rand, resolveFx, sweepBy, sweepByPooled, sweepPooled,
  WAVES_PER_LEVEL, ENEMY_CONFIG,
  type Bullet, type Enemy, type FxProfile, type Ghost, type Input, type Particle,
  type Pickup, type PickupKind, type Pop, type Quality, type RemotePlayer, type Shockwave, type Vec,
  type WeaponType, type WeaponUpgrade,
} from './entities';
import type { EnemyKindId } from '../network/protocol';
import { SpatialHash, segmentIntersectsCircle, nearestEnemy, integrateMovement } from './physics';
import {
  isBossWave, maxConcurrentEnemies, rosterSize, spawnEnemy, spawnEnemyAt,
  spawnInterval, updateEnemies,
} from './enemies';
import { fireInterval, fireWeapon, pickUpgrades } from './weapons';
import { renderGame } from './renderer';
import type { SoundName } from './sound';
import type { HangarUpgrades } from './saveSystem';
import { SaveManager } from './saveSystem';

export { emptyInput };
export type { Input, Quality, WeaponType, WeaponUpgrade, Vec };
export { renderGame };
export { detectQuality, QUALITY_PRESETS } from './entities';

/** Simulation rate. Rendering may run faster; gameplay never does. */
export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;

/** Pool ceilings. A burst larger than the ceiling drops instead of growing. */
const MAX_BULLETS = 320;
const MAX_ENEMIES = 128;
const MAX_PICKUPS = 64;

const PICKUP_COLOR: Record<PickupKind, string> = {
  health: '#4ade80', power: '#ffd166', shield: '#38bdf8', rapid: '#f472b6', freeze: '#a5f3fc',
};

/** Enemy silhouette colours, keyed by the protocol's archetype id. */
const ENEMY_COLORS: Record<EnemyKindId, string> = {
  grunt: ENEMY_CONFIG.grunt.color,
  rusher: ENEMY_CONFIG.rusher.color,
  tank: ENEMY_CONFIG.tank.color,
  shooter: ENEMY_CONFIG.shooter.color,
  splitter: ENEMY_CONFIG.splitter.color,
  healer: ENEMY_CONFIG.healer.color,
  boss: ENEMY_CONFIG.boss.color,
};

/** Re-exported so the network layer can label server entities. */
export type { EnemyKindId };
export { ENEMY_KINDS } from '../network/protocol';

/** Roll of a single pickup drop. */
function rollPickupKind(): PickupKind {
  const roll = Math.random();
  if (roll < 0.4) return 'health';
  if (roll < 0.62) return 'power';
  if (roll < 0.78) return 'shield';
  if (roll < 0.9) return 'rapid';
  return 'freeze';
}

/**
 * Rolling performance snapshot, sampled once per frame by the host loop and
 * rendered by the debug overlay. Kept off React entirely.
 */
export interface PerfMetrics {
  fps: number;
  /** Wall-clock ms between frames, smoothed. */
  frameMs: number;
  /** ms spent in update(). */
  simMs: number;
  /** ms spent in render(). */
  renderMs: number;
  enemies: number;
  bullets: number;
  particles: number;
  pickups: number;
  /** Live spatial-hash cells that hold at least one enemy. */
  gridCells: number;
  quality: Quality;
  /** Sum of the pooled-object high-water marks; a proxy for heap pressure. */
  pooledObjects: number;
}

export interface RunStats {
  finalScore: number; kills: number; bossesKilled: number; wavesCleared: number;
}

export class Game {
  // ---- arena -------------------------------------------------------------
  /**
   * Arena dimensions in world units. Reshaped to the device aspect ratio by
   * `setViewport()` while holding the total area constant, so difficulty is
   * device independent.
   */
  W = BASE_W;
  H = BASE_H;

  // ---- identity / tuning -------------------------------------------------
  quality: Quality;
  /** Flattened quality flags — read every frame, so never compare strings. */
  fx: FxProfile;
  /** Bosses destroyed this run — feeds the BOSS SLAYER achievement. */
  bossesKilled = 0;
  /** Toggle flag for the spatial-hash debug overlay. */
  debugMode = false;
  /** Number of waves between difficulty level-ups. */
  static WAVES_PER_LEVEL = WAVES_PER_LEVEL;
  /** Seconds of calm granted after a wave is fully cleared. */
  WAVE_PAUSE = 2.5;

  // ---- entities ----------------------------------------------------------
  player = {
    x: BASE_W / 2, y: BASE_H / 2, vx: 0, vy: 0, r: 14,
    hp: 100, maxHp: 100, angle: 0, cd: 0,
    iframe: 0, dashCd: 0, dash: 0, bob: 0,
    shield: 0, rapid: 0, bombCd: 0, bombCharges: 2, bombMax: 2,
  };
  bullets: Bullet[] = [];
  enemies: Enemy[] = [];
  particles: Particle[] = [];
  pickups: Pickup[] = [];
  pops: Pop[] = [];
  shockwaves: Shockwave[] = [];
  ghosts: Ghost[] = [];
  stars: { x: number; y: number; z: number }[] = [];

  // ---- run state ---------------------------------------------------------
  shake = 0; flash = 0; time = 0; score = 0; combo = 1; comboTimer = 0;
  wave = 1; spawnTimer = 0; kills = 0;
  level = 1;
  enemiesRemainingInWave = 0;
  totalWaveEnemies = 0;
  waveSpawningFinished = false;
  wavePauseTimer = 0;
  power = 1; powerTimer = 0;
  freezeTimer = 0;
  /** Permanent hangar movement multiplier (Engine Thrusters upgrade). */
  baseSpeedMult = 1;

  weapon: WeaponType = 'blaster';
  fireRateLevel = 1;
  damageLevel = 1;
  bulletSpeedLevel = 1;
  pendingUpgrade = false;
  upgradeOptions: WeaponUpgrade[] = [];

  over = false; slowmo = 0;
  /** Hit-stop timer: gameplay is frozen while > 0, shake still decays. */
  hitStopTimer = 0;

  reticle: Vec | null = null;
  reticleColor = '#7df9ff';
  moveTarget: Vec | null = null;

  /**
   * Interpolated positions of other players in a networked match.
   * Written by `src/network/interpolation.ts` between frames; the simulation
   * itself never touches it.
   */
  remotePlayers: readonly RemotePlayer[] = [];

  /**
   * Visual-only offset applied to the local ship so a reconciliation
   * correction eases in instead of snapping. Decayed by the host loop.
   */
  netError = { x: 0, y: 0 };

  /**
   * Server-authoritative mode.
   *
   * In this mode the local simulation stops owning gameplay: the ship is
   * moved by client prediction, health and the enemy field arrive in
   * snapshots, and damage/score are decided by the server. Local bullets are
   * kept purely for responsive tracer feedback.
   */
  netMode = false;

  /** Net-owned enemies, keyed by server id so objects stay stable. */
  private netEnemies = new Map<number, Enemy>();

  /** Broad-phase grid for bullet-vs-enemy tests; rebuilt every tick. */
  spatialGrid: SpatialHash<Enemy>;
  perf: PerfMetrics = {
    fps: 0, frameMs: 0, simMs: 0, renderMs: 0,
    enemies: 0, bullets: 0, particles: 0, pickups: 0, gridCells: 0,
    quality: 'high', pooledObjects: 0,
  };

  // ---- event hooks (set by the host app) --------------------------------
  onScore?: (gained: number, combo: number) => void;
  onSound?: (name: SoundName) => void;
  onWave?: () => void;
  onLevel?: (level: number) => void;
  onUpgradePending?: () => void;
  onBomb?: () => void;

  // ---- internals ---------------------------------------------------------
  private bulletPool: Pool<Bullet>;
  private enemyPool: Pool<Enemy>;
  private pickupPool: Pool<Pickup>;
  private particlePool: Pool<Particle>;
  /** Reused across every projectile each tick — never reallocated. */
  private queryScratch: Enemy[] = [];
  private homingScratch: Enemy[] = [];
  private frameAccum = 0;
  private frameCount = 0;
  /** Rolling frame-time average used by the auto-tune watchdog. */
  private smoothedFrameMs = 1000 / TICK_RATE;

  constructor(quality: Quality = detectQuality()) {
    this.quality = quality;
    this.fx = resolveFx(quality);
    this.perf.quality = quality;

    this.bulletPool = new Pool<Bullet>(freshBullet, resetBullet, MAX_BULLETS);
    this.enemyPool = new Pool<Enemy>(freshEnemy, resetEnemy, MAX_ENEMIES);
    this.pickupPool = new Pool<Pickup>(freshPickup, resetPickup, MAX_PICKUPS);
    this.particlePool = new Pool<Particle>(freshParticle, resetParticle, this.fx.maxParticles);

    this.spatialGrid = new SpatialHash<Enemy>(this.W, this.H, this.fx.cellSize);
    this.scatterStars();
    this.startWave(1);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Re-scatters the parallax starfield for the current arena size. */
  private scatterStars(): void {
    this.stars.length = 0;
    for (let i = 0; i < 90; i++) this.stars.push({ x: Math.random() * this.W, y: Math.random() * this.H, z: rand(0.2, 1) });
  }

  toggleDebug(): void {
    this.debugMode = !this.debugMode;
  }

  /** Momentary frame freeze for heavy impacts (0.04s–0.12s). */
  triggerHitStop(duration: number): void {
    this.hitStopTimer = Math.max(this.hitStopTimer, duration);
  }

  snd(name: SoundName): void {
    this.onSound?.(name);
  }

  /**
   * Reshapes the arena to match the host viewport.
   *
   * The area is held at the tuned baseline and only the aspect changes, so a
   * 20:9 phone plays exactly as hard as a 16:10 desktop window — it simply
   * has a longer arena. Returns true when the arena actually changed.
   */
  setViewport(cssWidth: number, cssHeight: number): boolean {
    if (!(cssWidth > 0) || !(cssHeight > 0)) return false;
    const aspect = clamp(cssWidth / cssHeight, MIN_ASPECT, MAX_ASPECT);
    let w: number, h: number;
    if (aspect >= BASE_W / BASE_H) {
      w = Math.sqrt(BASE_AREA * aspect);
      h = w / aspect;
    } else {
      h = Math.sqrt(BASE_AREA / aspect);
      w = h * aspect;
    }
    // Ignore sub-pixel jitter from scrollbar / soft-keyboard transitions.
    if (Math.abs(w - this.W) < 1 && Math.abs(h - this.H) < 1) return false;

    const sx = w / this.W, sy = h / this.H;
    this.W = w;
    this.H = h;
    this.spatialGrid.resize(w, h);

    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i]!;
      s.x = clamp(s.x * sx, 0, w);
      s.y = clamp(s.y * sy, 0, h);
    }
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]!;
      e.x = clamp(e.x * sx, e.r, w - e.r);
      e.y = clamp(e.y * sy, e.r, h - e.r);
    }
    for (let i = 0; i < this.pickups.length; i++) {
      const k = this.pickups[i]!;
      k.x = clamp(k.x * sx, 0, w);
      k.y = clamp(k.y * sy, 0, h);
    }
    const p = this.player;
    p.x = clamp(p.x * sx, p.r, w - p.r);
    p.y = clamp(p.y * sy, p.r, h - p.r);
    return true;
  }

  /**
   * Switches quality tier. The particle pool is resized to the new ceiling;
   * live particles above the new cap are dropped, which is what the player
   * expects from a settings change (an immediate, visible simplification).
   */
  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.fx = resolveFx(quality);
    this.perf.quality = quality;
    this.spatialGrid.resize(this.W, this.H);
    this.particlePool = new Pool<Particle>(freshParticle, resetParticle, this.fx.maxParticles);
    if (this.particles.length > this.fx.maxParticles) {
      this.particles.length = this.fx.maxParticles;
    }
  }

  /**
   * Frame-time watchdog. Downgrades quality when the rolling frame time stays
   * above budget and the player has not pinned a tier manually.
   *
   * `budgetMs` is the per-frame allowance at the display refresh rate; the
   * downgrade threshold is 1.5x that, sustained for a second, so a single
   * hitch (GC, level load, thermal spike) never drops the tier.
   */
  autoTune(frameMs: number, budgetMs: number, pinned: boolean): void {
    this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * 0.05;
    if (pinned) return;
    if (this.smoothedFrameMs > budgetMs * 1.5) {
      if (this.quality === 'high') this.setQuality('medium');
      else if (this.quality === 'medium') this.setQuality('low');
    } else if (this.smoothedFrameMs < budgetMs * 0.7) {
      // Only climb back when there is real headroom, and never past the tier
      // the device was detected as.
      const ceiling = detectQuality();
      const order: Quality[] = ['low', 'medium', 'high'];
      if (order.indexOf(this.quality) < Math.min(2, order.indexOf(ceiling))) {
        this.setQuality(order[order.indexOf(this.quality) + 1]!);
      }
    }
  }

  /** Records one frame's timings for the debug overlay. */
  sampleFrame(frameMs: number, simMs: number, renderMs: number): void {
    this.perf.frameMs = frameMs;
    this.perf.simMs = simMs;
    this.perf.renderMs = renderMs;
    this.frameAccum += frameMs;
    this.frameCount++;
    if (this.frameAccum >= 500) {
      this.perf.fps = Math.round((this.frameCount * 1000) / this.frameAccum);
      this.frameAccum = 0;
      this.frameCount = 0;
    }
    const p = this.perf;
    p.enemies = this.enemies.length;
    p.bullets = this.bullets.length;
    p.particles = this.particles.length;
    p.pickups = this.pickups.length;
    p.gridCells = this.spatialGrid.getOccupiedBuckets().size;
    p.pooledObjects = this.bullets.length + this.enemies.length + this.particles.length + this.pickups.length;
  }

  /** Current smoothed frame time in ms, used by the host loop. */
  get averageFrameMs(): number {
    return this.smoothedFrameMs;
  }

  // =========================================================================
  // Pools
  // =========================================================================

  /** Takes a bullet from the pool. Returns null when the ceiling is reached. */
  spawnBullet(
    x: number, y: number, vx: number, vy: number,
    r: number, life: number, dmg: number, foe: boolean, color: string,
    homing = false,
  ): void {
    if (this.bullets.length >= MAX_BULLETS) return;
    const b = this.bulletPool.acquire();
    b.x = x; b.y = y; b.px = x; b.py = y;
    b.vx = vx; b.vy = vy;
    b.r = r; b.life = life; b.dmg = dmg; b.foe = foe; b.color = color;
    b.homing = homing;
    b.dead = false;
    this.bullets.push(b);
  }

  /** Takes a particle from the pool. Silently drops past the ceiling. */
  spawnParticle(
    x: number, y: number, vx: number, vy: number, life: number,
    r: number, color: string, glow: boolean,
    shape: Particle['shape'] = 'circle', spin = 0, spinV = 0,
  ): void {
    if (this.particles.length >= this.fx.maxParticles) return;
    const pt = this.particlePool.acquire();
    pt.x = x; pt.y = y; pt.vx = vx; pt.vy = vy;
    pt.life = life; pt.max = life; pt.r = r;
    pt.color = color; pt.glow = glow;
    pt.shape = shape; pt.spin = spin; pt.spinV = spinV;
    this.particles.push(pt);
  }

  /** Takes an enemy from the pool. Used by `enemies.ts`. */
  acquireEnemy(): Enemy {
    return this.enemyPool.acquire();
  }

  /** Takes a pickup from the pool. */
  acquirePickup(kind: PickupKind): Pickup {
    const k = this.pickupPool.acquire();
    k.kind = kind;
    k.t = 0;
    k.dead = false;
    return k;
  }

  /** Radial particle burst. Count is scaled by the quality profile. */
  burst(
    x: number, y: number, n: number, color: string,
    speed = 220, life = 0.5, glow = true, shape: Particle['shape'] = 'circle',
  ): void {
    const count = Math.ceil(n * this.fx.particleScale);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU, s = rand(speed * 0.2, speed);
      this.spawnParticle(
        x, y, Math.cos(a) * s, Math.sin(a) * s,
        life, rand(1.5, 4), color, glow, shape,
        Math.random() * TAU, rand(-8, 8),
      );
    }
  }

  /** Directional impact sparks that fly back along the bullet's path. */
  spark(x: number, y: number, dx: number, dy: number, color: string, n = 8): void {
    const count = Math.ceil(n * this.fx.particleScale);
    const base = Math.atan2(-dy, -dx);
    for (let i = 0; i < count; i++) {
      const a = base + rand(-0.7, 0.7);
      const s = rand(140, 340);
      this.spawnParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.4, rand(1, 2.5), color, true, 'spark');
    }
  }

  /** Expanding ring used for explosions, pickups, dashes and muzzle flashes. */
  shockwave(x: number, y: number, maxR: number, color: string, life = 0.5, width = 3, fill = false): void {
    this.shockwaves.push({ x, y, r: 0, maxR, life, maxLife: life, color, width, fill });
  }

  /** Floating text callout (score, status, unlocks). */
  pop(x: number, y: number, text: string, color: string, scale = 1): void {
    this.pops.push({ x, y, text, life: 1, max: 1, color, scale, vy: -55 });
  }

  // =========================================================================
  // Waves and progression
  // =========================================================================

  /** Enemies left before the wave is cleared: alive plus not yet spawned. */
  get waveEnemiesRemaining(): number {
    return this.enemies.length + this.enemiesRemainingInWave;
  }

  /**
   * Starts a wave: computes the roster, raises the level when the wave
   * crosses a tier boundary, and fires the announcement hook.
   */
  startWave(waveNum: number): void {
    this.wave = waveNum;
    const newLevel = Math.floor((waveNum - 1) / Game.WAVES_PER_LEVEL) + 1;
    const leveledUp = newLevel > this.level;
    this.level = newLevel;
    this.wavePauseTimer = 0;
    this.spawnTimer = 0.6;
    this.flash = 0.35;

    if (isBossWave(this)) {
      this.totalWaveEnemies = 1;
      this.enemiesRemainingInWave = 1;
      this.waveSpawningFinished = false;
      this.pop(this.W / 2, 120, `⚠ BOSS WARNING — LEVEL ${this.level} ⚠`, '#f43f5e', 2.0);
      this.shockwave(this.W / 2, 120, 300, '#f43f5e', 1.2, 6);
      this.snd('bossAppear');
      this.onWave?.();
      return;
    }

    this.totalWaveEnemies = rosterSize(this, waveNum);
    this.enemiesRemainingInWave = this.totalWaveEnemies;
    this.waveSpawningFinished = false;

    if (leveledUp) {
      this.pop(this.W / 2, this.H / 2 - 40, `LEVEL ${this.level}`, '#ffd166', 2.2);
      this.shockwave(this.W / 2, this.H / 2 - 40, 280, '#ffd166', 1, 4);
      this.snd('pickupPower');
      this.onLevel?.(this.level);
    } else {
      this.pop(this.W / 2, 120, `WAVE ${this.wave}`, '#7df9ff', 1.6);
      this.shockwave(this.W / 2, 120, 220, '#7df9ff', 0.9, 3);
      this.snd('wave');
      this.onWave?.();
    }
  }

  /**
   * Spawns the next queued enemy, respecting the concurrent cap. Enemies
   * still on the cap are deferred, never dropped.
   */
  private spawnWaveEnemy(): void {
    if (this.enemiesRemainingInWave <= 0) {
      this.waveSpawningFinished = true;
      return;
    }
    if (this.enemies.length >= maxConcurrentEnemies(this)) return;
    spawnEnemy(this);
    this.enemiesRemainingInWave--;
    if (this.enemiesRemainingInWave <= 0) this.waveSpawningFinished = true;
  }

  /**
   * Three random upgrade offers. Weapon cards stay locked until their
   * achievement unlocks them; an explicit `unlocked` list keeps this testable
   * without touching storage.
   */
  getAvailableUpgrades(unlocked?: readonly string[]): WeaponUpgrade[] {
    return pickUpgrades(unlocked ?? SaveManager.get().unlockedWeapons, 3);
  }

  /** Applies the chosen upgrade, then starts the next wave. */
  selectUpgrade(id: string): void {
    const option = this.upgradeOptions.find((u) => u.id === id);
    if (option) {
      option.apply(this);
      this.pop(this.player.x, this.player.y - 30, option.title, '#ffd166', 1.4);
      this.burst(this.player.x, this.player.y, 35, '#ffd166', 300, 0.6);
      this.shockwave(this.player.x, this.player.y, 90, '#ffd166', 0.5, 3);
      this.snd('pickupPower');
    }
    this.pendingUpgrade = false;
    this.upgradeOptions = [];
    this.startWave(this.wave + 1);
  }

  // =========================================================================
  // Run setup and teardown
  // =========================================================================

  /** Applies permanent hangar upgrades at the start of a run. */
  initRun(up?: Partial<HangarUpgrades>): void {
    const u = {
      healthLevel: up?.healthLevel ?? 0,
      speedLevel: up?.speedLevel ?? 0,
      bombLevel: up?.bombLevel ?? 0,
      creditMultiplier: up?.creditMultiplier ?? 0,
    };
    void u.creditMultiplier; // applied by SaveManager when crediting the run
    this.player.maxHp = 100 + u.healthLevel * 10;
    this.player.hp = this.player.maxHp;
    this.player.bombMax = 2 + u.bombLevel;
    this.player.bombCharges = this.player.bombMax;
    this.baseSpeedMult = 1 + u.speedLevel * 0.05;
  }

  /** Base credit reward for a finished run, before the multiplier. */
  baseCreditsEarned(): number {
    return Math.floor(this.score / 100) + this.kills;
  }

  /** Snapshot of this run's stats for `SaveManager.recordRun`. */
  runStats(): RunStats {
    return {
      finalScore: this.score,
      kills: this.kills,
      bossesKilled: this.bossesKilled,
      wavesCleared: Math.max(0, this.wave - 1),
    };
  }

  /**
   * On-canvas celebration for achievement unlocks. Called while the arena is
   * still visible, before the game-over overlay covers it.
   */
  celebrateAchievements(unlocked: { rewardWeaponName: string }[]): void {
    for (let i = 0; i < unlocked.length; i++) {
      this.pop(this.W / 2, this.H / 2 - 60 - i * 36, `🏆 UNLOCKED: ${unlocked[i]!.rewardWeaponName}!`, '#4ade80', 1.5);
    }
    if (unlocked.length > 0) this.snd('pickupPower');
  }

  // =========================================================================
  // Combat
  // =========================================================================

  damagePlayer(d: number): void {
    const p = this.player;
    if (p.iframe > 0 || p.dash > 0 || p.shield > 0) return;
    p.hp -= d;
    p.iframe = 0.9;
    this.triggerHitStop(0.05);
    this.shake = Math.min(30, this.shake + 18);
    this.flash = 0.55;
    this.combo = 1;
    this.comboTimer = 0;
    this.burst(p.x, p.y, 26, '#ff5e78', 320, 0.55);
    this.shockwave(p.x, p.y, 60, '#ff5e78', 0.4, 3);
    this.snd('hitPlayer');

    if (p.hp <= 0) {
      p.hp = 0;
      this.over = true;
      this.shake = 42;
      this.slowmo = 1;
      this.burst(p.x, p.y, 90, '#7dd3fc', 480, 1.1);
      this.burst(p.x, p.y, 50, '#ffffff', 320, 0.8);
      this.shockwave(p.x, p.y, 220, '#7dd3fc', 1.1, 5);
      this.shockwave(p.x, p.y, 150, '#ffffff', 0.9, 3);
      this.snd('gameOver');
    }
  }

  fire(): void {
    fireWeapon(this);
  }

  /**
   * Screen-clearing bomb. Destroys every live enemy, awarding score and combo
   * per kill. Returns false when there is no charge or the run is over.
   */
  bomb(): boolean {
    const p = this.player;
    if (p.bombCharges < 1 || this.over) return false;
    p.bombCharges -= 1;
    p.bombCd = 20;
    this.shake = Math.min(40, this.shake + 30);
    this.flash = 0.6;
    this.slowmo = 0.35;
    this.triggerHitStop(0.09);
    this.burst(p.x, p.y, 70, '#ffffff', 520, 0.7);
    this.burst(p.x, p.y, 50, '#7df9ff', 420, 0.9);
    this.shockwave(p.x, p.y, 340, '#7df9ff', 0.8, 5);
    this.shockwave(p.x, p.y, 260, '#ffffff', 0.6, 3);

    // Snapshot the length: killing a splitter appends its children to the same
    // array, and a live iterator would immediately destroy and score them too.
    const n = this.enemies.length;
    for (let i = 0; i < n; i++) {
      const e = this.enemies[i]!;
      if (e.dead) continue;
      e.dead = true;
      const isBig = e.kind === 'tank' || e.kind === 'boss';
      this.burst(e.x, e.y, isBig ? 40 : 20, e.color, 320, 0.55);
      this.burst(e.x, e.y, 12, '#ffffff', 240, 0.35);
      this.shockwave(e.x, e.y, isBig ? 140 : 80, e.color, isBig ? 0.7 : 0.5, isBig ? 4 : 3);
      if (e.kind === 'boss') this.bossesKilled++;
      this.awardKill(e);
    }
    this.snd('explodeBig');
    this.onBomb?.();
    return true;
  }

  /**
   * Shared kill bookkeeping: score, combo, splitter children, drop roll.
   * Used by both the bullet pass and the bomb so the two can never diverge.
   */
  private awardKill(e: Enemy): void {
    if (this.over) return;
    const gain = Math.round(e.score * this.combo);
    this.score += gain;
    this.kills++;
    const prevCombo = this.combo;
    this.combo = Math.min(9, this.combo + 1);
    this.comboTimer = 2.5;
    this.onScore?.(gain, this.combo);
    this.pop(
      e.x, e.y,
      `+${gain}${prevCombo > 1 ? ` x${prevCombo}` : ''}`,
      prevCombo > 1 ? '#ffd166' : '#e2e8f0',
      prevCombo >= 3 ? 1.4 : 1,
    );
    if (e.kind === 'splitter' && !e.mini) {
      // Children are free extras: they extend the wave but never split again.
      spawnEnemyAt(this, e.x + rand(-14, 14), e.y + rand(-14, 14), 'splitter', this.wave, true);
      spawnEnemyAt(this, e.x + rand(-14, 14), e.y + rand(-14, 14), 'splitter', this.wave, true);
    }
    if (Math.random() < 0.12 && this.pickups.length < MAX_PICKUPS) {
      const k = this.acquirePickup(rollPickupKind());
      k.x = e.x; k.y = e.y; k.vx = 0; k.vy = 0; k.r = 11;
      this.pickups.push(k);
    }
  }

  dash(): void {
    const p = this.player;
    if (p.dashCd > 0 || this.over) return;
    p.dashCd = 1.1;
    p.dash = 0.18;
    const a = p.angle;
    const mag = Math.hypot(p.vx, p.vy);
    const dx = mag > 40 ? p.vx / mag : Math.cos(a);
    const dy = mag > 40 ? p.vy / mag : Math.sin(a);
    p.vx = dx * 1400;
    p.vy = dy * 1400;
    this.burst(p.x, p.y, 24, '#38bdf8', 300, 0.45);
    this.shockwave(p.x, p.y, 70, '#38bdf8', 0.4, 3);
    this.shake = Math.min(20, this.shake + 6);
    this.snd('dash');
  }

  // =========================================================================
  // Tick
  // =========================================================================

  /**
   * Advances only the ambient visuals — no spawning, no combat, no damage.
   * Used behind the menu, pause and game-over screens so the world keeps
   * drifting and death animations finish instead of freezing mid-effect.
   */
  updateAmbient(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.033);
    this.time += dt;
    this.advanceStars(dt);
    this.decayRingFx(dt);
    this.advanceParticles(dt);
    this.advancePops(dt);
    this.compact();
    this.decayShake(dtRaw);
  }

  private advanceStars(dt: number): void {
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i]!;
      s.y += s.z * 22 * dt;
      if (s.y > this.H) { s.y = -2; s.x = Math.random() * this.W; }
    }
  }

  /** Ring / ghost effects run on frame time so they stay smooth in slow-mo. */
  private decayRingFx(frameDt: number): void {
    for (let i = 0; i < this.shockwaves.length; i++) {
      const sw = this.shockwaves[i]!;
      sw.life -= frameDt;
      const t = 1 - Math.max(0, sw.life / sw.maxLife);
      sw.r = sw.maxR * (1 - Math.pow(1 - t, 3));
    }
    for (let i = 0; i < this.ghosts.length; i++) this.ghosts[i]!.life -= frameDt;
  }

  private advanceParticles(dt: number): void {
    for (let i = 0; i < this.particles.length; i++) {
      const pt = this.particles[i]!;
      pt.life -= dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      const drag = Math.pow(0.25, dt);
      pt.vx *= drag;
      pt.vy *= drag;
      if (pt.spin !== undefined) pt.spin += (pt.spinV ?? 0) * dt;
    }
  }

  private advancePops(frameDt: number): void {
    for (let i = 0; i < this.pops.length; i++) {
      const q = this.pops[i]!;
      q.life -= frameDt;
      q.y += q.vy * frameDt;
      q.vy *= Math.pow(0.9, frameDt);
    }
  }

  private decayShake(frameDt: number): void {
    this.shake *= Math.pow(0.0025, frameDt);
    if (this.flash > 0) this.flash -= frameDt * 2.2;
  }

  /** In-place compaction of every transient list. Allocation free. */
  private compact(): void {
    sweepPooled(this.bullets, this.bulletPool);
    sweepPooled(this.enemies, this.enemyPool);
    sweepPooled(this.pickups, this.pickupPool);
    // Particles expire on `life`, not on a `dead` flag.
    sweepByPooled(this.particles, this.particlePool, (p) => p.life > 0);
    sweepBy(this.pops, (q) => q.life > 0);
    sweepBy(this.shockwaves, (s) => s.life > 0);
    sweepBy(this.ghosts, (g) => g.life > 0);
  }

  /**
   * Advances one gameplay step.
   *
   * `dtRaw` is clamped so a stalled tab or a GC pause cannot teleport
   * anything through a wall. Hit-stop short-circuits the whole step, which is
   * how heavy impacts read as weight.
   */
  update(dtRaw: number, input: Input): void {
    if (this.netMode) {
      this.updateNet(dtRaw, input);
      return;
    }
    const frameDt = Math.min(dtRaw, 0.033);

    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= frameDt;
      this.decayShake(frameDt);
      return;
    }

    const gameScale = this.slowmo > 0 ? 0.25 : 1;
    if (this.slowmo > 0) this.slowmo -= dtRaw;
    const gameDt = frameDt * gameScale;
    this.time += gameDt;

    this.advanceStars(gameDt);
    this.decayRingFx(frameDt);

    if (!this.over) {
      this.stepPlayer(gameDt, input);
      this.stepWaveProgression(gameDt);
    }

    this.advanceBullets(gameDt);
    updateEnemies(this, gameDt);
    this.resolveBulletHits();
    this.advancePickups(gameDt);
    this.advanceParticles(gameDt);
    this.advancePops(frameDt);

    this.compact();
    this.decayShake(frameDt);
  }

  /**
   * Networked step.
   *
   * Deliberately *not* a gameplay simulation:
   *   - the ship is moved by the prediction layer, not here, so there is
   *     exactly one integrator per frame
   *   - enemies, health and score arrive in snapshots
   *   - the local gun still fires tracers so the weapon feels instant, but
   *     nothing is resolved locally: the server decides every hit
   *
   * Everything that remains is cosmetic, which is why it can run even while
   * the socket is down and the player is effectively in a local sandbox.
   */
  private updateNet(dtRaw: number, input: Input): void {
    const frameDt = Math.min(dtRaw, 0.033);
    this.time += frameDt;
    const p = this.player;

    this.advanceStars(frameDt);
    this.decayRingFx(frameDt);

    if (!this.over) {
      // Aim keeps local responsiveness even though position is predicted.
      if (input.aim) {
        const a = Math.atan2(input.aim.y - p.y, input.aim.x - p.x);
        let d = a - p.angle;
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        p.angle += d * Math.min(1, frameDt * 26);
      }
      p.bob = (p.bob + frameDt * 4) % TAU;
      p.cd -= frameDt;
      if (input.firing && p.cd <= 0) {
        fireWeapon(this);
        p.cd = fireInterval(this);
      }
      if (p.shield > 0) p.shield -= frameDt;
      if (p.rapid > 0) p.rapid -= frameDt;
    }

    this.advanceBullets(frameDt);
    this.advanceParticles(frameDt);
    this.advancePops(frameDt);

    // Tracers and effects still need reaping; enemies are refreshed from the
    // network instead of swept here.
    sweepPooled(this.bullets, this.bulletPool);
    sweepByPooled(this.particles, this.particlePool, (p2) => p2.life > 0);
    sweepBy(this.pops, (q) => q.life > 0);
    sweepBy(this.shockwaves, (s) => s.life > 0);
    sweepBy(this.ghosts, (g2) => g2.life > 0);
    this.decayShake(frameDt);
  }

  /**
   * Switches between local and server-authoritative play.
   *
   * Leaving net mode clears the borrowed enemy field so the local spawner
   * starts from a clean arena rather than inheriting dead server entities.
   */
  setNetMode(on: boolean): void {
    if (this.netMode === on) return;
    this.netMode = on;
    if (on) {
      this.enemies.length = 0;
      this.bullets.length = 0;
      this.netEnemies.clear();
      this.moveTarget = null;
    } else {
      for (const e of this.netEnemies.values()) this.enemyPool.release(e);
      this.netEnemies.clear();
      this.enemies.length = 0;
      this.pendingUpgrade = false;
      this.upgradeOptions = [];
      this.startWave(this.wave);
    }
  }

  /**
   * Replaces the visible enemy field with the interpolated server state.
   *
   * Objects are pooled and keyed by server id, so a steady match performs no
   * allocation and each enemy keeps its identity (and therefore its spawn
   * animation) between frames.
   */
  syncRemoteEnemies(
    list: readonly { id: number; kind: EnemyKindId; x: number; y: number; r: number; hp: number; angle: number }[],
  ): void {
    if (!this.netMode) return;
    const live = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const w = list[i]!;
      live.add(w.id);
      let e = this.netEnemies.get(w.id);
      if (!e) {
        e = this.acquireEnemy();
        e.kind = w.kind;
        e.maxHp = Math.max(1, w.hp);
        e.hp = w.hp;
        e.color = ENEMY_COLORS[w.kind] ?? '#ff4d6d';
        e.level = 1;
        e.score = 0;
        e.r = w.r;
        // Start at zero scale so a new arrival pops in.
        e.pulse = 0;
        e.spin = 0;
        e.freeze = 0;
        e.hit = 0;
        e.cd = 99;
        e.mini = false;
        e.vx = 0;
        e.vy = 0;
        this.netEnemies.set(w.id, e);
        this.enemies.push(e);
      }
      e.x = w.x;
      e.y = w.y;
      e.r = w.r;
      e.hp = w.hp;
      e.pulse = Math.min(1, e.pulse + 0.05);
      // Enemies are drawn axis-aligned per the server's angle field.
      e.spin = w.angle;
    }
    // Retire ids the server no longer reports.
    for (const [id, e] of this.netEnemies) {
      if (live.has(id)) continue;
      this.netEnemies.delete(id);
      const idx = this.enemies.indexOf(e);
      if (idx >= 0) {
        this.enemies[idx] = this.enemies[this.enemies.length - 1]!;
        this.enemies.pop();
      }
      this.enemyPool.release(e);
    }
  }

  /** Applies the server's authoritative health for the local ship. */
  setNetHealth(hp: number, maxHp: number): void {
    this.player.hp = hp;
    this.player.maxHp = maxHp;
  }

  private stepPlayer(gameDt: number, input: Input): void {
    const p = this.player;

    // --- movement input: analog stick + keyboard, then click/tap target ---
    let mx = input.move.x, my = input.move.y;
    if (input.left) mx -= 1;
    if (input.right) mx += 1;
    if (input.up) my -= 1;
    if (input.down) my += 1;
    const manualActive = Math.hypot(mx, my) > 0.01;

    if (!manualActive && this.moveTarget) {
      const tdx = this.moveTarget.x - p.x;
      const tdy = this.moveTarget.y - p.y;
      const td = Math.hypot(tdx, tdy);
      if (td < 6) {
        this.moveTarget = null;
        mx = 0; my = 0;
      } else {
        // Ease in over the last 60 units so the ship does not oscillate.
        const s = Math.min(1, td / 60);
        mx = (tdx / td) * s;
        my = (tdy / td) * s;
      }
    } else if (manualActive) {
      this.moveTarget = null;
    }

    const m = Math.hypot(mx, my) || 1;
    if (m > 1) { mx /= m; my /= m; }
    integrateMovement(
      p, mx, my, gameDt, this.W, this.H,
      p.dash > 0 ? 1400 : 420 * this.baseSpeedMult,
    );

    p.bob = (p.bob + gameDt * 4) % TAU;

    if (p.dash > 0) {
      p.dash -= gameDt;
      this.spawnParticle(p.x, p.y, rand(-30, 30), rand(-30, 30), 0.35, 9, '#38bdf8', true, 'circle');
      if (Math.random() < 0.7) this.ghosts.push({ x: p.x, y: p.y, angle: p.angle, life: 0.4, max: 0.4 });
    }
    if (p.dashCd > 0) p.dashCd -= gameDt;
    if (p.iframe > 0) p.iframe -= gameDt;
    if (p.shield > 0) p.shield -= gameDt;
    if (p.rapid > 0) p.rapid -= gameDt;
    if (p.bombCharges < p.bombMax) {
      p.bombCd -= gameDt;
      if (p.bombCd <= 0) { p.bombCharges++; p.bombCd = 20; }
    }
    if (this.freezeTimer > 0) this.freezeTimer -= gameDt;

    // Aim rotates toward the requested point with a capped angular rate, so
    // the ship cannot whip around instantly.
    if (input.aim) {
      const a = Math.atan2(input.aim.y - p.y, input.aim.x - p.x);
      let d = a - p.angle;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      p.angle += d * Math.min(1, gameDt * 26);
    }

    // Fire control. The interval comes from the weapon so the fire-rate
    // upgrade is honoured instead of being overwritten here.
    p.cd -= gameDt;
    if (input.firing && p.cd <= 0) {
      fireWeapon(this);
      p.cd = fireInterval(this);
    }

    if (this.comboTimer > 0) {
      this.comboTimer -= gameDt;
      if (this.comboTimer <= 0) this.combo = 1;
    }
    if (this.powerTimer > 0) {
      this.powerTimer -= gameDt;
      if (this.powerTimer <= 0) this.power = 1;
    }
  }

  /**
   * Wave lifecycle: spawn on a timer, and when the roster and the arena are
   * both clear, award the clear bonus and offer the upgrade choice.
   */
  private stepWaveProgression(gameDt: number): void {
    if (this.pendingUpgrade) return; // paused between waves, waiting on the UI
    if (!this.waveSpawningFinished) {
      this.spawnTimer -= gameDt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = spawnInterval(this);
        this.spawnWaveEnemy();
      }
      return;
    }
    if (this.enemies.length > 0) return;

    this.pendingUpgrade = true;
    this.upgradeOptions = this.getAvailableUpgrades();
    this.pop(this.W / 2, this.H / 2 - 20, 'WAVE CLEARED!', '#4ade80', 1.8);
    this.shockwave(this.W / 2, this.H / 2 - 20, 200, '#4ade80', 0.8, 3);
    this.snd('pickupPower');
    this.onWave?.();
    // Flat clear bonus so patient play is rewarded.
    const bonus = 250 * this.wave * this.combo;
    this.score += bonus;
    this.pop(this.W / 2, this.H / 2 + 20, `CLEAR BONUS +${bonus}`, '#ffd166', 1.2);
    this.onUpgradePending?.();
  }

  private advanceBullets(gameDt: number): void {
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i]!;
      b.px = b.x;
      b.py = b.y;

      // Seeker projectiles steer toward the nearest enemy at a capped turn
      // rate, queried through the spatial hash so cost tracks local density.
      if (b.homing && !b.foe && !this.over) {
        const target = nearestEnemy(this.spatialGrid, b.x, b.y, 420, this.homingScratch);
        if (target) {
          const spd = Math.hypot(b.vx, b.vy);
          const want = Math.atan2(target.y - b.y, target.x - b.x);
          const cur = Math.atan2(b.vy, b.vx);
          let da = want - cur;
          while (da > Math.PI) da -= TAU;
          while (da < -Math.PI) da += TAU;
          const na = cur + Math.min(Math.abs(da), 4.5 * gameDt) * Math.sign(da);
          b.vx = Math.cos(na) * spd;
          b.vy = Math.sin(na) * spd;
        }
      }

      b.x += b.vx * gameDt;
      b.y += b.vy * gameDt;
      b.life -= gameDt;
      if (b.life <= 0 || b.x < -40 || b.x > this.W + 40 || b.y < -40 || b.y > this.H + 40) {
        b.dead = true;
      }
    }
  }

  /**
   * Projectile resolution.
   *
   * The grid is rebuilt once per tick and every projectile only tests the
   * cells its swept segment touches. Each projectile stops at the first
   * entity it hits (bullets do not pierce in this build).
   */
  private resolveBulletHits(): void {
    const p = this.player;
    this.spatialGrid.clear();
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]!;
      if (!e.dead) this.spatialGrid.insert(e);
    }

    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i]!;
      if (b.dead) continue;

      if (b.foe) {
        if (!this.over && segmentIntersectsCircle(b.px, b.py, b.x, b.y, p.x, p.y, b.r + p.r)) {
          b.dead = true;
          this.damagePlayer(b.dmg);
        }
        continue;
      }
      if (this.over) continue;

      const nearby = this.spatialGrid.query(b.x, b.y, b.r + 30, this.queryScratch);
      for (let k = 0; k < nearby.length; k++) {
        const e = nearby[k]!;
        if (e.dead) continue;
        if (!segmentIntersectsCircle(b.px, b.py, b.x, b.y, e.x, e.y, b.r + e.r)) continue;

        b.dead = true;
        e.hp -= b.dmg;
        e.hit = 0.12;
        e.vx += b.vx * 0.05;
        e.vy += b.vy * 0.05;
        this.burst(b.x, b.y, 6, '#bff9ff', 180, 0.28);
        this.spark(b.x, b.y, b.vx, b.vy, e.color, 8);

        if (e.hp > 0) {
          this.snd('hitEnemy');
        } else {
          this.killEnemy(e);
        }
        break;
      }
    }
  }

  /** Death feedback, scoring and drops for a single enemy. */
  private killEnemy(e: Enemy): void {
    e.dead = true;
    const isBoss = e.kind === 'boss';
    const isBig = e.kind === 'tank' || isBoss;
    // Hit-stop scales with the weight of the kill.
    if (isBoss) { this.triggerHitStop(0.12); this.bossesKilled++; }
    else if (e.kind === 'tank') this.triggerHitStop(0.045);

    this.shake = Math.min(35, this.shake + (isBoss ? 28 : isBig ? 16 : 7));
    this.burst(e.x, e.y, isBoss ? 90 : isBig ? 56 : 26, e.color, isBoss ? 500 : isBig ? 420 : 300, 0.8);
    this.shockwave(e.x, e.y, isBoss ? 220 : isBig ? 140 : 80, e.color, 0.7, 5);
    this.shockwave(e.x, e.y, isBig ? 90 : 50, '#ffffff', 0.35, 2);
    this.snd(isBig ? 'explodeBig' : 'explode');
    if (this.combo >= 4) this.snd('combo');
    this.awardKill(e);
  }

  private advancePickups(gameDt: number): void {
    const p = this.player;
    for (let i = 0; i < this.pickups.length; i++) {
      const k = this.pickups[i]!;
      k.t += gameDt;
      const dx = p.x - k.x, dy = p.y - k.y;
      const d = Math.hypot(dx, dy) || 1;
      // Magnet radius: pickups drift toward the ship once it is close.
      if (d < 130) {
        k.vx += (dx / d) * 600 * gameDt;
        k.vy += (dy / d) * 600 * gameDt;
      }
      const drag = Math.pow(0.1, gameDt);
      k.vx *= drag;
      k.vy *= drag;
      k.x += k.vx * gameDt;
      k.y += k.vy * gameDt;

      if (d < k.r + p.r && !this.over) {
        k.dead = true;
        this.collectPickup(k);
      }
      if (k.t > 14) k.dead = true;
    }
  }

  private collectPickup(k: Pickup): void {
    const p = this.player;
    switch (k.kind) {
      case 'health': {
        p.hp = Math.min(p.maxHp, p.hp + 25);
        this.pop(k.x, k.y, '+HP', '#4ade80');
        this.burst(k.x, k.y, 22, '#4ade80', 240, 0.55);
        this.shockwave(k.x, k.y, 50, '#4ade80', 0.4, 2);
        this.snd('pickupHealth');
        break;
      }
      case 'power': {
        this.power = Math.min(3, this.power + 1);
        this.powerTimer = 12;
        this.pop(k.x, k.y, 'POWER UP', '#ffd166', 1.3);
        this.burst(k.x, k.y, 28, '#ffd166', 280, 0.55);
        this.shockwave(k.x, k.y, 60, '#ffd166', 0.45, 2);
        this.snd('pickupPower');
        break;
      }
      case 'shield': {
        p.shield = 6;
        this.pop(k.x, k.y, 'SHIELD', '#38bdf8', 1.2);
        this.burst(k.x, k.y, 24, '#38bdf8', 260, 0.5);
        this.shockwave(k.x, k.y, 55, '#38bdf8', 0.45, 2);
        this.snd('pickupPower');
        break;
      }
      case 'rapid': {
        p.rapid = 8;
        this.pop(k.x, k.y, 'RAPID FIRE', '#f472b6', 1.2);
        this.burst(k.x, k.y, 24, '#f472b6', 260, 0.5);
        this.shockwave(k.x, k.y, 55, '#f472b6', 0.45, 2);
        this.snd('pickupPower');
        break;
      }
      case 'freeze': {
        this.freezeTimer = 3.5;
        this.pop(k.x, k.y, 'FREEZE', '#a5f3fc', 1.2);
        this.burst(k.x, k.y, 30, '#a5f3fc', 260, 0.55);
        this.shockwave(k.x, k.y, 260, '#a5f3fc', 0.6, 2);
        this.snd('pickupPower');
        break;
      }
    }
  }

  // =========================================================================
  // Render
  // =========================================================================

  render(ctx: CanvasRenderingContext2D): void {
    renderGame(this, ctx);
  }
}

// ---------------------------------------------------------------------------
// Pool factories
// ---------------------------------------------------------------------------

function freshBullet(): Bullet {
  return { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, r: 0, life: 0, dmg: 0, foe: false, color: '#fff', homing: false, dead: false };
}

function resetBullet(b: Bullet): void {
  b.dead = false;
  b.homing = false;
  b.foe = false;
}

function freshParticle(): Particle {
  return { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, r: 0, color: '#fff', glow: true, shape: 'circle', spin: 0, spinV: 0 };
}

function resetParticle(p: Particle): void {
  p.life = 0;
}

function freshEnemy(): Enemy {
  return {
    x: 0, y: 0, vx: 0, vy: 0, r: 0, dead: false,
    hp: 0, maxHp: 0, kind: 'grunt', color: '#fff', hit: 0,
    score: 0, cd: 0, spin: 0, mini: false, freeze: 0, level: 1, pulse: 0, spd: 1,
  };
}

function resetEnemy(e: Enemy): void {
  e.dead = false;
  e.phase = undefined;
  e.phaseTimer = undefined;
  e.spiralAngle = undefined;
}

function freshPickup(): Pickup {
  return { x: 0, y: 0, vx: 0, vy: 0, r: 11, kind: 'health', t: 0, dead: false };
}

function resetPickup(k: Pickup): void {
  k.dead = false;
  k.vx = 0;
  k.vy = 0;
  k.t = 0;
}

export { PICKUP_COLOR };
