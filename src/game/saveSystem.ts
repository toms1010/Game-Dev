// Neon Vanguard — Hangar persistence (permanent upgrades, credits, achievements).
// Web + WebView implementation backed by localStorage. Guarded so importing
// it on native (no localStorage) safely falls back to in-memory defaults.

export interface HangarUpgrades {
  healthLevel: number;     // +10 max HP per level
  speedLevel: number;      // +5% movement speed per level
  bombLevel: number;       // +1 starting bomb charge per level
  creditMultiplier: number;// +10% credits earned per level
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  target: number;
  /** Engine WeaponUpgrade id unlocked upon completion. */
  rewardWeapon: string;
  rewardWeaponName: string;
}

export interface SaveData {
  highScore: number;
  credits: number;
  totalKills: number;
  bossesDefeated: number;
  wavesCleared: number;
  /** Deployments completed. Drives the kills-per-deployment statistic. */
  gamesPlayed: number;
  upgrades: HangarUpgrades;
  unlockedWeapons: string[];
  completedAchievements: string[];
}

const SAVE_KEY = 'neon_vanguard_save_v1';

// Base unlocked weapons
const DEFAULT_UNLOCKED_WEAPONS = ['blaster'];

const DEFAULT_SAVE: SaveData = {
  highScore: 0,
  credits: 0,
  totalKills: 0,
  bossesDefeated: 0,
  wavesCleared: 0,
  gamesPlayed: 0,
  upgrades: {
    healthLevel: 0,
    speedLevel: 0,
    bombLevel: 0,
    creditMultiplier: 0,
  },
  unlockedWeapons: DEFAULT_UNLOCKED_WEAPONS,
  completedAchievements: [],
};

// --- Achievement definitions & unlock criteria ---
// rewardWeapon ids must match engine WeaponUpgrade ids.
export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_blood',
    title: 'FIRST BLOOD',
    description: 'Eliminate 50 total enemies',
    target: 50,
    rewardWeapon: 'spread_weapon',
    rewardWeaponName: 'Tri-Spread Cannon',
  },
  {
    id: 'boss_slayer',
    title: 'BOSS SLAYER',
    description: 'Defeat your first Level Boss',
    target: 1,
    rewardWeapon: 'plasma_beam',
    rewardWeaponName: 'Plasma Lance',
  },
  {
    id: 'score_master',
    title: 'SCORE MASTER',
    description: 'Reach a High Score of 25,000 points',
    target: 25000,
    rewardWeapon: 'homing_weapon',
    rewardWeaponName: 'Seeker Missiles',
  },
];

// --- Upgrade costs & scaling ---
export const UPGRADE_CONFIG = {
  healthLevel: { name: 'Hull Integrity', baseCost: 100, costMult: 1.5, max: 10, bonusPerLevel: 10 },
  speedLevel: { name: 'Engine Thrusters', baseCost: 150, costMult: 1.6, max: 5, bonusPerLevel: 0.05 },
  bombLevel: { name: 'Extra Ordnance', baseCost: 500, costMult: 2.5, max: 2, bonusPerLevel: 1 },
  creditMultiplier: { name: 'Scrap Collector', baseCost: 200, costMult: 1.8, max: 5, bonusPerLevel: 0.1 },
} as const;

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function cloneDefault(): SaveData {
  return {
    highScore: 0,
    credits: 0,
    totalKills: 0,
    bossesDefeated: 0,
    wavesCleared: 0,
    gamesPlayed: 0,
    upgrades: { ...DEFAULT_SAVE.upgrades },
    unlockedWeapons: [...DEFAULT_SAVE.unlockedWeapons],
    completedAchievements: [],
  };
}

export interface RunStats {
  finalScore: number;
  kills: number;
  bossesKilled: number;
  wavesCleared: number;
}

export class SaveManager {
  private static data: SaveData = SaveManager.load();

