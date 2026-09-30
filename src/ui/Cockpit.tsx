/**
 * Neon Vanguard — cockpit chrome.
 *
 * The persistent frame around the arena: a top status bar, a left navigation
 * rail and a right action rail, matching `design/menu-1920x1080.png`.
 *
 * Layout rules that matter on a real phone, and why:
 *
 *  * The rails live in the horizontal *edges* of a landscape screen, which is
 *    where a thumb naturally rests but where nothing is happening in the
 *    game. The middle of the screen is left to the arena.
 *  * The top bar is the one place the player looks for "how am I doing", and
 *    it is the only strip that is always safe from the notch.
 *  * Everything is `pointer-events-none` except the controls themselves, so
 *    the arena underneath stays fully tappable.
 *  * Sizes are in `clamp()` rather than breakpoints. A landscape phone can be
 *    390 CSS pixels tall on a small handset and 500+ on a tablet; fixed pixel
 *    sizes that look right on one are broken on the other.
 */

import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import type { HudSnapshot, NetSnapshot } from '../game/store';

export type NavTab = 'home' | 'inv' | 'arms' | 'set';

const NAV: { id: NavTab; label: string; glyph: string }[] = [
  { id: 'home', label: 'HOME', glyph: '⌂' },
  { id: 'inv', label: 'INV', glyph: '▤' },
  { id: 'arms', label: 'ARMS', glyph: '⊕' },
  { id: 'set', label: 'SET', glyph: '☀' },
];

// ---------------------------------------------------------------------------
// Top status bar
// ---------------------------------------------------------------------------

