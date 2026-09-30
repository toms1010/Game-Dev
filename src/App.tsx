/**
 * Neon Vanguard — application shell.
 *
 * Owns the game loop, the input plumbing and the screen routing. Three rules
 * shape everything in this file:
 *
 *  1. **The loop never calls setState.** It writes to the game object and to
 *     the external stores in `game/store.ts`, which notify React at a fixed
 *     low rate and only when a displayed value actually changed. A React
 *     render per frame is the fastest way to make a 60 Hz game feel like
 *     20 Hz on a phone.
 *  2. **The loop never blocks.** No awaits, no allocation in the steady
 *     state, no I/O. Anything slow belongs on a worker.
 *  3. **Offline is the default, not a fallback.** The network client is
 *     additive: if it never connects, everything below still plays a complete
 *     single-player game.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Game, emptyInput, detectQuality, type Input, type WeaponUpgrade } from './game/engine';
import { Stick, type StickState } from './ui/Stick';
import { HangarModal } from './ui/HangarModal';
import { RotateOverlay } from './ui/RotateOverlay';
import { AmbientBackground } from './ui/AmbientBackground';
import { ActionRail, NavRail, StatusBar, StatusChips, ThumbGuides, type NavTab } from './ui/Cockpit';
import { LoadoutScreen, SettingsScreen, StatsScreen } from './ui/LoadoutScreen';
import { PerfOverlay } from './ui/PerfOverlay';
import { useOrientationLock } from './game/useOrientationLock';
import { SaveManager, ACHIEVEMENTS, type Achievement } from './game/saveSystem';
import { sound } from './game/sound';
import { vibrate } from './game/haptics';
import { hudStore, netStore, settingsStore, useHud, useNet, useSettings } from './game/store';
import { NetworkClient } from './network/client';

type Phase = 'menu' | 'playing' | 'paused' | 'over';
type ScoreRow = { score: number; wave: number; date: string };

const SCORES_KEY = 'neon-vanguard-scores';
const loadScores = (): ScoreRow[] => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(SCORES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is ScoreRow =>
      typeof r === 'object' && r !== null &&
      typeof (r as ScoreRow).score === 'number' &&
      typeof (r as ScoreRow).wave === 'number' &&
      typeof (r as ScoreRow).date === 'string');
  } catch { return []; }
};

/** How often the HUD is allowed to re-render. */
const HUD_INTERVAL_MS = 100;
/** How often the network status pill refreshes. */
const NET_INTERVAL_MS = 500;

