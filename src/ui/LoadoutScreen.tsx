/**
 * Neon Vanguard — SELECT LOADOUT.
 *
 * The menu screen from `design/menu-1920x1080.png`: a weapon card row, a
 * stat row, the two primary actions, and the hangar behind a second tab.
 *
 * Two decisions worth calling out:
 *
 *  * **Locked cards are shown, not hidden.** The player can see what the
 *    achievements unlock and what it takes to get there, which is the entire
 *    point of an achievement system. A card that is simply absent reads as
 *    "this does not exist".
 *  * **Everything is sized in `clamp()` against viewport height.** A landscape
 *    phone is short and wide; height-based sizing is what keeps a card row,
 *    a stat row and two buttons on one screen at 360px tall as well as at
 *    500px.
 */

import { motion } from 'framer-motion';
import type { Achievement, HangarUpgrades } from '../game/saveSystem';
import { UPGRADE_CATALOG } from '../game/weapons';
import type { Settings } from '../game/store';
import { sound } from '../game/sound';
import { vibrate } from '../game/haptics';

type Card = {
  id: string;
  title: string;
  tag: string;
  glyph: string;
  tone: 'cyan' | 'magenta' | 'slate';
  locked: boolean;
  description: string;
};

const CARDS: Omit<Card, 'locked'>[] = [
  { id: 'spread_weapon', title: 'TRI-SPREAD CANNON', tag: 'SPREAD', glyph: '»',
    tone: 'cyan', description: '3-way spread shot' },
  { id: 'homing_weapon', title: 'SEEKER MISSILES', tag: 'HOMING', glyph: '◉',
    tone: 'magenta', description: 'Auto-homing projectiles' },
  { id: 'plasma_beam', title: 'PLASMA LANCE', tag: 'PLASMA', glyph: '⚡',
    tone: 'slate', description: 'Piercing heavy shots' },
];

/** What an achievement grants, keyed by the weapon id it unlocks. */
const UNLOCK_HINT: Record<string, string> = {
  spread_weapon: 'Eliminate 50 enemies',
  homing_weapon: 'Score 25,000',
  plasma_beam: 'Defeat a boss',
};

