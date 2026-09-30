import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Game, emptyInput, type Input, type WeaponUpgrade, type WeaponType } from './game/engine';
import { Stick, type StickState } from './components/Stick';
import { HangarModal } from './components/HangarModal';
import { RotateOverlay } from './components/RotateOverlay';
import { AmbientBackground } from './components/AmbientBackground';
import { useOrientationLock } from './game/useOrientationLock';
import { SaveManager, type Achievement } from './game/saveSystem';
import { sound } from './game/sound';
import { vibrate } from './game/haptics';

type Phase = 'menu' | 'playing' | 'paused' | 'over';
type ScoreRow = { score: number; wave: number; date: string };

const KEY = 'neon-vanguard-scores';
const loadScores = (): ScoreRow[] => {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r: unknown): r is ScoreRow =>
      typeof r === 'object' && r !== null &&
      typeof (r as ScoreRow).score === 'number' &&
      typeof (r as ScoreRow).wave === 'number' &&
      typeof (r as ScoreRow).date === 'string'
    );
  } catch { return []; }
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [initialGame] = useState(() => new Game('high'));
  const gameRef = useRef<Game>(initialGame);
  const inputRef = useRef<Input>(emptyInput());
  const phaseRef = useRef<Phase>('menu');
  const moveStick = useRef<StickState>({ x: 0, y: 0, active: false });
  const aimStick = useRef<StickState>({ x: 0, y: 0, active: false });

  const [phase, setPhase] = useState<Phase>('menu');
  const [hud, setHud] = useState<{ score: number; hp: number; wave: number; level: number; enemiesLeft: number; combo: number; power: number; kills: number; shield: number; rapid: number; bombCharges: number; weapon: WeaponType }>({
    score: 0, hp: 100, wave: 1, level: 1, enemiesLeft: 0, combo: 1, power: 1, kills: 0, shield: 0, rapid: 0, bombCharges: 2, weapon: 'blaster',
  });
  const [upgradeState, setUpgradeState] = useState<{ options: WeaponUpgrade[]; key: number } | null>(null);
  const [scores, setScores] = useState<ScoreRow[]>(loadScores);
  const [hangarOpen, setHangarOpen] = useState(false);
  const [credits, setCredits] = useState(() => SaveManager.get().credits);
  const [unlocked, setUnlocked] = useState<Achievement[]>([]);
  const [newHigh, setNewHigh] = useState(false);
  const [debugOn, setDebugOn] = useState(false);
  const [muted, setMuted] = useState(sound.muted);
  const [waveFlash, setWaveFlash] = useState<{ n: number; kind: 'wave' | 'level'; key: number } | null>(null);
  const [comboFx, setComboFx] = useState(0);
  const comboRef = useRef(1);
  const overHandledRef = useRef(false);
  const gameOverTimeoutRef = useRef<number | null>(null);

  const clearInput = useCallback(() => {
    const input = inputRef.current;
    input.up = false; input.down = false; input.left = false; input.right = false;
    input.move.x = 0; input.move.y = 0;
    input.firing = false; input.aim = null;
    moveStick.current = { x: 0, y: 0, active: false };
    aimStick.current = { x: 0, y: 0, active: false };
  }, []);

  const setPhaseBoth = useCallback((p: Phase) => {
    if (p !== 'playing') {
      gameRef.current.reticle = null;
      gameRef.current.moveTarget = null;
      clearInput();
    }
    phaseRef.current = p;
    setPhase(p);
  }, [clearInput]);

  // portrait rotation mid-game pauses immediately; resume is manual
  const forcePause = useCallback(() => {
    if (phaseRef.current === 'playing') {
      sound.stopMusic();
      setPhaseBoth('paused');
    }
  }, [setPhaseBoth]);
  const isPlaying = useCallback(() => phaseRef.current === 'playing', []);

  const { touch, isPortrait, requestLandscape } = useOrientationLock({ onForcePause: forcePause, isPlaying });

  // audio unlock on first user gesture
  useEffect(() => {
    const unlock = () => { sound.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);

  // music follows phase
  useEffect(() => {
    if (phase === 'playing') sound.startMusic();
    else sound.stopMusic();
  }, [phase]);

  // auto-pause when tab loses focus, so players aren't unfairly punished
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && phaseRef.current === 'playing') {
        sound.stopMusic();
        setPhaseBoth('paused');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('blur', onVis); };
  }, [setPhaseBoth]);

  useEffect(() => {
    if (!waveFlash) return;
    const timer = window.setTimeout(() => {
      setWaveFlash((w) => (w?.key === waveFlash.key ? null : w));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [waveFlash]);

  const enterFullscreen = useCallback(async () => {
    try {
      const el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch { /* fullscreen unavailable */ }
  }, []);

  const start = useCallback(async () => {
    sound.unlock();
    if (touch) {
      await enterFullscreen();
      requestLandscape();
    }
    if (gameOverTimeoutRef.current !== null) {
      window.clearTimeout(gameOverTimeoutRef.current);
      gameOverTimeoutRef.current = null;
    }
    overHandledRef.current = false;
    setUpgradeState(null);
    setHangarOpen(false);
    setUnlocked([]);
    setNewHigh(false);
    const g = new Game(touch ? 'low' : 'high');
    g.initRun(SaveManager.get().upgrades);
    g.onSound = (name) => {
      sound.play(name);
      if (name === 'hitPlayer') vibrate(60);
      else if (name === 'explodeBig') vibrate(40);
      else if (name === 'gameOver') vibrate([80, 60, 80]);
    };
    g.onWave = () => { setWaveFlash({ n: g.wave, kind: 'wave', key: Date.now() }); vibrate(30); };
    g.onLevel = (lv) => { setWaveFlash({ n: lv, kind: 'level', key: Date.now() }); vibrate([40, 40, 80]); };
    g.onUpgradePending = () => { setUpgradeState({ options: g.upgradeOptions, key: Date.now() }); vibrate([30, 40, 30]); };
    g.onBomb = () => vibrate([50, 30, 50]);
    gameRef.current = g;
    // Fully reset input state so keys/sticks held from a previous run don't carry over.
    inputRef.current = emptyInput();
    moveStick.current = { x: 0, y: 0, active: false };
    aimStick.current = { x: 0, y: 0, active: false };
    gameRef.current.moveTarget = null;
    comboRef.current = 1;
    sound.play('uiClick');
    setPhaseBoth('playing');
  }, [setPhaseBoth, touch, enterFullscreen, requestLandscape]);

  const submit = useCallback((stats: { finalScore: number; kills: number; bossesKilled: number; wavesCleared: number }, wave: number) => {
    const next = [...loadScores(), { score: stats.finalScore, wave, date: new Date().toISOString().slice(0, 10) }]
      .sort((a, b) => b.score - a.score).slice(0, 8);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(next));
    } catch { /* QuotaExceeded */ }
    setScores(next);
    // Single owner of run recording: credits + lifetime stats + achievements
    const { newHighScore, unlockedAchievements } = SaveManager.recordRun(stats);
    setCredits(SaveManager.get().credits);
    setNewHigh(newHighScore);
    setUnlocked(prev => [...prev, ...unlockedAchievements]);
    // Canvas popups while the arena is still visible behind the delayed overlay
    gameRef.current.celebrateAchievements(unlockedAchievements);
  }, []);

  const toggleMute = useCallback(() => {
    const m = sound.toggleMuted();
    setMuted(m);
  }, []);

  const toggleDebug = useCallback(() => {
    gameRef.current.toggleDebug();
    setDebugOn(gameRef.current.debugMode);
  }, []);

  const touchRef = useRef(false);
  useEffect(() => { touchRef.current = touch; }, [touch]);

  // main loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fullscreen backing store: bitmap matches the canvas element size, and
    // the 960x600 arena is contain-fit into it each frame (no stretch, no crop).
    // DPR is capped so high-density phones don't stall on first paint.
    const W = 960, H = 600;
    const resizeBacking = () => {
      const rect = canvas.getBoundingClientRect();
      const raw = window.devicePixelRatio || 1;
      const cap = touchRef.current ? 1.5 : 2;
      const dpr = Math.min(raw, cap);
      canvas.width = Math.max(2, Math.round(rect.width * dpr));
      canvas.height = Math.max(2, Math.round(rect.height * dpr));
    };
    resizeBacking();
    const onResize = () => resizeBacking();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    let raf = 0, last = performance.now(), acc = 0;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const g = gameRef.current;
      const ph = phaseRef.current;

      if (ph === 'playing') {
        const inp = inputRef.current;
        if (moveStick.current.active) {
          inp.move.x = moveStick.current.x; inp.move.y = moveStick.current.y;
          g.moveTarget = null;
        } else { inp.move.x = 0; inp.move.y = 0; }
        if (aimStick.current.active) {
          const a = aimStick.current;
          // project the joystick direction into a world-space cursor in front of the player
          const aimX = g.player.x + a.x * 260;
          const aimY = g.player.y + a.y * 260;
          inp.aim = { x: aimX, y: aimY };
          inp.firing = true;
          // hand the cursor to the engine so it can render the reticle + trajectory
          g.reticle = { x: aimX, y: aimY };
          g.reticleColor = '#e879f9'; // fuchsia to match the right stick
        } else if (touchRef.current) {
          // touch device but stick released: stop firing and hide the reticle
          inp.firing = false;
          g.reticle = null;
        }
        // on desktop, aim/reticle/firing are driven entirely by the pointer handlers below
        g.update(dt, inp);
        if (g.over && !overHandledRef.current) {
          overHandledRef.current = true;
          submit(g.runStats(), g.wave);
          gameOverTimeoutRef.current = window.setTimeout(() => {
            gameOverTimeoutRef.current = null;
            setPhaseBoth('over');
          }, 900);
        }
        if (g.combo !== comboRef.current) {
          comboRef.current = g.combo;
          if (g.combo > 1) setComboFx((n) => n + 1);
        }
        acc += dt;
        if (acc > 0.08) {
          acc = 0;
          setHud({
            score: g.score, hp: g.player.hp, wave: g.wave, level: g.level, enemiesLeft: g.waveEnemiesRemaining,
            combo: g.combo, power: g.power, kills: g.kills,
            shield: g.player.shield, rapid: g.player.rapid, bombCharges: g.player.bombCharges,
            weapon: g.weapon,
          });
        }
      } else if (ph === 'menu') {
        // Ambient-only update: stars/particles drift for visual appeal, but no
        // spawning, combat, or damage runs behind the menu.
        g.updateAmbient(dt);
      } else {
        // paused / over: still tick ambient FX so shake/slowmo decay and death
        // animations play out instead of freezing with permanent shake.
        g.updateAmbient(dt);
      }
      try {
        // contain-fit: fill the whole bitmap with theme bg, then draw the
        // 960x600 arena letterboxed (bleed bars blend into the background)
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#05060f';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / W, canvas.height / H);
        const ox = (canvas.width - W * scale) / 2;
        const oy = (canvas.height - H * scale) / 2;
        ctx.setTransform(scale, 0, 0, scale, ox, oy);
        g.render(ctx);
      } catch { /* render must not break loop */ }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (gameOverTimeoutRef.current !== null) {
        window.clearTimeout(gameOverTimeoutRef.current);
        gameOverTimeoutRef.current = null;
      }
    };
  }, [submit, setPhaseBoth]);

  // keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const i = inputRef.current;
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (k === 'w' || k === 'arrowup') i.up = true;
      if (k === 's' || k === 'arrowdown') i.down = true;
      if (k === 'a' || k === 'arrowleft') i.left = true;
      if (k === 'd' || k === 'arrowright') i.right = true;
      // manual keyboard movement immediately overrides any active click-to-move target
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        gameRef.current.moveTarget = null;
      }
      if (phaseRef.current === 'playing') {
        if ((k === 'shift' || k === ' ') && !e.repeat) gameRef.current.dash();
        if ((k === 'q' || k === 'f') && !e.repeat) gameRef.current.bomb();
      }
      if (k === 'm') toggleMute();
      // Spatial-grid debug overlay: backtick or F3 (desktop / dev)
      if (e.key === '`' || e.key === 'F3') {
        e.preventDefault();
        toggleDebug();
      }
      if (k === 'escape' || k === 'p') {
        if (phaseRef.current === 'playing') { sound.play('uiClick'); setPhaseBoth('paused'); }
        else if (phaseRef.current === 'paused') { sound.play('uiClick'); setPhaseBoth('playing'); }
      }
      if (k === 'enter') {
        if (phaseRef.current === 'menu' || phaseRef.current === 'over') start();
      }
      if (k === 'r' && (phaseRef.current === 'over' || phaseRef.current === 'paused')) start();
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase(); const i = inputRef.current;
      if (k === 'w' || k === 'arrowup') i.up = false;
      if (k === 's' || k === 'arrowdown') i.down = false;
      if (k === 'a' || k === 'arrowleft') i.left = false;
      if (k === 'd' || k === 'arrowright') i.right = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [start, setPhaseBoth, toggleMute, toggleDebug]);

  // Inverse of the contain-fit render transform (taps in the bleed bars clamp to the edge)
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    if (!el) return { x: 480, y: 300 };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { x: 480, y: 300 };
    const scale = Math.min(r.width / 960, r.height / 600);
    const ox = (r.width - 960 * scale) / 2;
    const oy = (r.height - 600 * scale) / 2;
    const x = Math.max(0, Math.min(960, (e.clientX - r.left - ox) / scale));
    const y = Math.max(0, Math.min(600, (e.clientY - r.top - oy) / scale));
    return { x, y };
  };

  const lowHp = hud.hp > 0 && hud.hp <= 30;
  // newHigh comes straight from SaveManager.recordRun — comparing against the
  // leaderboard list can't work because the just-finished run is already in it
  const isNewHighScore = phase === 'over' && newHigh;

  return (
    <div className="relative min-h-dvh w-full text-slate-100 flex flex-col items-center justify-center p-0 portrait:p-2 portrait:sm:p-4 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] select-none overflow-hidden"
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
      {/* page bg comes from <body>; kept transparent so AmbientBackground shows through */}
      {!touch && <AmbientBackground />}
      <div className={`game-surface relative w-full max-w-5xl aspect-8/5 max-h-[92dvh] landscape:max-w-none landscape:max-h-none landscape:aspect-auto landscape:flex-1 landscape:w-full landscape:rounded-none overflow-hidden ring-1 shadow-[0_0_80px_-15px_rgba(56,189,248,0.5)] transition-shadow ${lowHp ? 'ring-rose-500/50' : 'ring-cyan-400/25'}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <canvas
          ref={canvasRef} width={960} height={600}
          className="absolute inset-0 h-full w-full touch-none"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            sound.unlock();
            if (e.pointerType === 'touch') return;

            if (e.button === 2) {
              if (phaseRef.current !== 'playing') return;
              e.preventDefault();
              const w = toWorld(e);
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              gameRef.current.moveTarget = w;
              inputRef.current.firing = false;
              return;
            }

            // LEFT CLICK → aim + fire at cursor
            e.currentTarget.setPointerCapture(e.pointerId);
            const w = toWorld(e);
            inputRef.current.aim = w;
            gameRef.current.reticle = w;
            gameRef.current.reticleColor = '#7df9ff';
            if (phaseRef.current === 'playing') inputRef.current.firing = true;
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch') return;

            // right button held down → continuously follow the mouse
            if (e.buttons & 2) {
              gameRef.current.moveTarget = toWorld(e);
              return;
            }

            // otherwise, track the aim cursor
            const w = toWorld(e);
            inputRef.current.aim = w;
            gameRef.current.reticle = w;
            gameRef.current.reticleColor = '#7df9ff';
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch') return;
            if (e.button === 0) inputRef.current.firing = false;
            try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch') return;
            inputRef.current.firing = false;
            gameRef.current.reticle = null;
          }}
          onPointerLeave={(e) => {
            if ((e as React.PointerEvent).pointerType === 'touch') return;
            inputRef.current.firing = false;
            gameRef.current.reticle = null;
          }}
        />

        {/* low-hp pulsing vignette */}
        {phase === 'playing' && lowHp && (
          <motion.div
            className="absolute inset-0 pointer-events-none"
            style={{ boxShadow: 'inset 0 0 120px 20px rgba(244,63,94,0.55)' }}
            animate={{ opacity: [0.3, 0.9, 0.3] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* mute toggle - always visible */}
        <motion.button
          onClick={toggleMute}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          className="absolute top-3 left-3 z-20 h-11 w-11 rounded-lg bg-white/10 hover:bg-white/20 ring-1 ring-white/20 flex items-center justify-center text-base opacity-70 hover:opacity-100 active:opacity-100"
          aria-label="Toggle sound"
        >
          {muted ? '🔇' : '🔊'}
        </motion.button>

        {/* spatial-grid debug toggle */}
        <motion.button
          onClick={toggleDebug}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          title="Toggle spatial grid debug (`)"
          aria-label="Toggle spatial grid debug"
          className={`absolute top-14 left-3 z-20 h-11 px-2 rounded-lg ring-1 flex items-center justify-center gap-1 text-[10px] font-bold tracking-wider backdrop-blur-sm opacity-70 hover:opacity-100 active:opacity-100 ${
            debugOn
              ? 'bg-fuchsia-400/25 ring-fuchsia-400/50 text-fuchsia-300'
              : 'bg-white/10 ring-white/20 text-slate-400 hover:bg-white/20'
          }`}
        >
          🐛 GRID
        </motion.button>

        {/* HUD — top status bar: left cluster (score/hp/status) and right cluster (level/wave/enemies/bomb) */}
        {(phase === 'playing' || phase === 'paused') && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 pl-16 pr-2 pt-2 sm:pr-3 sm:pt-3">
            {/* LEFT: score + hp bar + status chips */}
            <div className="min-w-0 flex-1">
              <motion.div
                key={hud.score}
                initial={{ scale: 1.15 }}
                animate={{ scale: 1 }}
                transition={{ duration: 0.15 }}
                className="text-2xl font-bold tabular-nums leading-none text-cyan-300 drop-shadow-[0_0_10px_rgba(34,211,238,0.8)] sm:text-4xl"
              >
                {hud.score.toLocaleString()}
              </motion.div>
              <div className="mt-1.5 h-2 w-32 overflow-hidden rounded-full bg-white/10 ring-1 ring-white/15 sm:w-52 sm:h-2.5">
                <motion.div className="h-full rounded-full"
                  animate={{ width: `${hud.hp}%`, background: hud.hp > 40 ? 'linear-gradient(90deg,#22d3ee,#4ade80)' : 'linear-gradient(90deg,#f43f5e,#fb923c)' }}
                  transition={{ duration: 0.2 }}
                />
              </div>
              <div className="mt-1.5 flex min-h-5 flex-wrap gap-1 text-[9px] leading-none sm:text-xs">
                <AnimatePresence>
                  {hud.combo > 1 && (
                    <motion.span
                      key={`combo-${comboFx}`}
                      initial={{ scale: 0.5, opacity: 0, y: -6 }}
                      animate={{ scale: 1, opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                      className="rounded bg-amber-400/20 px-1.5 py-0.5 text-amber-300 ring-1 ring-amber-400/40 sm:px-2"
                    >
                      COMBO x{hud.combo}
                    </motion.span>
                  )}
                  {hud.power > 1 && (
                    <motion.span key="power" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                      className="rounded bg-fuchsia-400/20 px-1.5 py-0.5 text-fuchsia-300 ring-1 ring-fuchsia-400/40 sm:px-2">
                      POWER {hud.power}
                    </motion.span>
                  )}
                  {hud.weapon !== 'blaster' && (
                    <motion.span key={`weapon-${hud.weapon}`} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                      className="rounded bg-cyan-400/20 px-1.5 py-0.5 text-cyan-200 ring-1 ring-cyan-300/40 sm:px-2">
                      {hud.weapon === 'spread' ? '🔱 SPREAD' : '🎯 SEEKER'}
                    </motion.span>
                  )}
                  {hud.shield > 0 && (
                    <motion.span key="shield" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                      className="rounded bg-sky-400/20 px-1.5 py-0.5 text-sky-300 ring-1 ring-sky-400/40 sm:px-2">
                      🛡 {hud.shield.toFixed(0)}s
                    </motion.span>
                  )}
                  {hud.rapid > 0 && (
                    <motion.span key="rapid" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                      className="rounded bg-pink-400/20 px-1.5 py-0.5 text-pink-300 ring-1 ring-pink-400/40 sm:px-2">
                      ⚡ RAPID
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>
            {/* RIGHT: level / wave / enemies remaining / bomb + pause buttons */}
            <div className="flex shrink-0 flex-col items-end gap-1">
              <div className="flex items-center gap-1.5 sm:gap-2">
                {/* LEVEL badge */}
                <div className="rounded-lg bg-black/45 px-2 py-1 text-center ring-1 ring-amber-300/40 backdrop-blur-sm">
                  <div className="text-[8px] tracking-widest text-amber-300/80 sm:text-[9px]">LEVEL</div>
                  <motion.div key={hud.level} initial={{ scale: 1.5, color: '#ffd166' }} animate={{ scale: 1 }}
                    className="text-base font-bold leading-none text-amber-300 sm:text-xl">
                    {hud.level}
                  </motion.div>
                </div>
                {/* WAVE badge */}
                <div className="rounded-lg bg-black/45 px-2 py-1 text-center ring-1 ring-fuchsia-300/40 backdrop-blur-sm">
                  <div className="text-[8px] tracking-widest text-fuchsia-300/80 sm:text-[9px]">WAVE</div>
                  <motion.div key={hud.wave} initial={{ scale: 1.4, color: '#7df9ff' }} animate={{ scale: 1 }}
                    className="text-base font-bold leading-none text-fuchsia-300 sm:text-xl">
                    {hud.wave}
                  </motion.div>
                </div>
                {/* ENEMIES remaining badge */}
                <div className="rounded-lg bg-black/45 px-2 py-1 text-center ring-1 ring-rose-300/40 backdrop-blur-sm">
                  <div className="text-[8px] tracking-widest text-rose-300/80 sm:text-[9px]">ENEMIES</div>
                  <motion.div key={hud.enemiesLeft} initial={{ scale: 1.2 }} animate={{ scale: 1 }}
                    className="text-base font-bold leading-none tabular-nums text-rose-200 sm:text-xl">
                    {hud.enemiesLeft}
                  </motion.div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {/* difficulty stars */}
                <div className="text-[9px] tracking-widest text-amber-300 sm:text-xs" title="Enemy difficulty tier">
                  {'★'.repeat(Math.max(1, Math.min(5, hud.level)))}
                </div>
                <div className="pointer-events-auto flex gap-1">
                  <motion.button
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.92 }}
                    onClick={() => { if (gameRef.current.bomb()) sound.play('uiClick'); }}
                    disabled={hud.bombCharges < 1 || phase !== 'playing'}
                    title="Bomb (Q)"
                    className="rounded-lg bg-rose-500/20 px-2 min-h-11 min-w-11 py-1 text-xs ring-1 ring-rose-400/40 hover:bg-rose-500/30 disabled:opacity-30 disabled:hover:bg-rose-500/20 opacity-70 hover:opacity-100 active:opacity-100"
                  >
                    💣 {hud.bombCharges}
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.92 }}
                    onClick={() => { sound.play('uiClick'); setPhaseBoth(phase === 'playing' ? 'paused' : 'playing'); }}
                    className="rounded-lg bg-white/10 px-3 min-h-11 min-w-11 py-1 text-xs ring-1 ring-white/20 hover:bg-white/20 opacity-70 hover:opacity-100 active:opacity-100">
                    {phase === 'playing' ? 'II' : '▶'}
                  </motion.button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Wave / Level announcement banner */}
        <AnimatePresence>
          {waveFlash && phase === 'playing' && (
            <motion.div
              key={waveFlash.key}
              className="absolute inset-x-0 top-[38%] flex justify-center pointer-events-none z-10"
              initial={{ opacity: 0, y: -20, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 1.2 }}
              transition={{ type: 'spring', stiffness: 260, damping: 18 }}
            >
              <div className="rounded-xl bg-linear-to-r from-cyan-400/20 to-fuchsia-400/20 px-6 py-2 ring-1 ring-cyan-300/40 backdrop-blur-sm">
                <span className="bg-linear-to-r from-cyan-200 to-fuchsia-300 bg-clip-text text-2xl font-black tracking-widest text-transparent sm:text-4xl">
                  {waveFlash.kind === 'level' ? `LEVEL ${waveFlash.n}` : `WAVE ${waveFlash.n}`}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Weapon upgrade selection — pauses the world between waves */}
        <AnimatePresence>
          {upgradeState && phase === 'playing' && (
            <motion.div
              key={`upgrade-${upgradeState.key}`}
              role="dialog"
              aria-modal="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 z-40 flex items-center justify-center bg-[#05060f]/75 p-3 backdrop-blur-md sm:p-5 overflow-y-auto"
            >
              <motion.div
                initial={{ scale: 0.92, y: 14 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 8 }}
                transition={{ type: 'spring', stiffness: 300, damping: 24 }}
                className="w-full max-w-3xl rounded-2xl border border-cyan-400/30 bg-slate-900/70 p-4 text-center shadow-[0_0_35px_rgba(34,211,238,0.15)] sm:p-6 m-auto"
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              >
                <div className="mb-2">
                  <span className="inline-block rounded-full border border-green-400/30 bg-green-400/10 px-3 py-0.5 text-[9px] font-extrabold tracking-[0.2em] text-green-400">
                    WAVE {hud.wave} CLEARED
                  </span>
                  <h2 className="mt-2 text-lg font-black tracking-[0.2em] text-cyan-300 drop-shadow-[0_0_16px_rgba(125,249,255,0.5)] sm:text-2xl">
                    SELECT WEAPON UPGRADE
                  </h2>
                  <p className="mt-1 text-[10px] tracking-wider text-slate-400 sm:text-xs">
                    Choose an enhancement before the next wave arrives
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-4">
                  {upgradeState.options.map((opt, i) => (
                    <motion.button
                      key={opt.id}
                      type="button"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.08 + i * 0.07 }}
                      whileHover={{ y: -4, scale: 1.02 }}
                      whileTap={{ scale: 0.97 }}
                      onMouseEnter={() => sound.play('uiHover')}
                      onClick={() => {
                        sound.play('uiClick');
                        gameRef.current.selectUpgrade(opt.id);
                        setUpgradeState(null);
                        vibrate(25);
                      }}
                      className="flex flex-col items-center justify-between gap-2 rounded-xl border border-white/10 bg-slate-800/60 px-4 py-5 text-slate-50 outline-none transition-colors hover:border-cyan-400 hover:bg-slate-800/90 hover:shadow-[0_0_20px_rgba(34,211,238,0.3)] focus-visible:border-cyan-400"
                    >
                      <h3 className="text-xs font-extrabold tracking-wider text-amber-300 sm:text-sm">{opt.title}</h3>
                      <p className="text-[10px] leading-snug text-slate-300 sm:text-[11px]">{opt.description}</p>
                      <span className="w-full rounded-md bg-cyan-400 py-1.5 text-[10px] font-extrabold tracking-[0.15em] text-[#05060f] shadow-[0_0_10px_rgba(34,211,238,0.4)]">
                        SELECT
                      </span>
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Touch controls */}
        {touch && phase === 'playing' && (
          <>
            <Stick side="left" state={moveStick} label="MOVE" />
            <Stick side="right" state={aimStick} label="FIRE" onDouble={() => gameRef.current.dash()} />
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => { if (gameRef.current.bomb()) sound.play('uiClick'); }}
              disabled={hud.bombCharges < 1}
              className="absolute bottom-36 right-3 z-10 h-11 w-11 rounded-full bg-rose-500/25 ring-1 ring-rose-400/50 flex items-center justify-center text-lg disabled:opacity-30 opacity-70 active:opacity-100"
            >
              💣
            </motion.button>
          </>
        )}

        {/* Overlays */}
        <AnimatePresence mode="wait">
          {phase === 'menu' && (
            <Overlay key="menu">
              <motion.h1
                className="text-4xl sm:text-7xl [@media(orientation:landscape)_and_(max-height:500px)]:!text-4xl font-black tracking-tight bg-linear-to-b from-cyan-200 to-fuchsia-400 bg-clip-text text-transparent drop-shadow-[0_0_25px_rgba(34,211,238,0.5)]"
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              >
                NEON VANGUARD
              </motion.h1>
              <p className="text-slate-400 text-xs sm:text-base max-w-md text-center">
                Survive the swarm. Chain kills for combo multipliers. Grab power-ups. Don't die.
              </p>
              <div className="flex items-center gap-3">
                <Btn onClick={start}>▶ START</Btn>
                <motion.button
                  onClick={() => { sound.play('uiClick'); setHangarOpen(true); }}
                  whileHover={{ scale: 1.06 }}
                  whileTap={{ scale: 0.94 }}
                  className="px-6 py-3 rounded-xl font-bold tracking-wider text-amber-200 bg-amber-400/15 ring-1 ring-amber-300/40 shadow-[0_0_20px_-5px_rgba(255,209,102,0.5)]"
                >
                  🛸 HANGAR · 💰{credits.toLocaleString()}
                </motion.button>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px] sm:text-xs text-slate-400 mt-1">
                <span><b className="text-cyan-300">WASD</b> move</span>
                <span><b className="text-cyan-300">LMB</b> aim / fire</span>
                <span><b className="text-cyan-300">RMB</b> move to point</span>
                <span><b className="text-cyan-300">Space</b> dash</span>
                <span><b className="text-cyan-300">Q</b> bomb · <b className="text-cyan-300">Esc</b> pause</span>
                <span><b className="text-cyan-300">M</b> mute</span>
              </div>
              <HighScores scores={scores} />
            </Overlay>
          )}

          {phase === 'paused' && (
            <Overlay key="paused">
              <motion.h2
                className="text-3xl sm:text-5xl font-black text-cyan-300"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              >
                PAUSED
              </motion.h2>
              <Btn onClick={() => { sound.play('uiClick'); setPhaseBoth('playing'); }}>RESUME</Btn>
              <button onClick={start} className="text-slate-400 hover:text-white text-sm underline">Restart (R)</button>
            </Overlay>
          )}

          {phase === 'over' && (
            <Overlay key="over">
              <motion.h2
                initial={{ scale: 0.6, rotate: -4 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 200, damping: 12 }}
                className="text-3xl sm:text-6xl font-black text-rose-400 drop-shadow-[0_0_25px_rgba(244,63,94,0.6)]"
              >
                GAME OVER
              </motion.h2>
              <div className="flex gap-6 sm:gap-10 text-center">
                <Stat label="SCORE" value={hud.score.toLocaleString()} color="text-cyan-300" delay={0.05} />
                <Stat label="LEVEL" value={String(hud.level)} color="text-amber-300" delay={0.1} />
                <Stat label="WAVE" value={String(hud.wave)} color="text-fuchsia-300" delay={0.15} />
                <Stat label="KILLS" value={String(hud.kills)} color="text-amber-300" delay={0.25} />
              </div>
              {isNewHighScore && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="px-3 py-1 rounded-full bg-amber-400/20 text-amber-300 text-xs ring-1 ring-amber-400/40"
                >
                  <motion.span animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 1, repeat: Infinity }}>★ NEW HIGH SCORE</motion.span>
                </motion.div>
              )}
              {unlocked.length > 0 && (
                <div className="flex flex-col items-center gap-1.5">
                  {unlocked.map((ach) => (
                    <motion.div
                      key={ach.id}
                      initial={{ opacity: 0, scale: 0.7, y: 8 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ type: 'spring', stiffness: 260, damping: 16 }}
                      className="rounded-xl border border-green-400/40 bg-green-400/10 px-4 py-1.5 text-center shadow-[0_0_20px_rgba(74,222,128,0.3)]"
                    >
                      <div className="text-[10px] font-extrabold tracking-[0.2em] text-green-300">
                        🏆 {ach.title} — {ach.rewardWeaponName} UNLOCKED
                      </div>
                      <div className="text-[10px] text-slate-300">{ach.description}</div>
                    </motion.div>
                  ))}
                </div>
              )}
              <Btn onClick={start}>⟳ PLAY AGAIN</Btn>
              <div className="flex items-center gap-3">
                <span className="rounded-full bg-amber-400/15 px-3 py-1 text-xs text-amber-200 ring-1 ring-amber-300/30">
                  💰 {credits.toLocaleString()}
                </span>
                <button
                  onClick={() => { sound.play('uiClick'); setHangarOpen(true); }}
                  className="rounded-lg bg-amber-400/15 px-4 py-1.5 text-xs font-bold tracking-wider text-amber-200 ring-1 ring-amber-300/40 hover:bg-amber-400/25"
                >
                  🛸 HANGAR
                </button>
              </div>
              <HighScores scores={scores} />
            </Overlay>
          )}
        </AnimatePresence>

        {/* Hangar — permanent upgrades between runs */}
        <AnimatePresence>
          {hangarOpen && (phase === 'menu' || phase === 'over') && (
            <HangarModal
              key="hangar"
              onClose={() => setHangarOpen(false)}
              onChanged={() => setCredits(SaveManager.get().credits)}
            />
          )}
        </AnimatePresence>

        {/* Portrait blocker — sits above everything on touch devices */}
        <RotateOverlay show={isPortrait} />
      </div>
      <p className="mt-3 text-[10px] sm:text-xs text-slate-600 landscape:hidden">
        {touch
          ? 'Left stick: move · Right stick: aim & fire · double-tap right: dash · 💣 bomb'
          : 'WASD move · Left-click aim & fire · Right-click move to point · Space dash · Q bomb · Esc pause · M mute'}
      </p>
    </div>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#05060f]/80 backdrop-blur-sm p-4 overflow-y-auto"
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -10, scale: 0.98 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex flex-col items-center gap-4 m-auto"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function Btn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <motion.button
      onClick={onClick}
      onMouseEnter={() => sound.play('uiHover')}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.94 }}
      className="px-8 py-3 rounded-xl font-bold tracking-wider text-[#05060f] bg-linear-to-r from-cyan-300 to-fuchsia-400 shadow-[0_0_30px_-5px_rgba(34,211,238,0.8)]"
    >
      {children}
    </motion.button>
  );
}

function Stat({ label, value, color, delay = 0 }: { label: string; value: string; color: string; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }}>
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-xl sm:text-3xl font-bold ${color}`}>{value}</div>
    </motion.div>
  );
}

function HighScores({ scores }: { scores: ScoreRow[] }) {
  if (!scores.length) return null;
  return (
    <div className="w-full max-w-xs mt-1">
      <div className="text-[10px] tracking-[0.3em] text-slate-500 text-center mb-1">HIGH SCORES</div>
      <div className="space-y-0.5">
        {scores.slice(0, 5).map((s, i) => (
          <motion.div
            key={`${s.score}-${s.wave}-${s.date}-${i}`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.04 }}
            className="flex items-center justify-between text-xs px-3 py-1 rounded bg-white/5 ring-1 ring-white/5"
          >
            <span className={i === 0 ? 'text-amber-300' : 'text-slate-500'}>#{i + 1}</span>
            <span className="tabular-nums text-slate-200">{s.score.toLocaleString()}</span>
            <span className="text-slate-500">W{s.wave}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
