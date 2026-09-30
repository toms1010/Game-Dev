/**
 * Neon Vanguard — enemy roster, spawning and AI.
 *
 * Everything that decides where an enemy goes and when it shoots lives here.
 * The engine owns the tick order and the projectile pass; this module owns
 * the creatures.
 */

import { ENEMY_CONFIG, WAVES_PER_LEVEL, rand, type Enemy, type EnemyKind } from './entities';
import type { Game } from './engine';

export { WAVES_PER_LEVEL };

/** Difficulty tier is now driven purely by level, not by the wave number. */
export const isBossLevel = (level: number): boolean => level === 5 || level === 10;

/** True when this is the first wave of a level, i.e. the boss slot. */
export function isBossWave(game: Game): boolean {
  return isBossLevel(game.level) && (game.wave - 1) % WAVES_PER_LEVEL === 0;
}

/**
 * Concurrent enemy cap. Scales with the wave and the difficulty level, then
 * is trimmed on low-end devices so the frame budget survives a swarm.
 */
export function maxConcurrentEnemies(game: Game): number {
  const base = Math.min(35, 4 + game.wave * 3 + game.level * 2);
  return Math.max(4, Math.round(base * game.fx.enemyCapScale));
}

/** Seconds between spawns inside a wave. */
export function spawnInterval(game: Game): number {
  return Math.max(0.28, 1.25 - game.wave * 0.08 - (game.level - 1) * 0.05);
}

const config = (kind: EnemyKind) => ENEMY_CONFIG[kind];

/**
 * Spawns one enemy of a given kind at an explicit position.
 *
 * `mini` marks splitter children: they are half size, do not count toward the
 * wave roster and do not split again, which is what makes them cheap chaff
 * rather than an exponential chain.
 */
export function spawnEnemyAt(
  game: Game,
  x: number, y: number, kind: EnemyKind, wave: number, mini = false,
): void {
  const level = game.level;
  const cfg = config(kind);

  // Boss health scales only with the level, so a boss tier always feels like
  // a boss regardless of which wave it lands on.
  const levelMult = 1 + (level - 1) * 0.4;
  const hp = kind === 'boss'
    ? Math.round(cfg.hp * (1 + (level - 5) * 0.5))
    : Math.round((cfg.hp + wave * 4) * levelMult * (1 + (level - 1) * 0.1));

  const e = game.acquireEnemy();
  e.x = x; e.y = y; e.vx = 0; e.vy = 0;
  e.hit = 0; e.cd = rand(1, 2.5); e.spin = 0; e.freeze = 0; e.pulse = 0;
  e.kind = kind; e.level = level;
  e.r = cfg.r + (level - 1);
  e.hp = hp; e.maxHp = hp;
  e.color = cfg.color;
  e.score = Math.round(cfg.score * (1 + (level - 1) * 0.25));
  e.mini = mini;
  e.spd = 1 + (level - 1) * 0.04;      // captured at spawn; level is immutable while alive
  e.dead = false;

  if (kind === 'boss') {
    e.cd = 1.2;
    e.phase = 0;
    e.phaseTimer = 3.2;
    e.spiralAngle = 0;
  } else {
    e.phase = undefined;
    e.phaseTimer = undefined;
    e.spiralAngle = undefined;
  }

  if (mini) {
    e.r *= 0.6;
    e.hp *= 0.45;
    e.maxHp = e.hp;
    e.score = Math.round(e.score * 0.4);
  }
  game.enemies.push(e);
}

/**
 * Spawns the next enemy of the current wave from a random edge.
 *
 * Enemy tiers unlock progressively, so early waves stay readable and the
 * roster widens as the player survives.
 */
