/**
 * Neon Vanguard — development performance overlay.
 *
 * Rendered outside React's render path: the game loop writes straight into
 * this component's DOM through a ref, so the overlay updates at 60 Hz without
 * costing a single React render. That is the whole point — an overlay that
 * caused the frame drops it is trying to explain is worse than no overlay.
 *
 * Off by default, and never enabled by a production build: `__DEV__` gates
 * the key handler, and the setting is not persisted when it comes from here.
 */

import { useEffect, useRef } from 'react';
import type { Game } from '../game/engine';
import type { NetworkClient } from '../network/client';

export interface PerfOverlayHandle {
  /** Called once per frame with the current numbers. */
  update: (game: Game, net: NetworkClient | null) => void;
}

function row(label: string, value: string, tone: string): string {
  return `<div class="flex justify-between gap-4"><span class="text-slate-500">${label}</span>` +
         `<span class="${tone} tabular-nums">${value}</span></div>`;
}

function colour(value: number, warn: number, bad: number): string {
  if (value >= bad) return 'text-rose-400';
  if (value >= warn) return 'text-amber-300';
  return 'text-emerald-400';
}

export function PerfOverlay({ game, net, visible }: {
  game: Game | null;
  net: NetworkClient | null;
  visible: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !visible || !game) return;
    // Skip a frame so a cleared DOM node is repopulated immediately.
    let raf = 0;
    const paint = () => {
      const p = game.perf;
      const m = net?.metrics;
      const fps = p.fps;
      const frameMs = p.frameMs;

      const parts = [
        `<div class="text-cyan-300 font-bold tracking-widest mb-1">NEON VANGUARD DEBUG</div>`,
        row('FPS', String(fps), colour(fps, 45, 55)),
        row('FRAME', `${frameMs.toFixed(1)} ms`, colour(frameMs, 17, 22)),
        row('SIM', `${p.simMs.toFixed(2)} ms`, 'text-slate-300'),
        row('RENDER', `${p.renderMs.toFixed(2)} ms`, 'text-slate-300'),
        row('QUALITY', p.quality.toUpperCase(), 'text-slate-300'),
        row('ENTITIES', String(p.enemies), 'text-slate-300'),
        row('PARTICLES', String(p.particles), 'text-slate-300'),
        row('BULLETS', String(p.bullets), 'text-slate-300'),
        row('PICKUPS', String(p.pickups), 'text-slate-300'),
        row('GRID CELLS', String(p.gridCells), 'text-slate-300'),
        row('POOLED', String(p.pooledObjects), 'text-slate-300'),
      ];

      if (m) {
        parts.push('<div class="mt-1 text-cyan-300/70 font-bold tracking-widest">NETWORK</div>');
        parts.push(row('STATUS', m.status.toUpperCase(), 'text-slate-300'));
        parts.push(row('PING', `${m.rttMs} ms`, colour(m.rttMs, 80, 150)));
        parts.push(row('SERVER', `${m.serverTps} tps`, colour(m.serverTps, 55, 30)));
        parts.push(row('PACKET', `${(m.lossRatio * 100).toFixed(1)}%`,
                       m.lossRatio > 0.05 ? 'text-rose-400' : 'text-slate-300'));
        parts.push(row('TICK', String(m.serverTick), 'text-slate-300'));
        parts.push(row('UP/DOWN', `${fmtBytes(m.bytesReceived)} / ${fmtBytes(m.bytesSent)}`, 'text-slate-300'));
        parts.push(row('SNAPSHOTS', String(m.snapshotsReceived), 'text-slate-300'));
        parts.push(row('REJECTED', String(m.rateLimited + m.invalidInputs),
                       m.rateLimited + m.invalidInputs > 0 ? 'text-amber-300' : 'text-slate-300'));
      }

      node.innerHTML = parts.join('');
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [game, net, visible]);

  if (!visible) return null;

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute left-2 top-1/2 z-50 -translate-y-1/2 rounded-lg border border-cyan-400/30 bg-black/80 px-3 py-2 font-mono text-[10px] leading-relaxed backdrop-blur-sm"
      aria-hidden
    />
  );
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
