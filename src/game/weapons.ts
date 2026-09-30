/**
 * Neon Vanguard — weapons, fire control and the wave-clear upgrade catalog.
 *
 * Owns the numbers that decide what a shot does. The engine calls
 * `fireWeapon()` from the fixed-step update and `pickUpgrades()` when a wave
 * clears, so weapon balance lives in exactly one place.
 */

import { rand, type WeaponType, type WeaponUpgrade } from './entities';
import type { Game } from './engine';

export type { WeaponType, WeaponUpgrade };

/** Per-weapon muzzle geometry and ballistics. */
export interface WeaponStats {
  label: string;
  tag: string;
  /** Base damage before the HIGH CALIBER damage levels. */
  damage: number;
  /** Multiplier on the bullet speed derived from bullet speed levels. */
  speedMult: number;
  /** Projectile radius and lifetime in seconds. */
  radius: number;
  life: number;
  color: string;
  /** Angular half-width of a single pellet in a multi-pellet cone (radians). */
  pelletSpread: number;
  /** How many pellets a single trigger pull emits. */
  pellets: number;
  /** Random angular jitter added per pellet, for a hand-built feel. */
  jitter: number;
  homing: boolean;
}

export const WEAPON_STATS: Record<WeaponType, WeaponStats> = {
  blaster: {
    label: 'PULSE BLASTER', tag: 'BLASTER',
    damage: 12, speedMult: 1, radius: 4, life: 1.1, color: '#7df9ff',
    pelletSpread: 0, pellets: 1, jitter: 0.03, homing: false,
  },
  spread: {
    label: 'TRI-SPREAD CANNON', tag: 'SPREAD',
    damage: 12, speedMult: 1, radius: 4, life: 1.1, color: '#f472b6',
    pelletSpread: 0.2, pellets: 3, jitter: 0.02, homing: false,
  },
  homing: {
    label: 'SEEKER MISSILES', tag: 'HOMING',
    damage: 12, speedMult: 0.85, radius: 5, life: 1.6, color: '#ffd166',
    pelletSpread: 0, pellets: 1, jitter: 0.25, homing: true,
  },
};

export const MUZZLE_COLOR = '#bff9ff';

/** Damage per pellet after the HIGH CALIBER damage levels are applied. */
export function pelletDamage(game: Game): number {
  return Math.round(WEAPON_STATS[game.weapon].damage * (1 + (game.damageLevel - 1) * 0.3));
}

/** Muzzle velocity after the VELOCITY DRIVE bullet speed levels are applied. */
export function bulletSpeed(game: Game): number {
  return 780 * (1 + (game.bulletSpeedLevel - 1) * 0.3);
}

/**
 * Seconds between trigger pulls — the single source of truth for fire rate.
 *
 * Both the weapon and the engine's cooldown gate read this, so the RAPID
 * TRIGGER upgrade cannot be silently overwritten after the shot is fired.
 */
export function fireInterval(game: Game): number {
  // More power-up streams cycle the blaster slightly faster.
  let base = game.power >= 3 ? 0.075 : 0.09;
  base /= 1 + (game.fireRateLevel - 1) * 0.25;
  if (game.player.rapid > 0) base *= 0.45;
  return base;
}

/** Emits one trigger pull: pellets, muzzle flash and recoil. */
export function fireWeapon(game: Game): void {
  const p = game.player;
  const ang = p.angle;
  const stats = WEAPON_STATS[game.weapon];
  const dmg = pelletDamage(game);
  const speed = bulletSpeed(game) * stats.speedMult;
  // Power-up pickups stack extra parallel streams on top of any weapon.
  const streams = game.power >= 3 ? 3 : game.power >= 2 ? 2 : 1;
  // Multi-pellet weapons widen the gap between stacked streams so the cone
  // stays readable instead of collapsing into one blob.
  const streamSpread = stats.pellets > 1 ? 0.3 : 0.14;
  // A cone spreads its damage, so each pellet carries less than a focused shot.
  const perPellet = Math.round(dmg * (stats.pellets > 1 ? 0.85 : 1));

  for (let i = 0; i < streams; i++) {
    const stream = ang + (streams === 1 ? 0 : (i - (streams - 1) / 2) * streamSpread);
    for (let j = 0; j < stats.pellets; j++) {
      const offset = stats.pellets === 1 ? 0 : (j - (stats.pellets - 1) / 2) * stats.pelletSpread;
      const a = stream + offset + rand(-stats.jitter, stats.jitter);
      const cos = Math.cos(a), sin = Math.sin(a);
      game.spawnBullet(
        p.x + cos * 18, p.y + sin * 18,
        cos * speed, sin * speed,
        stats.radius, stats.life,
        perPellet, false, stats.color,
        stats.homing,
      );
    }
  }

  // Recoil + muzzle feedback.
  const mx = p.x + Math.cos(ang) * 22;
  const my = p.y + Math.sin(ang) * 22;
  game.burst(mx, my, 5, MUZZLE_COLOR, 220, 0.22);
  game.shockwave(mx, my, 22, MUZZLE_COLOR, 0.18, 2);
  p.vx -= Math.cos(ang) * 30;
  p.vy -= Math.sin(ang) * 30;
  game.shake = Math.min(14, game.shake + 1.8);
  game.snd('shoot');
}

/**
 * The full wave-clear reward pool.
 *
 * Weapon unlocks stay hidden until the matching achievement is earned; stat
 * upgrades are always offered. Unlocks are passed in so tests can supply an
 * explicit list instead of touching storage.
 */
export const UPGRADE_CATALOG: WeaponUpgrade[] = [
  {
    id: 'fire_rate', title: '⚡ RAPID TRIGGER', description: '+25% firing speed',
    weapon: null, tag: 'RATE',
    apply: (g) => { g.fireRateLevel += 1; },
  },
  {
    id: 'damage', title: '💥 HIGH CALIBER', description: '+30% bullet damage',
    weapon: null, tag: 'DMG',
    apply: (g) => { g.damageLevel += 1; },
  },
  {
    id: 'bullet_speed', title: '🚀 VELOCITY DRIVE', description: '+30% bullet velocity & range',
    weapon: null, tag: 'VEL',
    apply: (g) => { g.bulletSpeedLevel += 1; },
  },
  {
    id: 'spread_weapon', title: '🔱 TRI-SPREAD CANNON', description: '3-way spread shot',
    weapon: 'spread', tag: 'SPREAD',
    apply: (g) => { g.weapon = 'spread'; },
  },
  {
    id: 'homing_weapon', title: '🎯 SEEKER MISSILES', description: 'Auto-homing projectiles',
    weapon: 'homing', tag: 'HOMING',
    apply: (g) => { g.weapon = 'homing'; },
  },
  {
    id: 'plasma_beam', title: '🔥 PLASMA LANCE', description: 'Piercing heavy shots',
    weapon: 'blaster', tag: 'PLASMA',
    apply: (g) => { g.weapon = 'blaster'; g.damageLevel += 2; g.fireRateLevel += 1; },
  },
];

const WEAPON_UNLOCK_IDS = new Set(['spread_weapon', 'homing_weapon', 'plasma_beam']);

/**
 * Three distinct offers from the pool.
 *
 * Partial Fisher–Yates over a copied list, so the shared catalog is never
 * reordered between calls.
 */
export function pickUpgrades(unlockedWeaponIds: readonly string[], count = 3): WeaponUpgrade[] {
  const unlocked = new Set(unlockedWeaponIds);
  const pool = UPGRADE_CATALOG.filter((o) => !WEAPON_UNLOCK_IDS.has(o.id) || unlocked.has(o.id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, Math.min(count, pool.length));
}