export function spawnEnemy(game: Game): void {
  // A boss wave is a single encounter: the boss, nothing else.
  if (isBossWave(game) && !game.waveSpawningFinished) {
    spawnEnemyAt(game, game.W / 2, -60, 'boss', game.wave);
    game.enemiesRemainingInWave--;
    if (game.enemiesRemainingInWave <= 0) game.waveSpawningFinished = true;
    return;
  }

  const side = (Math.random() * 4) | 0;
  let x = 0, y = 0;
  if (side === 0) { x = rand(0, game.W); y = -30; }
  else if (side === 1) { x = game.W + 30; y = rand(0, game.H); }
  else if (side === 2) { x = rand(0, game.W); y = game.H + 30; }
  else { x = -30; y = rand(0, game.H); }

  const roll = Math.random();
  const w = game.wave;
  // Each tier's odds improve (its threshold falls) as the level rises, so a
  // later wave is dominated by the nastier archetypes.
  const tankOdds = Math.max(0.955, 0.97 - (game.level - 1) * 0.006);
  const healerOdds = Math.max(0.905, 0.945 - (game.level - 1) * 0.008);
  const shooterOdds = Math.max(0.84, 0.90 - (game.level - 1) * 0.012);
  const splitterOdds = Math.max(0.74, 0.84 - (game.level - 1) * 0.02);
  const rusherOdds = Math.max(0.6, 0.72 - (game.level - 1) * 0.024);

  let kind: EnemyKind = 'grunt';
  if (w > 6 && roll > tankOdds) kind = 'tank';
  else if (w > 5 && roll > healerOdds) kind = 'healer';
  else if (w > 4 && roll > shooterOdds) kind = 'shooter';
  else if (w > 3 && roll > splitterOdds) kind = 'splitter';
  else if (w > 2 && roll > rusherOdds) kind = 'rusher';
  spawnEnemyAt(game, x, y, kind, w);
}

/** Pushes an enemy toward the player, capped at its tier speed. */
function steerEnemy(e: Enemy, dx: number, dy: number, d: number, speed: number, dt: number): void {
  // Ranged archetypes keep their distance instead of closing in.
  const isRanged = e.kind === 'shooter' || e.kind === 'healer';
  if (isRanged && d < 330) {
    e.vx += (-dx / d) * 200 * dt;
    e.vy += (-dy / d) * 200 * dt;
  } else {
    e.vx += (dx / d) * speed * 4 * dt;
    e.vy += (dy / d) * speed * 4 * dt;
  }
  const es = Math.hypot(e.vx, e.vy);
  if (es > speed) { e.vx = (e.vx / es) * speed; e.vy = (e.vy / es) * speed; }
}

/** Shooters fan out a short burst of purple bolts at the player. */
function updateShooter(game: Game, e: Enemy, dx: number, dy: number, dt: number): void {
  e.cd -= dt;
  if (e.cd > 0) return;
  e.cd = Math.max(0.9, rand(1.6, 2.6) - (e.level - 1) * 0.1);
  const a = Math.atan2(dy, dx);
  const count = e.level >= 3 ? 5 : 3;
  for (let i = 0; i < count; i++) {
    const aa = a + (i - (count - 1) / 2) * 0.18;
    game.spawnBullet(e.x, e.y, Math.cos(aa) * 320, Math.sin(aa) * 320, 5, 3, 10, true, '#c084fc');
  }
}

/** Healers top up nearby wounded enemies in a small radius. */
function updateHealer(game: Game, e: Enemy, dt: number): void {
  e.cd -= dt;
  if (e.cd > 0) return;
  e.cd = rand(2, 3);
  for (const other of game.enemies) {
    if (other === e || other.dead) continue;
    const dd = Math.hypot(other.x - e.x, other.y - e.y);
    if (dd < 140 && other.hp < other.maxHp) {
      other.hp = Math.min(other.maxHp, other.hp + other.maxHp * 0.25);
      game.burst(other.x, other.y, 6, '#4ade80', 100, 0.4, false);
    }
  }
  game.burst(e.x, e.y, 10, '#4ade80', 60, 0.5, false);
}

/**
 * Boss AI — a three-phase rotating state machine:
 *   0 SPIRAL NOVA  twin counter-rotating radial streams
 *   1 RING BURST   a dense 360° ring of fast bolts
 *   2 SHOTGUN      a high-velocity five-way spread aimed at the player
 */