  /** Load save data from localStorage (deep-merged over defaults, migrates old saves). */
  static load(): SaveData {
    if (!hasStorage()) return cloneDefault();
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return cloneDefault();
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      return {
        highScore: typeof parsed.highScore === 'number' ? parsed.highScore : 0,
        credits: typeof parsed.credits === 'number' ? parsed.credits : 0,
        totalKills: typeof parsed.totalKills === 'number' ? parsed.totalKills : 0,
        bossesDefeated: typeof parsed.bossesDefeated === 'number' ? parsed.bossesDefeated : 0,
        wavesCleared: typeof parsed.wavesCleared === 'number' ? parsed.wavesCleared : 0,
        gamesPlayed: typeof parsed.gamesPlayed === 'number' ? parsed.gamesPlayed : 0,
        upgrades: {
          healthLevel: parsed.upgrades?.healthLevel ?? 0,
          speedLevel: parsed.upgrades?.speedLevel ?? 0,
          bombLevel: parsed.upgrades?.bombLevel ?? 0,
          creditMultiplier: parsed.upgrades?.creditMultiplier ?? 0,
        },
        unlockedWeapons: Array.isArray(parsed.unlockedWeapons) && parsed.unlockedWeapons.length > 0
          ? parsed.unlockedWeapons.filter((w): w is string => typeof w === 'string')
          : [...DEFAULT_UNLOCKED_WEAPONS],
        completedAchievements: Array.isArray(parsed.completedAchievements)
          ? parsed.completedAchievements.filter((a): a is string => typeof a === 'string')
          : [],
      };
    } catch (e) {
      console.warn('[SaveManager] Failed to load save file:', e);
      return cloneDefault();
    }
  }

  /** Persist current save data to localStorage. */
  static save(): void {
    if (!hasStorage()) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(SaveManager.data));
    } catch (e) {
      console.warn('[SaveManager] Failed to persist save file:', e);
    }
  }

  /** Reset to defaults (used by tests / settings). */
  static reset(): void {
    SaveManager.data = cloneDefault();
    SaveManager.save();
  }

  static get(): SaveData {
    return SaveManager.data;
  }

  /** Credits earned for a run: 1 per 100 score + 1 per kill, scaled by Scrap Collector. */
  static creditsForRun(score: number, kills: number): number {
    const base = Math.floor(score / 100) + kills;
    const mult = 1 + SaveManager.data.upgrades.creditMultiplier * UPGRADE_CONFIG.creditMultiplier.bonusPerLevel;
    return Math.round(base * mult);
  }

  /**
   * Records completed run stats and checks for newly unlocked achievements.
   * Returns newly unlocked achievements to display in game UI.
   */
  static recordRun(runStats: RunStats): { newHighScore: boolean; creditsEarned: number; unlockedAchievements: Achievement[] } {
    const data = SaveManager.data;
    let newHighScore = false;

    // Accumulate lifetime stats
    data.totalKills += runStats.kills;
    data.bossesDefeated += runStats.bossesKilled;
    data.wavesCleared += runStats.wavesCleared;

    // Earned credits (Scrap Collector multiplier applied)
    const creditsEarned = SaveManager.creditsForRun(runStats.finalScore, runStats.kills);
    data.credits += creditsEarned;

    if (runStats.finalScore > data.highScore) {
      data.highScore = runStats.finalScore;
      newHighScore = true;
    }

    // Evaluate achievements
    const unlockedAchievements = SaveManager.checkAchievements();

    SaveManager.save();
    return { newHighScore, creditsEarned, unlockedAchievements };
  }

  /** Evaluates all lock conditions against current save metrics. */
  private static checkAchievements(): Achievement[] {
    const data = SaveManager.data;
    const newlyUnlocked: Achievement[] = [];

    const metricFor = (id: string): number => {
      if (id === 'first_blood') return data.totalKills;
      if (id === 'boss_slayer') return data.bossesDefeated;
      if (id === 'score_master') return data.highScore;
      return 0;
    };

    for (const ach of ACHIEVEMENTS) {
      if (data.completedAchievements.includes(ach.id)) continue;
      if (metricFor(ach.id) >= ach.target) {
        data.completedAchievements.push(ach.id);
        if (!data.unlockedWeapons.includes(ach.rewardWeapon)) {
          data.unlockedWeapons.push(ach.rewardWeapon);
        }
        newlyUnlocked.push(ach);
      }
    }

    return newlyUnlocked;
  }

  /** Check if a weapon ID is unlocked. */
  static isWeaponUnlocked(weaponId: string): boolean {
    return SaveManager.data.unlockedWeapons.includes(weaponId);
  }

  /** Cost of the next level for an upgrade key. */
  static getUpgradeCost(key: keyof HangarUpgrades): number {
    const currentLvl = SaveManager.data.upgrades[key];
    const cfg = UPGRADE_CONFIG[key];
    return Math.round(cfg.baseCost * Math.pow(cfg.costMult, currentLvl));
  }

  /** Purchase a permanent hangar upgrade if affordable and below max. */
  static buyUpgrade(key: keyof HangarUpgrades): boolean {
    const currentLvl = SaveManager.data.upgrades[key];
    const cfg = UPGRADE_CONFIG[key];
    if (currentLvl >= cfg.max) return false;
    const cost = SaveManager.getUpgradeCost(key);
    if (SaveManager.data.credits < cost) return false;
    SaveManager.data.credits -= cost;
    SaveManager.data.upgrades[key] += 1;
    SaveManager.save();
    return true;
  }
}