export function StatusBar({ hud, net, quality, onToggleMute, muted, children }: {
  hud: HudSnapshot;
  net: NetSnapshot;
  quality: string;
  onToggleMute: () => void;
  muted: boolean;
  children?: ReactNode;
}) {
  const hpRatio = hud.maxHp > 0 ? Math.max(0, Math.min(1, hud.hp / hud.maxHp)) : 0;
  const hpTone = hpRatio > 0.5 ? 'bg-emerald-400' : hpRatio > 0.25 ? 'bg-amber-400' : 'bg-rose-500';

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center gap-2
                 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]
                 landscape:px-3 landscape:gap-3"
      style={{
        // A short gradient instead of a solid bar: the arena stays visible
        // underneath, which matters on a small screen where a 60px opaque
        // strip is 15% of the play area.
        background: 'linear-gradient(180deg, rgba(5,6,15,0.92) 0%, rgba(5,6,15,0.55) 60%, transparent 100%)',
      }}
    >
      {/* Ship badge */}
      <div className="pointer-events-auto flex shrink-0 items-center gap-2">
        <button
          onClick={onToggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          className="grid h-9 w-9 place-items-center rounded-full border border-cyan-300/40
                     bg-cyan-400/10 text-base text-cyan-200 active:scale-95
                     landscape:h-10 landscape:w-10"
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <div className="hidden leading-none landscape:block">
          <div className="text-[clamp(9px,1.5vh,11px)] font-bold tracking-wider text-slate-200">CMDR-07</div>
          <div className="text-[clamp(8px,1.3vh,10px)] font-bold tracking-wider text-amber-300">LV {hud.level}</div>
        </div>
      </div>

      {/* Hull */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          className="h-[clamp(6px,1.4vh,10px)] min-w-8 flex-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-valuenow={Math.round(hpRatio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Hull integrity"
        >
          <div
            className={`h-full rounded-full transition-[width] duration-200 ${hpTone}`}
            style={{ width: `${hpRatio * 100}%` }}
          />
        </div>
        <span className="hidden shrink-0 tabular-nums text-[clamp(9px,1.4vh,11px)] text-slate-300 landscape:inline">
          {Math.round(hud.hp)}/{hud.maxHp}
        </span>
      </div>

      {/* Score and credits */}
      <div className="flex shrink-0 items-baseline gap-3">
        <span className="tabular-nums text-[clamp(14px,3.4vh,26px)] font-bold leading-none text-cyan-300
                         drop-shadow-[0_0_10px_rgba(34,211,238,0.6)]">
          {hud.score.toLocaleString()}
        </span>
        <span className="hidden tabular-nums text-[clamp(11px,2.2vh,18px)] font-bold text-amber-300 sm:inline">
          {net.players > 0 ? `W${hud.wave}` : `${hud.kills}`}
        </span>
      </div>

      {/* Status pills */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Pill tone="cyan">{quality}</Pill>
        <Pill tone={net.status === 'connected' ? 'green' : net.status === 'offline' ? 'slate' : 'amber'}>
          {net.status === 'connected' ? 'ONLINE' : net.status === 'offline' ? 'OFFLINE' : net.status.toUpperCase()}
        </Pill>
        <Pill tone="fuchsia">W{hud.wave}</Pill>
        {children}
      </div>
    </div>
  );
}

function Pill({ tone, children }: {
  tone: 'cyan' | 'green' | 'amber' | 'fuchsia' | 'slate';
  children: ReactNode;
}) {
  const tones = {
    cyan: 'border-cyan-400/50 text-cyan-300',
    green: 'border-emerald-400/50 text-emerald-300',
    amber: 'border-amber-400/50 text-amber-300',
    fuchsia: 'border-fuchsia-400/50 text-fuchsia-300',
    slate: 'border-slate-500/40 text-slate-400',
  } as const;
  return (
    <span
      className={`hidden rounded-md border bg-black/40 px-2 py-0.5 text-[clamp(8px,1.3vh,10px)]
                  font-bold tracking-wider backdrop-blur-sm sm:inline-block ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Left navigation rail
// ---------------------------------------------------------------------------

export function NavRail({ active, onSelect, disabled }: {
  active: NavTab;
  onSelect: (tab: NavTab) => void;
  /** Disables the entries that make no sense mid-match. */
  disabled?: boolean;
}) {
  return (
    <nav
      aria-label="Main"
      className="pointer-events-none absolute left-0 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1.5
                 py-2 pl-[max(0.25rem,env(safe-area-inset-left))] pr-1"
    >
      {NAV.map((item) => {
        const isActive = item.id === active;
        return (
          <motion.button
            key={item.id}
            data-nav={item.id}
            onClick={() => onSelect(item.id)}
            disabled={disabled}
            whileTap={{ scale: 0.94 }}
            aria-current={isActive ? 'page' : undefined}
            className={`pointer-events-auto flex flex-col items-center gap-0.5 rounded-lg border px-1.5 py-1
                        disabled:opacity-30
                        ${isActive
                          ? 'border-cyan-300/60 bg-cyan-400/15 text-cyan-200'
                          : 'border-white/12 bg-black/40 text-slate-400'}`}
            style={{ minWidth: 'clamp(38px,7vh,52px)' }}
          >
            <span aria-hidden className="text-[clamp(13px,2.6vh,19px)] leading-none">{item.glyph}</span>
            <span className="text-[clamp(7px,1.2vh,9px)] font-bold tracking-wider">{item.label}</span>
          </motion.button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Right action rail
// ---------------------------------------------------------------------------

export function ActionRail({
  paused, onPause, onBomb, bombCharges, onDebug, debugOn,
}: {
  paused: boolean;
  onPause: () => void;
  onBomb: () => void;
  bombCharges: number;
  onDebug: () => void;
  debugOn: boolean;
}) {
  return (
    <div
      className="pointer-events-none absolute right-0 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1.5
                 py-2 pr-[max(0.25rem,env(safe-area-inset-right))] pl-1"
    >
      <RailButton
        onClick={onPause}
        label={paused ? 'PLAY' : 'PAUSE'}
        glyph={paused ? '▶' : '❚❚'}
        tone="fuchsia"
        primary
      />
      <RailButton
        onClick={onDebug}
        label="DEBUG"
        glyph="#"
        tone={debugOn ? 'cyan' : 'slate'}
        active={debugOn}
      />
      <RailButton
        onClick={onBomb}
        label="BOMB"
        glyph="B"
        tone="rose"
        badge={bombCharges}
        disabled={bombCharges < 1}
      />
    </div>
  );
}

function RailButton({
  onClick, label, glyph, tone, primary, active, badge, disabled,
}: {
  onClick: () => void;
  label: string;
  glyph: string;
  tone: 'fuchsia' | 'rose' | 'cyan' | 'slate';
  primary?: boolean;
  active?: boolean;
  badge?: number;
  disabled?: boolean;
}) {
  const tones = {
    fuchsia: 'border-fuchsia-400/50 bg-fuchsia-400/15 text-fuchsia-200',
    rose: 'border-rose-400/50 bg-rose-500/15 text-rose-200',
    cyan: 'border-cyan-400/60 bg-cyan-400/20 text-cyan-200',
    slate: 'border-white/12 bg-black/40 text-slate-400',
  } as const;
  return (
    <motion.button
      data-action={label.toLowerCase()}
      onClick={onClick}
      disabled={disabled}
      whileTap={{ scale: 0.92 }}
      aria-label={label}
      className={`pointer-events-auto relative flex flex-col items-center gap-0.5 rounded-lg border
                  px-1.5 py-1 disabled:opacity-30 ${tones[tone]}
                  ${primary ? 'ring-1 ring-fuchsia-300/20' : ''} ${active ? 'ring-2 ring-cyan-300/40' : ''}`}
      style={{ minWidth: 'clamp(38px,7vh,52px)' }}
    >
      <span aria-hidden className="text-[clamp(13px,2.6vh,19px)] font-bold leading-none">{glyph}</span>
      <span className="text-[clamp(7px,1.2vh,9px)] font-bold tracking-wider">{label}</span>
      {badge !== undefined && (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full
                         bg-rose-500 px-1 text-[9px] font-bold text-white">
          {badge}
        </span>
      )}
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// In-run status chips (buffs), and the thumb-zone guides
// ---------------------------------------------------------------------------

export function StatusChips({ hud }: { hud: HudSnapshot }) {
  const chips: { key: string; text: string; className: string }[] = [];
  if (hud.combo > 1) chips.push({ key: `c${hud.combo}`, text: `COMBO ×${hud.combo}`, className: 'bg-amber-400/20 text-amber-300 ring-amber-400/40' });
  if (hud.power > 1) chips.push({ key: `p${hud.power}`, text: `POWER ${hud.power}`, className: 'bg-fuchsia-400/20 text-fuchsia-300 ring-fuchsia-400/40' });
  if (hud.shield > 0) chips.push({ key: `s${hud.shield.toFixed(0)}`, text: `🛡 ${hud.shield.toFixed(0)}s`, className: 'bg-sky-400/20 text-sky-300 ring-sky-400/40' });
  if (hud.rapid > 0) chips.push({ key: `r${hud.rapid.toFixed(0)}`, text: '⚡ RAPID', className: 'bg-pink-400/20 text-pink-300 ring-pink-400/40' });
  if (hud.weapon !== 'blaster') {
    chips.push({
      key: hud.weapon,
      text: hud.weapon === 'spread' ? '🔱 SPREAD' : '🎯 SEEKER',
      className: 'bg-cyan-400/20 text-cyan-200 ring-cyan-300/40',
    });
  }
  if (chips.length === 0) return null;

  return (
    <div className="pointer-events-none absolute left-1/2 top-[clamp(2.6rem,7vh,4rem)] z-20 flex -translate-x-1/2 flex-wrap
                    justify-center gap-1 px-16">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`rounded px-1.5 py-0.5 text-[clamp(8px,1.4vh,11px)] font-bold leading-none ring-1 ${chip.className}`}
        >
          {chip.text}
        </span>
      ))}
    </div>
  );
}

/**
 * Faint labels marking where the thumbs rest. Purely a readability aid while
 * learning the controls, and the clearest statement of the intended landscape
 * ergonomics: the bottom corners are control space, not play space.
 */
export function ThumbGuides({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-between px-3
                    pb-[max(0.25rem,env(safe-area-inset-bottom))] text-[9px] font-bold tracking-widest text-cyan-300/25">
      <span>LEFT THUMB</span>
      <span className="text-slate-500/25">SAFE</span>
      <span>RIGHT THUMB</span>
    </div>
  );
}
