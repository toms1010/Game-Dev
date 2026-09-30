/**
 * Neon Vanguard — canvas renderer.
 *
 * Draws the arena for a given `Game` into a 2D context whose transform is
 * already set to arena space (1 arena unit = 1 context unit). The renderer is
 * a pure function of game state: it never mutates the simulation, so a frame
 * can be replayed for screenshots or a netcode rollback without side effects.
 *
 * Cost control comes from the active quality profile (`game.fx`): glow
 * (`ctx.shadowBlur`) is by far the most expensive operation in the whole
 * renderer, so it is the first thing the low tier switches off.
 */

import { REMOTE_COLORS, TAU, type Enemy } from './entities';
import type { Game } from './engine';

const PICKUP_COLOR: Record<string, string> = {
  health: '#4ade80', power: '#ffd166', shield: '#38bdf8', rapid: '#f472b6', freeze: '#a5f3fc',
};

const ENEMY_SIDES: Record<string, number> = {
  grunt: 3, rusher: 3, shooter: 5, tank: 6, splitter: 4, healer: 6, boss: 8,
};

export function renderGame(g: Game, ctx: CanvasRenderingContext2D): void {
  const fx = g.fx;
  const W = g.W, H = g.H;

  ctx.save();

  // No clearRect here: the arena is painted edge to edge by the radial
  // gradient below (opaque at both stops), and the host already fills any
  // letterbox bars with the background colour.
  const grad = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.72);
  grad.addColorStop(0, '#131a35');
  grad.addColorStop(1, '#05060f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const sh = g.shake;
  if (sh > 0.01) ctx.translate(randShake(-sh, sh), randShake(-sh, sh));

  // --- parallax starfield ---
  for (let i = 0; i < g.stars.length; i++) {
    const s = g.stars[i]!;
    ctx.globalAlpha = 0.25 + s.z * 0.55;
    ctx.fillStyle = '#9fd3ff';
    ctx.fillRect(s.x, s.y, s.z * 2, s.z * 2);
  }
  ctx.globalAlpha = 1;

  // --- neon floor grid, breathing slowly ---
  if (fx.grid) {
    const gridPulse = 0.06 + Math.sin(g.time * 1.5) * 0.02;
    ctx.strokeStyle = `rgba(80,140,220,${gridPulse})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 48) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += 48) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'lighter';

  drawShockwaves(g, ctx, fx.shadows);
  drawMoveTarget(g, ctx, fx.shadows);
  drawDashGhosts(g, ctx, fx.shadows);
  drawParticles(g, ctx, fx.shadows);
  drawPickups(g, ctx, fx.shadows);
  drawEnemies(g, ctx, fx.shadows);
  drawBullets(g, ctx, fx);

  if (!g.over) {
    drawRemotePlayers(g, ctx, fx);
    drawPlayer(g, ctx, fx);
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;

  drawPops(g, ctx, fx.shadows);
  drawFullScreenFx(g, ctx);
  drawLowHpVignette(g, ctx);
  drawDebugGrid(g, ctx);

  ctx.restore();
}

// ---------------------------------------------------------------------------

function randShake(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function drawShockwaves(g: Game, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  for (let i = 0; i < g.shockwaves.length; i++) {
    const sw = g.shockwaves[i]!;
    const a = Math.max(0, sw.life / sw.maxLife);
    ctx.globalAlpha = a;
    ctx.strokeStyle = sw.color;
    ctx.lineWidth = sw.width * a;
    if (shadows) { ctx.shadowBlur = 20; ctx.shadowColor = sw.color; }
    ctx.beginPath();
    ctx.arc(sw.x, sw.y, sw.r, 0, TAU);
    if (sw.fill) { ctx.fillStyle = sw.color; ctx.fill(); } else ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}

/** Dashed trail + pulsing ring showing the click-to-move destination. */
function drawMoveTarget(g: Game, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  const mt = g.moveTarget;
  if (!mt || g.over) return;
  const p = g.player;

  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = '#4ade80';
  ctx.setLineDash([5, 8]);
  ctx.lineWidth = 1.5;
  if (shadows) { ctx.shadowBlur = 6; ctx.shadowColor = '#4ade80'; }
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(mt.x, mt.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const tt = g.time * 4;
  const pulse = 1 + Math.sin(tt) * 0.15;
  ctx.save();
  ctx.translate(mt.x, mt.y);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = '#4ade80';
  if (shadows) { ctx.shadowBlur = 16; ctx.shadowColor = '#4ade80'; }
  ctx.lineWidth = 2;

  ctx.beginPath(); ctx.arc(0, 0, 12 * pulse, 0, TAU); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-6, 0); ctx.lineTo(6, 0);
  ctx.moveTo(0, -6); ctx.lineTo(0, 6);
  ctx.stroke();

  ctx.globalAlpha = 0.45;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.arc(0, 0, 20 * pulse, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);

  if (shadows) {
    for (let i = 0; i < 3; i++) {
      const a = -tt + (i / 3) * TAU;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 16 * pulse, Math.sin(a) * 16 * pulse, 1.8, 0, TAU);
      ctx.fillStyle = '#4ade80';
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function drawDashGhosts(g: Game, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  for (let i = 0; i < g.ghosts.length; i++) {
    const gh = g.ghosts[i]!;
    ctx.globalAlpha = Math.max(0, gh.life / gh.max) * 0.55;
    ctx.save();
    ctx.translate(gh.x, gh.y);
    ctx.rotate(gh.angle);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    if (shadows) { ctx.shadowBlur = 10; ctx.shadowColor = '#38bdf8'; }
    ctx.beginPath();
    ctx.moveTo(20, 0); ctx.lineTo(-12, -13); ctx.lineTo(-6, 0); ctx.lineTo(-12, 13);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function drawParticles(g: Game, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  for (let i = 0; i < g.particles.length; i++) {
    const pt = g.particles[i]!;
    const a = Math.max(0, pt.life / pt.max);
    ctx.globalAlpha = a;
    ctx.fillStyle = pt.color;
    const doGlow = shadows && pt.glow === true && pt.r * a > 1.5;
    if (doGlow) { ctx.shadowBlur = 12; ctx.shadowColor = pt.color; }

    if (pt.shape === 'spark') {
      const len = Math.min(8, Math.hypot(pt.vx, pt.vy) * 0.02) + 2;
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(Math.atan2(pt.vy, pt.vx));
      ctx.fillRect(-len, -pt.r * a * 0.5, len * 2, pt.r * a);
      ctx.restore();
    } else if (pt.shape === 'star' && pt.spin !== undefined) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.spin);
      const rr = pt.r * a + 1;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * TAU;
        const rad = k % 2 === 0 ? rr : rr * 0.4;
        const px = Math.cos(ang) * rad, py = Math.sin(ang) * rad;
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.r * a + 0.4, 0, TAU);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}

function drawPickups(g: Game, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  for (let i = 0; i < g.pickups.length; i++) {
    const k = g.pickups[i]!;
    const c = PICKUP_COLOR[k.kind] ?? '#ffffff';
    const pulse = 1 + Math.sin(k.t * 7) * 0.15;
    ctx.save();
    ctx.translate(k.x, k.y);
    ctx.rotate(k.t * 2);
    if (shadows) { ctx.shadowBlur = 18; ctx.shadowColor = c; }
    ctx.strokeStyle = c;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let j = 0; j < 4; j++) {
      const a = (j / 4) * TAU;
      const r = k.r * pulse;
      if (j) ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.rotate(-k.t * 3);
    if (shadows) ctx.shadowBlur = 12;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(0, 0, 3 + Math.sin(k.t * 9) * 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.shadowBlur = 0;
}

function drawEnemies(g: Game, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i]!;
    ctx.save();
    // Pop-in scale as the enemy fades in, so spawns read as arrivals.
    const spawnScale = Math.min(1, e.pulse * 3);
    ctx.translate(e.x, e.y);
    ctx.scale(spawnScale, spawnScale);
    ctx.rotate(e.kind === 'rusher' ? Math.atan2(e.vy, e.vx) : e.spin);
    if (shadows) { ctx.shadowBlur = 16; ctx.shadowColor = e.color; }
    const flash = e.hit > 0;
    ctx.strokeStyle = flash ? '#ffffff' : (e.freeze > 0 || g.freezeTimer > 0 ? '#a5f3fc' : e.color);
    ctx.fillStyle = flash ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 3;
    const sides = ENEMY_SIDES[e.kind] ?? 3;
    ctx.beginPath();
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * TAU;
      const px = Math.cos(a) * e.r, py = Math.sin(a) * e.r;
      if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (e.kind === 'tank') {
      ctx.beginPath();
      ctx.arc(0, 0, e.r * 0.45, 0, TAU);
      ctx.fillStyle = `${e.color}66`;
      ctx.fill();
    }

    if (e.kind === 'boss') drawBossCore(e, ctx);
    ctx.restore();

    drawEnemyBadges(e, ctx, shadows);
  }
  ctx.shadowBlur = 0;
}

function drawBossCore(e: Enemy, ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.rotate(-e.spin * 1.5);
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    const px = Math.cos(a) * e.r * 0.55, py = Math.sin(a) * e.r * 0.55;
    if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.strokeStyle = '#f0abfc';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();

  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.arc(0, 0, e.r + 10 + Math.sin(e.pulse * 5) * 4, 0, TAU);
  ctx.strokeStyle = '#e879f9';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Difficulty stars above an enemy, plus its damage bar. */
function drawEnemyBadges(e: Enemy, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  if (e.level > 1) {
    ctx.save();
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = e.color;
    if (shadows) { ctx.shadowBlur = 6; ctx.shadowColor = e.color; }
    let badge = '';
    for (let i = 0; i < Math.min(e.level - 1, 5); i++) badge += '★';
    ctx.fillText(badge, e.x, e.y - e.r - 12);
    ctx.restore();
    ctx.shadowBlur = 0;
  }
  if (e.hp < e.maxHp) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(e.x - e.r, e.y - e.r - 8, e.r * 2, 4);
    ctx.fillStyle = e.color;
    ctx.fillRect(e.x - e.r, e.y - e.r - 8, e.r * 2 * (e.hp / e.maxHp), 4);
    ctx.globalAlpha = 1;
  }
}

function drawBullets(g: Game, ctx: CanvasRenderingContext2D, fx: Game['fx']): void {
  for (let i = 0; i < g.bullets.length; i++) {
    const b = g.bullets[i]!;
    ctx.save();
    if (fx.shadows) { ctx.shadowBlur = 14; ctx.shadowColor = b.color; }
    ctx.strokeStyle = b.color;
    ctx.lineCap = 'round';
    if (fx.trails) {
      // Faded segment from last frame's position: reads as a tracer.
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = b.r * 0.9;
      ctx.beginPath();
      ctx.moveTo(b.px, b.py);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = b.r;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - b.vx * 0.016, b.y - b.vy * 0.016);
    ctx.stroke();
    ctx.restore();
  }
  ctx.shadowBlur = 0;
}

function drawPlayer(g: Game, ctx: CanvasRenderingContext2D, fx: Game['fx']): void {
  const p = g.player;

  if (g.reticle) drawReticle(g, ctx, fx);

  if (g.combo > 2 && fx.comboAura) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 0.5 + Math.sin(g.time * 8) * 0.2;
    ctx.strokeStyle = '#ffd166';
    ctx.shadowBlur = 14;
    ctx.shadowColor = '#ffd166';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, p.r + 12 + Math.sin(g.time * 8) * 3, 0, TAU);
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  if (p.hp < 30) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 0.35 + Math.sin(g.time * 6) * 0.2;
    ctx.strokeStyle = '#ff4d6d';
    if (fx.shadows) { ctx.shadowBlur = 18; ctx.shadowColor = '#ff4d6d'; }
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, p.r + 22, 0, TAU);
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // ship, with a slow idle bob so it never looks frozen
  ctx.save();
  ctx.translate(p.x, p.y + Math.sin(p.bob) * 1.2);
  ctx.rotate(p.angle);
  if (p.iframe > 0 && Math.floor(p.iframe * 18) % 2 === 0) ctx.globalAlpha = 0.35;
  ctx.shadowBlur = fx.shadows ? 22 : 0;
  ctx.shadowColor = '#38bdf8';
  ctx.fillStyle = 'rgba(56,189,248,0.22)';
  ctx.strokeStyle = '#7dd3fc';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(20, 0); ctx.lineTo(-12, -13); ctx.lineTo(-6, 0); ctx.lineTo(-12, 13);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = fx.shadows ? 6 : 0;
  ctx.fillStyle = '#bff9ff';
  ctx.beginPath(); ctx.arc(2, 0, 2.5, 0, TAU); ctx.fill();

  // thruster plume, length driven by current speed
  const th = Math.min(1, Math.hypot(p.vx, p.vy) / 380);
  if (th > 0.1) {
    ctx.fillStyle = '#ffd166';
    ctx.shadowColor = '#ffa500';
    ctx.beginPath();
    ctx.moveTo(-8, -5);
    ctx.lineTo(-8 - 22 * th * (0.7 + Math.random() * 0.4), 0);
    ctx.lineTo(-8, 5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  if (p.shield > 0) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 0.5 + Math.sin(g.time * 8) * 0.15;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    if (fx.shadows) { ctx.shadowBlur = 16; ctx.shadowColor = '#38bdf8'; }
    ctx.beginPath();
    ctx.arc(0, 0, p.r + 12, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  ctx.shadowBlur = 0;
}

/** Dashed firing line from the nose to the aim point, plus the crosshair. */
function drawReticle(g: Game, ctx: CanvasRenderingContext2D, fx: Game['fx']): void {
  const p = g.player;
  const rx = g.reticle!.x, ry = g.reticle!.y;
  const rdx = rx - p.x, rdy = ry - p.y;
  const rlen = Math.hypot(rdx, rdy) || 1;

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = g.reticleColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 8]);
  if (fx.shadows) { ctx.shadowBlur = 12; ctx.shadowColor = g.reticleColor; }
  ctx.beginPath();
  ctx.moveTo(p.x + (rdx / rlen) * 22, p.y + (rdy / rlen) * 22);
  ctx.lineTo(rx, ry);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const rt = g.time * 3;
  const pulse = 1 + Math.sin(rt * 2) * 0.08;
  ctx.save();
  ctx.translate(rx, ry);
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = g.reticleColor;
  if (fx.shadows) { ctx.shadowBlur = 16; ctx.shadowColor = g.reticleColor; }
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.arc(0, 0, 14 * pulse, 0, TAU);
  ctx.stroke();

  const inner = 6, outer = 12;
  ctx.beginPath();
  ctx.moveTo(0, -outer); ctx.lineTo(0, -inner);
  ctx.moveTo(0, inner); ctx.lineTo(0, outer);
  ctx.moveTo(-outer, 0); ctx.lineTo(-inner, 0);
  ctx.moveTo(inner, 0); ctx.lineTo(outer, 0);
  ctx.stroke();

  if (fx.reticleDots) {
    for (let i = 0; i < 4; i++) {
      const a = rt + (i / 4) * TAU;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 20 * pulse, Math.sin(a) * 20 * pulse, 2, 0, TAU);
      ctx.fillStyle = g.reticleColor;
      ctx.fill();
    }
  }

  ctx.beginPath();
  ctx.arc(0, 0, 2, 0, TAU);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
  ctx.shadowBlur = 0;
}

/** Other human players, drawn in their assigned team colour. */
function drawRemotePlayers(g: Game, ctx: CanvasRenderingContext2D, fx: Game['fx']): void {
  for (let i = 0; i < g.remotePlayers.length; i++) {
    const rp = g.remotePlayers[i]!;
    const color = REMOTE_COLORS[rp.colorIndex % REMOTE_COLORS.length]!;

    ctx.save();
    ctx.translate(rp.x, rp.y);
    ctx.rotate(rp.angle);
    if (fx.shadows) { ctx.shadowBlur = 20; ctx.shadowColor = color; }
    ctx.fillStyle = `${color}26`;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(20, 0); ctx.lineTo(-12, -13); ctx.lineTo(-6, 0); ctx.lineTo(-12, 13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Name above, health bar below.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.fillStyle = color;
    ctx.fillText(rp.name, rp.x, rp.y - rp.r - 16);
    const bw = 30, bh = 3;
    ctx.fillStyle = 'rgba(11,16,32,0.9)';
    ctx.fillRect(rp.x - bw / 2, rp.y + rp.r + 8, bw, bh);
    ctx.fillStyle = color;
    ctx.fillRect(rp.x - bw / 2, rp.y + rp.r + 8, bw * Math.max(0, rp.hp / rp.maxHp), bh);
    ctx.restore();
  }
  ctx.shadowBlur = 0;
}

/** Floating score / callout text, with pop-in and fade-out scaling. */
function drawPops(g: Game, ctx: CanvasRenderingContext2D, shadows: boolean): void {
  ctx.textAlign = 'center';
  for (let i = 0; i < g.pops.length; i++) {
    const q = g.pops[i]!;
    const t = 1 - q.life / q.max;
    const scaleUp = t < 0.2 ? t / 0.2 : 1;
    const scaleDown = q.life < 0.3 ? q.life / 0.3 : 1;
    const size = 20 * (q.scale || 1) * Math.min(scaleUp, scaleDown);
    ctx.globalAlpha = Math.max(0, q.life / q.max);
    ctx.font = `bold ${Math.max(10, size)}px ui-monospace, monospace`;
    ctx.fillStyle = q.color;
    if (shadows) { ctx.shadowBlur = 12; ctx.shadowColor = q.color; }
    ctx.fillText(q.text, q.x, q.y);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}

/** Full-bleed damage flash, drawn slightly oversized to cover shake offset. */
function drawFullScreenFx(g: Game, ctx: CanvasRenderingContext2D): void {
  if (g.flash <= 0) return;
  ctx.fillStyle = `rgba(255,90,120,${Math.max(0, g.flash) * 0.35})`;
  ctx.fillRect(-60, -60, g.W + 120, g.H + 120);
}

function drawLowHpVignette(g: Game, ctx: CanvasRenderingContext2D): void {
  if (g.over || g.player.hp >= 30 || g.player.hp <= 0) return;
  const intensity = (1 - g.player.hp / 30) * 0.5;
  const pulse = intensity * (0.7 + Math.sin(g.time * 6) * 0.3);
  const vg = ctx.createRadialGradient(
    g.W / 2, g.H / 2, g.W * 0.35,
    g.W / 2, g.H / 2, g.W * 0.72,
  );
  vg.addColorStop(0, 'rgba(255,60,90,0)');
  vg.addColorStop(1, `rgba(255,30,70,${pulse})`);
  ctx.fillStyle = vg;
  ctx.fillRect(-60, -60, g.W + 120, g.H + 120);
}

/**
 * Spatial-hash debug overlay (world-aligned, drawn above gameplay).
 * Toggled with the GRID button, backtick or F3.
 */
export function drawDebugGrid(g: Game, ctx: CanvasRenderingContext2D): void {
  if (!g.debugMode) return;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  const cellSize = g.spatialGrid.getCellSize();
  const cols = g.spatialGrid.getCols();
  const rows = g.spatialGrid.getRows();

  ctx.strokeStyle = 'rgba(34, 211, 238, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const x = c * cellSize;
    ctx.moveTo(x, 0); ctx.lineTo(x, g.H);
  }
  for (let r = 0; r <= rows; r++) {
    const y = r * cellSize;
    ctx.moveTo(0, y); ctx.lineTo(g.W, y);
  }
  ctx.stroke();

  const buckets = g.spatialGrid.getOccupiedBuckets();
  ctx.font = '10px monospace';
  buckets.forEach((entities, key) => {
    if (entities.length === 0) return;
    const cellX = (key % cols) * cellSize;
    const cellY = Math.floor(key / cols) * cellSize;
    ctx.fillStyle = `rgba(232, 121, 249, ${Math.min(0.4, 0.08 * entities.length)})`;
    ctx.fillRect(cellX, cellY, cellSize, cellSize);
    ctx.strokeStyle = 'rgba(232, 121, 249, 0.5)';
    ctx.strokeRect(cellX, cellY, cellSize, cellSize);
    ctx.fillStyle = '#e879f9';
    ctx.fillText(`#${key} (${entities.length})`, cellX + 4, cellY + 14);
  });

  ctx.strokeStyle = '#f43f5e';
  ctx.lineWidth = 1;
  for (let i = 0; i < g.enemies.length; i++) {
    const e = g.enemies[i]!;
    if (e.dead) continue;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, TAU);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(5, 6, 15, 0.8)';
  ctx.fillRect(8, g.H - 32, 220, 24);
  ctx.strokeStyle = '#22d3ee';
  ctx.strokeRect(8, g.H - 32, 220, 24);
  ctx.fillStyle = '#22d3ee';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(`DEBUG: SPATIAL GRID (${buckets.size} ACTIVE CELLS)`, 14, g.H - 16);

  ctx.restore();
}