export function LoadoutScreen({
  credits, upgrades, unlockedWeapons, achievements, highScore, totalKills, wavesCleared,
  onDeploy, onOpenHangar, onOpenStats, quality, onQuality,
}: {
  credits: number;
  upgrades: HangarUpgrades;
  unlockedWeapons: string[];
  achievements: Achievement[];
  highScore: number;
  totalKills: number;
  wavesCleared: number;
  onDeploy: () => void;
  onOpenHangar: () => void;
  onOpenStats: () => void;
  quality: Settings['quality'];
  onQuality: (q: Settings['quality']) => void;
}) {
  const cards: Card[] = CARDS.map((card) => ({ ...card, locked: !unlockedWeapons.includes(card.id) }));

  const stats: { label: string; value: string; tone: string }[] = [
    { label: 'HULL', value: String(100 + upgrades.healthLevel * 10), tone: 'border-emerald-400/30 text-emerald-300' },
    { label: 'THRUST', value: `+${Math.round(upgrades.speedLevel * 5)}%`, tone: 'border-cyan-400/30 text-cyan-300' },
    { label: 'BOMBS', value: String(2 + upgrades.bombLevel), tone: 'border-amber-400/30 text-amber-300' },
  ];

  return (
    <div className="absolute inset-0 z-30 flex flex-col overflow-y-auto overscroll-contain
                    bg-[#05060f]/92 px-3 py-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm
                    landscape:px-6 landscape:pl-16 landscape:pr-16">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-[clamp(0.5rem,2vh,1.25rem)]">

        {/* Heading */}
        <header>
          <h1
            className="text-[clamp(22px,6vh,44px)] font-black tracking-[0.08em] text-slate-50"
            style={{ textShadow: '0 0 24px rgba(34,211,238,0.35)' }}
          >
            SELECT LOADOUT
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 text-[clamp(9px,1.8vh,13px)] text-slate-500">
            <span>Wave-cleared rewards · achievement weapons unlock in combat</span>
            <span className="rounded bg-amber-400/10 px-1.5 py-0.5 font-bold tracking-wider text-amber-300">
              💰 {credits.toLocaleString()}
            </span>
          </p>
        </header>

        {/* Weapon cards */}
        <div className="grid grid-cols-3 gap-[clamp(0.35rem,1.4vw,1rem)]">
          {cards.map((card) => (
            <motion.div
              key={card.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              whileHover={card.locked ? undefined : { y: -2 }}
              className={`flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-[clamp(0.5rem,2vh,1.25rem)]
                          text-center ${card.locked
                            ? 'border-white/5 bg-black/60 opacity-55'
                            : card.tone === 'cyan'
                              ? 'border-cyan-400/40 bg-cyan-400/5'
                              : 'border-fuchsia-400/40 bg-fuchsia-400/5'}`}
            >
              <span className={`text-[clamp(20px,5vh,38px)] leading-none ${
                card.locked ? 'text-slate-600'
                  : card.tone === 'cyan' ? 'text-cyan-300' : 'text-fuchsia-300'}`}>
                {card.glyph}
              </span>
              <span className={`text-[clamp(9px,1.9vh,14px)] font-black tracking-wide ${
                card.locked ? 'text-slate-500' : 'text-slate-50'}`}>
                {card.title}
              </span>
              <span className="hidden text-[clamp(8px,1.5vh,11px)] text-slate-500 sm:block">{card.description}</span>
              <span className={`mt-0.5 text-[clamp(8px,1.4vh,10px)] font-bold tracking-[0.15em] ${
                card.locked ? 'text-slate-600'
                  : card.tone === 'cyan' ? 'text-cyan-300' : 'text-fuchsia-300'}`}>
                {card.locked ? 'LOCKED' : card.tag}
              </span>
            </motion.div>
          ))}
        </div>

        {/* Stat row */}
        <div className="grid grid-cols-3 gap-[clamp(0.35rem,1.4vw,1rem)]">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={`rounded-xl border bg-black/30 py-[clamp(0.35rem,1.4vh,0.85rem)] text-center
                          text-[clamp(11px,2.4vh,20px)] font-black tracking-wide ${stat.tone}`}
            >
              {stat.value}
              <span className="ml-1.5 text-[clamp(8px,1.4vh,10px)] font-bold tracking-widest opacity-60">
                {stat.label}
              </span>
            </div>
          ))}
        </div>

        {/* Primary actions */}
        <div className="grid grid-cols-2 gap-[clamp(0.5rem,2vw,1.25rem)]">
          <BigButton
            onClick={() => { sound.play('uiClick'); vibrate(25); onDeploy(); }}
            tone="cyan"
            className="text-cyan-950"
          >
            DEPLOY
          </BigButton>
          <BigButton
            onClick={() => { sound.play('uiClick'); onOpenHangar(); }}
            tone="amber"
            className="text-amber-200"
          >
            HANGAR
          </BigButton>
        </div>

        {/* Footer: record, quality, secondaries */}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1
                        text-[clamp(8px,1.4vh,11px)] font-bold tracking-widest text-slate-500">
          <span>BEST {highScore.toLocaleString()}</span>
          <span className="text-slate-700">·</span>
          <span>KILLS {totalKills.toLocaleString()}</span>
          <span className="text-slate-700">·</span>
          <span>WAVES {wavesCleared.toLocaleString()}</span>

          <button onClick={onOpenStats} className="text-cyan-400/70 underline-offset-2 hover:underline">
            INVENTORY
          </button>

          {/* Quality picker, inline: it is a three-way switch, not a screen. */}
          <span className="flex items-center gap-1">
            <span className="text-slate-600">GFX</span>
            {(['low', 'medium', 'high'] as const).map((tier) => (
              <button
                key={tier}
                onClick={() => { sound.play('uiClick'); onQuality(tier); }}
                className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${
                  quality === tier ? 'bg-cyan-400/20 text-cyan-300' : 'text-slate-600 hover:text-slate-300'}`}
              >
                {tier.toUpperCase()}
              </button>
            ))}
          </span>
        </div>

        {/* Achievements still in progress — the reason a card is locked. */}
        {achievements.length > 0 && (
          <ul className="flex flex-wrap justify-center gap-2 text-[clamp(8px,1.3vh,10px)] text-slate-600">
            {achievements.map((a) => (
              <li key={a.id} className="rounded bg-white/[0.03] px-2 py-0.5">
                {a.title} — {UNLOCK_HINT[a.rewardWeapon] ?? a.description}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BigButton({ children, onClick, tone, className }: {
  children: React.ReactNode;
  onClick: () => void;
  tone: 'cyan' | 'amber';
  className: string;
}) {
  const styles = tone === 'cyan'
    ? 'bg-gradient-to-r from-cyan-300 to-cyan-400 shadow-[0_0_30px_-6px_rgba(34,211,238,0.8)]'
    : 'border border-amber-300/50 bg-amber-400/10 shadow-[0_0_30px_-10px_rgba(255,209,102,0.6)]';
  return (
    <motion.button
      onClick={onClick}
      onMouseEnter={() => sound.play('uiHover')}
      whileTap={{ scale: 0.97 }}
      className={`rounded-xl py-[clamp(0.5rem,2.2vh,1.1rem)] text-[clamp(15px,3.6vh,30px)] font-black
                  tracking-[0.1em] ${styles} ${className}`}
    >
      {children}
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Inventory / statistics screen
// ---------------------------------------------------------------------------

export function StatsScreen({ onBack, totalKills, bossesDefeated, wavesCleared, gamesPlayed, highScore, credits, unlockedWeapons }: {
  onBack: () => void;
  totalKills: number;
  bossesDefeated: number;
  wavesCleared: number;
  gamesPlayed: number;
  highScore: number;
  credits: number;
  unlockedWeapons: string[];
}) {
  const rows: [string, string][] = [
    ['BEST SCORE', highScore.toLocaleString()],
    ['TOTAL KILLS', totalKills.toLocaleString()],
    ['BOSSES SLAIN', bossesDefeated.toLocaleString()],
    ['WAVES CLEARED', wavesCleared.toLocaleString()],
    ['DEPLOYMENTS', gamesPlayed.toLocaleString()],
    ['CREDITS', credits.toLocaleString()],
    ['KILLS / DEPLOYMENT', gamesPlayed > 0 ? Math.round(totalKills / gamesPlayed).toLocaleString() : '—'],
  ];
  const kdr = totalKills > 0 && bossesDefeated > 0 ? (totalKills / Math.max(1, bossesDefeated)).toFixed(1) : '—';

  return (
    <Screen title="INVENTORY" onBack={onBack}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between rounded-lg border border-white/10
                                      bg-black/30 px-3 py-2">
            <span className="text-[clamp(8px,1.5vh,11px)] font-bold tracking-widest text-slate-500">{label}</span>
            <span className="tabular-nums text-[clamp(11px,2.2vh,17px)] font-bold text-cyan-300">{value}</span>
          </div>
        ))}
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2">
          <span className="text-[clamp(8px,1.5vh,11px)] font-bold tracking-widest text-slate-500">BOSS RATIO</span>
          <span className="tabular-nums text-[clamp(11px,2.2vh,17px)] font-bold text-amber-300">{kdr}</span>
        </div>
      </div>

      <div className="mt-4">
        <h3 className="mb-2 text-[clamp(9px,1.6vh,12px)] font-bold tracking-widest text-slate-500">ARSENAL</h3>
        <div className="flex flex-wrap gap-2">
          {UPGRADE_CATALOG.filter((u) => u.weapon !== null).map((u) => {
            const owned = unlockedWeapons.includes(u.id);
            return (
              <span key={u.id}
                    className={`rounded-md border px-2 py-1 text-[clamp(9px,1.6vh,12px)] font-bold ${
                      owned ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300' : 'border-white/8 text-slate-600'}`}>
                {u.tag}
              </span>
            );
          })}
        </div>
      </div>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

export function SettingsScreen({
  onBack, settings, onToggleMute, onToggleDebug, onQuality, onResetProgress, onToggleNetwork,
}: {
  onBack: () => void;
  settings: Settings;
  onToggleMute: () => void;
  onToggleDebug: () => void;
  onQuality: (q: Settings['quality']) => void;
  onResetProgress: () => void;
  onToggleNetwork: () => void;
}) {
  return (
    <Screen title="SETTINGS" onBack={onBack}>
      <div className="flex flex-col gap-2">
        <ToggleRow label="SOUND" value={settings.muted ? 'OFF' : 'ON'} onClick={onToggleMute} />
        <ToggleRow label="HAPTICS" value={settings.hapticFeedback ? 'ON' : 'OFF'}
                    onClick={() => { /* wired through the settings store by the host */ }} />
        <ToggleRow label="PERF OVERLAY" value={settings.debugOverlay ? 'ON' : 'OFF'} onClick={onToggleDebug} />

        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2">
          <span className="text-[clamp(8px,1.5vh,11px)] font-bold tracking-widest text-slate-500">GRAPHICS</span>
          <div className="flex gap-1">
            {(['low', 'medium', 'high'] as const).map((tier) => (
              <button key={tier} onClick={() => onQuality(tier)}
                      className={`rounded px-2 py-0.5 text-[9px] font-bold ${
                        settings.quality === tier ? 'bg-cyan-400/20 text-cyan-300' : 'text-slate-500'}`}>
                {tier.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <ToggleRow label="MULTIPLAYER" value="AUTO" onClick={onToggleNetwork} />
      </div>

      <button
        onClick={onResetProgress}
        className="mt-4 w-full rounded-lg border border-rose-400/30 bg-rose-500/10 py-2
                   text-[clamp(9px,1.6vh,12px)] font-bold tracking-widest text-rose-300"
      >
        RESET PROGRESS
      </button>
      <p className="mt-2 text-center text-[10px] text-slate-600">
        Clears credits, upgrades, achievements and high scores on this device.
      </p>
    </Screen>
  );
}

function Screen({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col overflow-y-auto overscroll-contain
                    bg-[#05060f]/94 px-3 py-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm landscape:px-6 landscape:pl-16 landscape:pr-16">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4">
        <header className="flex items-center justify-between">
          <h2 className="text-[clamp(18px,4.5vh,32px)] font-black tracking-[0.1em] text-slate-50">{title}</h2>
          <button onClick={() => { sound.play('uiClick'); onBack(); }}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5
                             text-[clamp(9px,1.6vh,12px)] font-bold tracking-widest text-slate-300">
            BACK
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function ToggleRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
            className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2
                       text-left active:scale-[0.99]">
      <span className="text-[clamp(8px,1.5vh,11px)] font-bold tracking-widest text-slate-500">{label}</span>
      <span className="text-[clamp(10px,1.9vh,14px)] font-bold text-cyan-300">{value}</span>
    </button>
  );
}