function updateBoss(game: Game, e: Enemy, dx: number, dy: number, dt: number): void {
  e.phaseTimer = (e.phaseTimer ?? 0) - dt;
  if (e.phaseTimer <= 0) {
    e.phase = ((e.phase ?? 0) + 1) % 3;
    e.phaseTimer = 3.2;            // seconds per phase
    e.cd = 0.3;                    // first attack of a new phase lands quickly
    game.shockwave(e.x, e.y, 130, '#a855f7', 0.5, 4);
  }

  const phase = e.phase ?? 0;

  if (phase === 0) {
    e.spiralAngle = (e.spiralAngle ?? 0) + dt * 2.6;
    e.cd -= dt;
    if (e.cd <= 0) {
      e.cd = 0.09;
      for (let k = 0; k < 2; k++) {
        const a = (e.spiralAngle ?? 0) + k * Math.PI;
        game.spawnBullet(e.x, e.y, Math.cos(a) * 200, Math.sin(a) * 200, 5, 4, 12, true, '#c084fc');
      }
    }
    return;
  }

  e.cd -= dt;
  if (e.cd > 0) return;

  if (phase === 1) {
    const ringCount = 16 + e.level * 4;
    for (let i = 0; i < ringCount; i++) {
      const angle = (i / ringCount) * Math.PI * 2 + (e.spiralAngle ?? 0);
      game.spawnBullet(e.x, e.y, Math.cos(angle) * 280, Math.sin(angle) * 280, 6, 4, 14, true, '#c084fc');
    }
    game.shockwave(e.x, e.y, 110, '#a855f7', 0.4, 4);
    game.snd('explode');
    e.cd = Math.max(1.2, 2.8 - e.level * 0.2);
  } else {
    const baseAngle = Math.atan2(dy, dx);
    for (let i = -2; i <= 2; i++) {
      const angle = baseAngle + i * 0.15;
      game.spawnBullet(e.x, e.y, Math.cos(angle) * 420, Math.sin(angle) * 420, 7, 3, 18, true, '#f43f5e');
    }
    game.shockwave(e.x, e.y, 80, '#f43f5e', 0.35, 3);
    game.snd('enemyShooter');
    e.cd = Math.max(0.8, 1.6 - e.level * 0.1);
  }
}

/**
 * Advances every enemy: timers, steering, archetype behaviour, integration
 * and contact damage against the player.
 *
 * Iterates by index over a length snapshot because contact damage and
 * splitter deaths can append to `game.enemies` mid-loop.
 */
export function updateEnemies(game: Game, dt: number): void {
  const p = game.player;
  const frozenAll = game.freezeTimer > 0;

  for (let i = 0, n = game.enemies.length; i < n; i++) {
    const e = game.enemies[i]!;
    e.spin += dt * 2;
    e.pulse += dt;
    if (e.hit > 0) e.hit -= dt;
    if (e.freeze > 0) e.freeze -= dt;

    const dx = p.x - e.x, dy = p.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const speed = (config(e.kind).speed + game.wave * 3)
      * (1 + (e.level - 1) * 0.08)
      * (e.spd ?? 1);
    const isFrozen = frozenAll || e.freeze > 0;

    if (!game.over && !isFrozen) {
      steerEnemy(e, dx, dy, d, speed, dt);
      if (e.kind === 'boss') updateBoss(game, e, dx, dy, dt);
      else if (e.kind === 'shooter') updateShooter(game, e, dx, dy, dt);
      else if (e.kind === 'healer') updateHealer(game, e, dt);
    } else if (isFrozen) {
      e.vx *= 0.9; e.vy *= 0.9;
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    // Contact damage, tested after integration so a fast enemy cannot skip
    // past the player between frames.
    if (!game.over) {
      const cdx = p.x - e.x, cdy = p.y - e.y;
      const cd = Math.hypot(cdx, cdy) || 1;
      if (cd < e.r + p.r) {
        game.damagePlayer(config(e.kind).damage);
        e.vx = (-cdx / cd) * 260;
        e.vy = (-cdy / cd) * 260;
      }
    }
  }
}

/** Total enemies the given wave will send, roster included. */
export function rosterSize(game: Game, waveNum: number): number {
  return Math.round(8 + waveNum * 4 + game.level * 3);
}