export default function App() {
  // --- game + input, all mutable refs, never React state ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [game] = useState(() => new Game(detectQuality()));
  const gameRef = useRef<Game>(game);
  const inputRef = useRef<Input>(emptyInput());
  const phaseRef = useRef<Phase>('menu');
  const moveStick = useRef<StickState>({ x: 0, y: 0, active: false });
  const aimStick = useRef<StickState>({ x: 0, y: 0, active: false });
  const lastFrameRef = useRef(0);

  // --- discrete UI state: phases and screens, changed by user action ---
  const [phase, setPhase] = useState<Phase>('menu');
  const [tab, setTab] = useState<NavTab>('home');
  const [upgradeState, setUpgradeState] = useState<{ options: WeaponUpgrade[]; key: number } | null>(null);
  const [credits, setCredits] = useState(() => SaveManager.get().credits);
  const [unlocked, setUnlocked] = useState<Achievement[]>([]);
  const [newHigh, setNewHigh] = useState(false);
  const [hangarOpen, setHangarOpen] = useState(false);
  const [netEnabled, setNetEnabled] = useState(true);

  // --- stores ---
  const hud = useHud();
  const net = useNet();
  const settings = useSettings();

  // --- network ---
  const netRef = useRef<NetworkClient | null>(null);
  if (netRef.current === null && netEnabled && typeof WebSocket !== 'undefined') {
    const serverUrl = resolveServerUrl();
    if (serverUrl) {
      netRef.current = new NetworkClient({ url: serverUrl, name: pilotName() });
      netRef.current.attach(game);
    }
  }
  const netClient = netRef.current;

  // ==========================================================================
  // Input plumbing
  // ==========================================================================

  const clearInput = useCallback(() => {
    const input = inputRef.current;
    input.up = false; input.down = false; input.left = false; input.right = false;
    input.move.x = 0; input.move.y = 0;
    input.firing = false; input.aim = null;
    moveStick.current = { x: 0, y: 0, active: false };
    aimStick.current = { x: 0, y: 0, active: false };
  }, []);

  const setPhaseBoth = useCallback((next: Phase) => {
    if (next !== 'playing') {
      // Drop every held input on the way out, or the ship keeps drifting after
      // a pause because a key-up was swallowed by the overlay.
      gameRef.current.reticle = null;
      gameRef.current.moveTarget = null;
      clearInput();
    }
    phaseRef.current = next;
    setPhase(next);
  }, [clearInput]);

  const isPlaying = useCallback(() => phaseRef.current === 'playing', []);
  const { touch, isPortrait, requestLandscape } = useOrientationLock({
    onForcePause: () => {
      if (phaseRef.current === 'playing') {
        sound.stopMusic();
        setPhaseBoth('paused');
      }
    },
    isPlaying,
  });

  // ==========================================================================
  // Lifecycle effects
  // ==========================================================================

  // Audio unlock on the first gesture — browsers require it.
  useEffect(() => {
    const unlock = () => {
      sound.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (phase === 'playing') sound.startMusic();
    else sound.stopMusic();
  }, [phase]);

  // Pause when the player leaves. Being shot at by a notification is not a
  // fair way to lose a run.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && phaseRef.current === 'playing') {
        sound.stopMusic();
        setPhaseBoth('paused');
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', onHide);
    };
  }, [setPhaseBoth]);

  // Push settings into the engine and the audio system.
  useEffect(() => {
    gameRef.current.setQuality(settings.quality);
  }, [settings.quality]);
  useEffect(() => {
    sound.setMuted(settings.muted);
  }, [settings.muted]);

  // ==========================================================================
  // Actions
  // ==========================================================================

  const start = useCallback(async () => {
    sound.unlock();
    if (touch) {
      try {
        const el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen();
      } catch { /* fullscreen can be refused; the rotate overlay is the fallback */ }
      requestLandscape();
    }

    const g = new Game(touch ? 'low' : detectQuality());
    g.initRun(SaveManager.get().upgrades);
    g.onSound = (name) => {
      sound.play(name);
      if (!settingsStore.getSnapshot().hapticFeedback) return;
      if (name === 'hitPlayer') vibrate(60);
      else if (name === 'explodeBig') vibrate(40);
      else if (name === 'gameOver') vibrate([80, 60, 80]);
    };
    g.onWave = () => vibrate(30);
    g.onLevel = () => vibrate([40, 40, 80]);
    g.onUpgradePending = () => { setUpgradeState({ options: g.upgradeOptions, key: Date.now() }); vibrate([30, 40, 30]); };
    g.onBomb = () => vibrate([50, 30, 50]);
    gameRef.current = g;
    // Carry the viewport across the swap so the new arena matches the screen
    // immediately rather than letterboxing for a frame.
    const surface = surfaceRef.current;
    if (surface) g.setViewport(surface.clientWidth, surface.clientHeight);

    inputRef.current = emptyInput();
    moveStick.current = { x: 0, y: 0, active: false };
    aimStick.current = { x: 0, y: 0, active: false };
    netClient?.attach(g);

    sound.play('uiClick');
    setUpgradeState(null);
    setHangarOpen(false);
    setUnlocked([]);
    setNewHigh(false);
    setPhaseBoth('playing');
  }, [touch, requestLandscape, setPhaseBoth, netClient]);

  const submit = useCallback((stats: { finalScore: number; kills: number; bossesKilled: number; wavesCleared: number }) => {
    const next = [...loadScores(), { score: stats.finalScore, wave: gameRef.current.wave, date: new Date().toISOString().slice(0, 10) }]
      .sort((a, b) => b.score - a.score).slice(0, 8);
    try { localStorage.setItem(SCORES_KEY, JSON.stringify(next)); } catch { /* quota */ }

    const { newHighScore, unlockedAchievements } = SaveManager.recordRun(stats);
    setCredits(SaveManager.get().credits);
    setNewHigh(newHighScore);
    setUnlocked(unlockedAchievements);
    gameRef.current.celebrateAchievements(unlockedAchievements);
    hudStore.flush();
  }, []);

  const togglePause = useCallback(() => {
    if (phaseRef.current === 'playing') { sound.play('uiClick'); setPhaseBoth('paused'); }
    else if (phaseRef.current === 'paused') { sound.play('uiClick'); setPhaseBoth('playing'); }
  }, [setPhaseBoth]);

  const useBomb = useCallback(() => {
    if (gameRef.current.bomb()) sound.play('uiClick');
  }, []);

  // ==========================================================================
  // The loop
  // ==========================================================================

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;

    const activeGame = () => gameRef.current;

    /**
     * Matches the canvas backing store to its CSS box, and reshapes the arena
     * to match that box's aspect ratio.
     *
     * A ResizeObserver is used rather than a window resize listener: on
     * mobile the surface changes size when the address bar collapses, when
     * the notch insets change, and when the device rotates — none of which
     * reliably fire `resize` on the element itself.
     */
    const resize = () => {
      const rect = surface.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;

      const g = activeGame();
      g.setViewport(rect.width, rect.height);

      // DPR is capped: a 3x backing store on a 1080p phone is 3x the fill
      // cost for no visible gain at arm's length, and it is the single
      // biggest source of frame drops on mid-range Android.
      const rawDpr = window.devicePixelRatio || 1;
      const dpr = Math.min(rawDpr, touch ? 1.5 : 2) * QUALITY_RENDER_SCALE[g.quality];
      const width = Math.max(2, Math.round(rect.width * dpr));
      const height = Math.max(2, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    window.addEventListener('orientationchange', resize);
    window.addEventListener('resize', resize);

    let raf = 0;
    let hudAccumulator = 0;
    let netAccumulator = 0;
    let last = performance.now();
    lastFrameRef.current = last;
    const overHandled = { value: false };
    const overTimeout = { value: null as number | null };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const frameMs = now - last;
      last = now;
      const dt = Math.min(0.05, frameMs / 1000);
      const g = activeGame();
      const ph = phaseRef.current;
      const input = inputRef.current;

      // ---- 1. resolve input into the shared Input struct ----
      if (ph === 'playing') {
        if (moveStick.current.active) {
          input.move.x = moveStick.current.x;
          input.move.y = moveStick.current.y;
          if (!g.netMode) g.moveTarget = null;
        } else {
          input.move.x = 0; input.move.y = 0;
        }
        if (aimStick.current.active) {
          const a = aimStick.current;
          const aimX = g.player.x + a.x * 260;
          const aimY = g.player.y + a.y * 260;
          input.aim = { x: aimX, y: aimY };
          input.firing = true;
          g.reticle = { x: aimX, y: aimY };
          g.reticleColor = '#e879f9';
        } else if (touch || g.netMode) {
          // Stick released: stop firing and hide the reticle. A mouse keeps
          // its reticle, because the cursor is still the aim point.
          input.firing = false;
          if (touch) g.reticle = null;
        }
      }

      // ---- 2. predict, then simulate ----
      const frameStart = performance.now();
      if (ph === 'playing') {
        // Prediction runs before the simulation so the ship moves on the same
        // frame the input was sampled, not one frame later.
        if (g.netMode && netClient) {
          netClient.predict(dt, input.move, input.aim ?? { x: g.player.x, y: g.player.y }, input.firing);
        }
        g.update(dt, input);

        if (g.over && !overHandled.value) {
          overHandled.value = true;
          submit(g.runStats());
          // A short beat so the death animation reads before the overlay.
          overTimeout.value = window.setTimeout(() => {
            overTimeout.value = null;
            setPhaseBoth('over');
          }, 900);
        }
        hudAccumulator += frameMs;
      } else {
        // Ambient only: stars drift, death effects finish, nothing spawns.
        g.updateAmbient(dt);
        hudAccumulator += frameMs;
      }
      const simMs = performance.now() - frameStart;

      // ---- 3. render ----
      const renderStart = performance.now();
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // Fill the whole bitmap first so any letterbox bar (which only appears
        // beyond the supported aspect range) matches the page background
        // instead of showing through.
        ctx.fillStyle = '#05060f';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / g.W, canvas.height / g.H);
        ctx.setTransform(scale, 0, 0, scale,
          (canvas.width - g.W * scale) / 2,
          (canvas.height - g.H * scale) / 2);
        g.render(ctx);
      } catch { /* a render fault must not take the loop down */ }
      const renderMs = performance.now() - renderStart;

      // ---- 4. metrics, off the React path ----
      g.sampleFrame(frameMs, simMs, renderMs);
      // Only downgrade when the player has not pinned a tier in settings.
      g.autoTune(frameMs, Math.max(1000 / 30, frameMs), settingsStore.getSnapshot().qualityPinned);

      // ---- 5. push to the stores, rate limited and change detected ----
      if (hudAccumulator >= HUD_INTERVAL_MS) {
        hudAccumulator = 0;
        hudStore.update({
          score: g.score, hp: g.player.hp, maxHp: g.player.maxHp,
          wave: g.wave, level: g.level, enemiesLeft: g.waveEnemiesRemaining,
          combo: g.combo, power: g.power, kills: g.kills,
          shield: g.player.shield, rapid: g.player.rapid,
          bombCharges: g.player.bombCharges, weapon: g.weapon,
        }, now);
      }

      if (netClient) {
        netClient.step(dt);
        netAccumulator += frameMs;
        if (netAccumulator >= NET_INTERVAL_MS) {
          netAccumulator = 0;
          const m = netClient.metrics;
          netStore.update({
            status: m.status, rttMs: m.rttMs, serverTps: m.serverTps,
            lossRatio: m.lossRatio, match: netClient.match,
            players: g.netMode ? g.remotePlayers.length + 1 : 0,
          }, now);
        }
      }

      lastFrameRef.current = now;
    };

    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('orientationchange', resize);
      window.removeEventListener('resize', resize);
      if (overTimeout.value !== null) window.clearTimeout(overTimeout.value);
    };
  }, [touch, submit, setPhaseBoth, netClient]);

  // ==========================================================================
  // Network lifecycle
  // ==========================================================================

  useEffect(() => {
    if (!netClient) return;
    netClient.connect();
    return () => netClient.disconnect();
  }, [netClient]);

  useEffect(() => {
    if (!netClient) return;
    if (net.status === 'connected' && phaseRef.current === 'playing' && !gameRef.current.netMode) {
      gameRef.current.setNetMode(true);
    }
  }, [net.status, netClient]);

  // ==========================================================================
  // Keyboard
  // ==========================================================================

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const i = inputRef.current;
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (k === 'w' || k === 'arrowup') i.up = true;
      if (k === 's' || k === 'arrowdown') i.down = true;
      if (k === 'a' || k === 'arrowleft') i.left = true;
      if (k === 'd' || k === 'arrowright') i.right = true;
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        gameRef.current.moveTarget = null;
      }
      if (phaseRef.current === 'playing') {
        if ((k === 'shift' || k === ' ') && !e.repeat) gameRef.current.dash();
        if ((k === 'q' || k === 'f') && !e.repeat) useBomb();
      }
      if (k === 'm') settingsStore.set({ muted: !settingsStore.getSnapshot().muted });
      if (e.key === '`' || e.key === 'F3') {
        e.preventDefault();
        gameRef.current.toggleDebug();
        settingsStore.set({ debugOverlay: !settingsStore.getSnapshot().debugOverlay });
      }
      if (k === 'escape' || k === 'p') togglePause();
      if (k === 'enter' && (phaseRef.current === 'menu' || phaseRef.current === 'over')) start();
      if (k === 'r' && (phaseRef.current === 'over' || phaseRef.current === 'paused')) start();
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const i = inputRef.current;
      if (k === 'w' || k === 'arrowup') i.up = false;
      if (k === 's' || k === 'arrowdown') i.down = false;
      if (k === 'a' || k === 'arrowleft') i.left = false;
      if (k === 'd' || k === 'arrowright') i.right = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [start, togglePause, useBomb]);

  // ==========================================================================
  // Screen-space input (desktop)
  // ==========================================================================

  /** Inverse of the render transform, so a click maps to an arena point. */
  const toWorld = useCallback((e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    const g = gameRef.current;
    if (!el) return { x: g.W / 2, y: g.H / 2 };
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { x: g.W / 2, y: g.H / 2 };
    const scale = Math.min(r.width / g.W, r.height / g.H);
    const ox = (r.width - g.W * scale) / 2;
    const oy = (r.height - g.H * scale) / 2;
    return {
      x: clamp(e.clientX - r.left - ox, 0, g.W) / scale,
      y: clamp(e.clientY - r.top - oy, 0, g.H) / scale,
    };
  }, []);

  const inGame = phase === 'playing' || phase === 'paused';
  const lowHp = hud.hp > 0 && hud.hp <= hud.maxHp * 0.3;

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <div
      className="relative min-h-dvh w-full select-none overflow-hidden text-slate-100
                 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      {!touch && <AmbientBackground />}

      <div
        ref={surfaceRef}
        className="game-surface relative mx-auto w-full overflow-hidden
                   portrait:aspect-8/5 portrait:max-h-[88dvh] portrait:rounded-xl
                   landscape:h-dvh"
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            sound.unlock();
            if (e.pointerType === 'touch') return;
            e.currentTarget.setPointerCapture(e.pointerId);
            if (e.button === 2) {
              if (phaseRef.current !== 'playing') return;
              e.preventDefault();
              const w = toWorld(e);
              gameRef.current.moveTarget = w;
              inputRef.current.firing = false;
              return;
            }
            const w = toWorld(e);
            inputRef.current.aim = w;
            gameRef.current.reticle = w;
            gameRef.current.reticleColor = '#7df9ff';
            if (phaseRef.current === 'playing') inputRef.current.firing = true;
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch') return;
            if (e.buttons & 2) { gameRef.current.moveTarget = toWorld(e); return; }
            const w = toWorld(e);
            inputRef.current.aim = w;
            gameRef.current.reticle = w;
            gameRef.current.reticleColor = '#7df9ff';
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch') return;
            if (e.button === 0) inputRef.current.firing = false;
            try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch') return;
            inputRef.current.firing = false;
            gameRef.current.reticle = null;
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'touch') return;
            inputRef.current.firing = false;
            gameRef.current.reticle = null;
          }}
        />

        {/* Low-hull vignette */}
        {inGame && lowHp && (
          <motion.div
            className="pointer-events-none absolute inset-0"
            style={{ boxShadow: 'inset 0 0 120px 20px rgba(244,63,94,0.5)' }}
            animate={{ opacity: [0.3, 0.85, 0.3] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* --- persistent chrome --- */}
        <StatusBar
          hud={hud}
          net={net}
          quality={settings.quality.toUpperCase()}
          muted={settings.muted}
          onToggleMute={() => settingsStore.set({ muted: !settings.muted })}
        />
        {inGame && <StatusChips hud={hud} />}

        <NavRail
          active={tab}
          onSelect={(next) => {
            sound.play('uiClick');
            // ARMS is the hangar, which is a modal over the loadout rather
            // than a tab of its own.
            if (next === 'arms') { setHangarOpen(true); return; }
            setTab(next);
          }}
          disabled={phase === 'playing'}
        />
        {inGame && (
          <ActionRail
            paused={phase === 'paused'}
            onPause={togglePause}
            onBomb={useBomb}
            bombCharges={hud.bombCharges}
            onDebug={() => {
              gameRef.current.toggleDebug();
              settingsStore.set({ debugOverlay: !settingsStore.getSnapshot().debugOverlay });
            }}
            debugOn={settings.debugOverlay}
          />
        )}

        {/* --- touch controls --- */}
        {touch && phase === 'playing' && (
          <>
            <Stick side="left" state={moveStick} label="MOVE" />
            <Stick side="right" state={aimStick} label="FIRE" onDouble={() => gameRef.current.dash()} />
          </>
        )}
        {phase === 'menu' && <ThumbGuides visible />}

        {/* --- screens --- */}
        {phase === 'menu' && tab === 'home' && (
          <LoadoutScreen
            credits={credits}
            upgrades={SaveManager.get().upgrades}
            unlockedWeapons={SaveManager.get().unlockedWeapons}
            achievements={ACHIEVEMENTS}
            highScore={SaveManager.get().highScore}
            totalKills={SaveManager.get().totalKills}
            wavesCleared={SaveManager.get().wavesCleared}
            onDeploy={start}
            onOpenHangar={() => setHangarOpen(true)}
            onOpenStats={() => setTab('inv')}
            quality={settings.quality}
            onQuality={(q) => settingsStore.set({ quality: q })}
          />
        )}
        {phase === 'menu' && tab === 'inv' && (
          <StatsScreen
            onBack={() => setTab('home')}
            totalKills={SaveManager.get().totalKills}
            bossesDefeated={SaveManager.get().bossesDefeated}
            wavesCleared={SaveManager.get().wavesCleared}
            gamesPlayed={SaveManager.get().gamesPlayed}
            highScore={SaveManager.get().highScore}
            credits={credits}
            unlockedWeapons={SaveManager.get().unlockedWeapons}
          />
        )}
        {phase === 'menu' && tab === 'set' && (
          <SettingsScreen
            onBack={() => setTab('home')}
            settings={settings}
            onToggleMute={() => settingsStore.set({ muted: !settings.muted })}
            onToggleDebug={() => {
              gameRef.current.toggleDebug();
              settingsStore.set({ debugOverlay: !settingsStore.getSnapshot().debugOverlay });
            }}
            onQuality={(q) => settingsStore.set({ quality: q })}
            onResetProgress={() => { SaveManager.reset(); setCredits(0); }}
            onToggleNetwork={() => setNetEnabled((v) => !v)}
          />
        )}

        {/* --- in-run overlays --- */}
        <AnimatePresence>
          {phase === 'paused' && (
            <Dimmed key="paused">
              <motion.h2
                className="text-[clamp(24px,7vh,52px)] font-black text-cyan-300"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              >
                PAUSED
              </motion.h2>
              <div className="flex gap-3">
                <BigBtn onClick={togglePause}>RESUME</BigBtn>
                <BigBtn onClick={start} tone="ghost">RESTART</BigBtn>
              </div>
              {touch && (
                <p className="text-center text-[10px] text-slate-500">
                  Left stick move · Right stick aim &amp; fire · double-tap right to dash
                </p>
              )}
            </Dimmed>
          )}

          {phase === 'over' && (
            <Dimmed key="over">
              <motion.h2
                initial={{ scale: 0.7, rotate: -3 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 200, damping: 12 }}
                className="text-[clamp(26px,8vh,60px)] font-black text-rose-400"
              >
                GAME OVER
              </motion.h2>
              <div className="flex gap-4 text-center sm:gap-8">
                <Stat label="SCORE" value={hud.score.toLocaleString()} tone="text-cyan-300" />
                <Stat label="LEVEL" value={String(hud.level)} tone="text-amber-300" />
                <Stat label="WAVE" value={String(hud.wave)} tone="text-fuchsia-300" />
                <Stat label="KILLS" value={String(hud.kills)} tone="text-amber-300" />
              </div>
              {newHigh && (
                <motion.p
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ duration: 1, repeat: Infinity }}
                  className="rounded-full bg-amber-400/20 px-3 py-1 text-[clamp(9px,1.6vh,12px)] font-bold tracking-widest text-amber-300"
                >
                  ★ NEW HIGH SCORE
                </motion.p>
              )}
              {unlocked.map((ach) => (
                <div key={ach.id} className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-center">
                  <div className="text-[clamp(8px,1.5vh,11px)] font-bold tracking-widest text-emerald-300">
                    🏆 {ach.rewardWeaponName} UNLOCKED
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <BigBtn onClick={start}>PLAY AGAIN</BigBtn>
                <BigBtn onClick={() => setTab('inv')} tone="ghost">STATS</BigBtn>
              </div>
            </Dimmed>
          )}
        </AnimatePresence>

        {/* --- wave-clear upgrade choice --- */}
        <AnimatePresence>
          {upgradeState && phase === 'playing' && (
            <motion.div
              key={`upgrade-${upgradeState.key}`}
              role="dialog"
              aria-modal="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 flex items-center justify-center overflow-y-auto
                         bg-[#05060f]/80 p-3 backdrop-blur-md"
            >
              <div className="m-auto w-full max-w-3xl rounded-2xl border border-cyan-400/30
                              bg-slate-900/80 p-4 text-center">
                <span className="inline-block rounded-full border border-emerald-400/30 bg-emerald-400/10
                                 px-3 py-0.5 text-[9px] font-extrabold tracking-[0.2em] text-emerald-400">
                  WAVE {hud.wave} CLEARED
                </span>
                <h2 className="mt-2 text-[clamp(14px,3vh,24px)] font-black tracking-[0.15em] text-cyan-300">
                  SELECT WEAPON UPGRADE
                </h2>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {upgradeState.options.map((opt) => (
                    <motion.button
                      key={opt.id}
                      type="button"
                      whileHover={{ y: -3 }}
                      whileTap={{ scale: 0.97 }}
                      onMouseEnter={() => sound.play('uiHover')}
                      onClick={() => {
                        sound.play('uiClick');
                        gameRef.current.selectUpgrade(opt.id);
                        setUpgradeState(null);
                        vibrate(25);
                      }}
                      className="flex flex-col items-center gap-1.5 rounded-xl border border-white/10
                                 bg-slate-800/70 px-3 py-3 hover:border-cyan-400/30"
                    >
                      <span className="text-[clamp(10px,1.9vh,13px)] font-extrabold tracking-wider text-amber-300">
                        {opt.title}
                      </span>
                      <span className="text-[10px] leading-snug text-slate-300">{opt.description}</span>
                      <span className="w-full rounded bg-cyan-400 py-1 text-[9px] font-extrabold tracking-[0.15em] text-[#05060f]">
                        SELECT
                      </span>
                    </motion.button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {hangarOpen && phase === 'menu' && (
            <HangarModal
              key="hangar"
              onClose={() => setHangarOpen(false)}
              onChanged={() => setCredits(SaveManager.get().credits)}
            />
          )}
        </AnimatePresence>

        <PerfOverlay game={gameRef.current} net={netClient} visible={settings.debugOverlay} />
        <RotateOverlay show={isPortrait} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const QUALITY_RENDER_SCALE: Record<'low' | 'medium' | 'high', number> = {
  low: 0.85,
  medium: 1,
  high: 1,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The game server's endpoint.
 *
 * Defaults to the same origin, which is what a dev server proxy or a
 * reverse-provisioned deployment provides. `VITE_NEON_SERVER` overrides it for
 * a server on another host; without it, and without a same-origin server, the
 * game simply stays offline.
 */
function resolveServerUrl(): string | null {
  const configured = (import.meta.env?.VITE_NEON_SERVER as string | undefined) ?? '';
  if (configured) return configured;
  if (typeof location === 'undefined') return null;
  // Opened straight off disk (the single-file bundle in the Expo WebView) the
  // origin is `file://` and `host` is empty, which would produce the nonsense
  // url "ws:///ws/game" and a reconnect loop. No host means no server.
  if (!location.host) return null;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/game`;
}

function pilotName(): string {
  const key = 'neon-vanguard-pilot';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const name = `PILOT-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    localStorage.setItem(key, name);
    return name;
  } catch {
    return 'PILOT';
  }
}

function Dimmed({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3
                 overflow-y-auto bg-[#05060f]/85 p-4 backdrop-blur-sm"
    >
      <div className="m-auto flex flex-col items-center gap-3">{children}</div>
    </motion.div>
  );
}

function BigBtn({ children, onClick, tone = 'primary' }: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'primary' | 'ghost';
}) {
  return (
    <motion.button
      onClick={onClick}
      onMouseEnter={() => sound.play('uiHover')}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.95 }}
      className={`rounded-xl px-6 py-2.5 text-[clamp(11px,2.2vh,16px)] font-bold tracking-widest ${
        tone === 'primary'
          ? 'bg-gradient-to-r from-cyan-300 to-fuchsia-400 text-[#05060f]'
          : 'border border-white/15 bg-white/5 text-slate-300'}`}
    >
      {children}
    </motion.button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <div className="text-[clamp(8px,1.3vh,10px)] text-slate-500">{label}</div>
      <div className={`text-[clamp(14px,3.4vh,30px)] font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
