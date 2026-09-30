#!/usr/bin/env node
/**
 * Neon Vanguard — screenshot capture.
 *
 * Regenerates the images in `docs/screenshots/`, which the README embeds.
 * Run it after any visual change, or before a release, so the README never
 * drifts from the actual UI.
 *
 *   npm run screenshots
 *
 * Builds the app in development mode and serves the result from a static
 * server. Two reasons for that shape:
 *
 *  * Development mode exposes `window.__NEON__` (see App.tsx), which lets
 *    states that would otherwise need minutes of play — a cleared wave, a
 *    death, a specific quality tier — be reached deterministically.
 *  * A dev *server* is not used, because it watches the project root and the
 *    captured PNGs would trigger a reload mid-run. A static server has no
 *    watcher, so captures are reproducible.
 *
 * The hook is compiled out of production builds, so nothing here changes what
 * ships: the screenshots show the real UI.
 *
 * Requires Playwright and its Chromium build, once:
 *   npm install                      (adds the devDependency)
 *   npx playwright install chromium
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'docs/screenshots');
// Built into a temp directory, outside the project: files appearing under the
// Vite root make a watching dev server reload the page mid-capture.
const buildDir = resolve(tmpdir(), 'neon-screenshot-build');
const PORT = 5123;
const BASE = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Serves the built bundle from memory-less static reads.
 *
 * A dev server was the obvious choice and the wrong one: it watches the
 * project root, so writing the captured PNGs into docs/ triggered a full page
 * reload that wiped the dev hook partway through the run. A static server has
 * no watcher and no HMR, so a capture is deterministic.
 */
function serveStatic(dir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', BASE);
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = join(dir, rel);
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

const PHONE = { width: 844, height: 390 };   // iPhone 14 landscape
const TABLET = { width: 1024, height: 768 };
const DESKTOP = { width: 1440, height: 900 };
const PORTRAIT = { width: 390, height: 844 };

/** Every shot: name, viewport, and how to get there. */
const SHOTS = [
  { name: '01-menu-loadout', caption: 'Main menu — SELECT LOADOUT', viewport: PHONE },
  { name: '02-menu-inventory', caption: 'Lifetime statistics', viewport: PHONE, tab: 'INV' },
  { name: '03-menu-settings', caption: 'Settings — graphics, audio, reset', viewport: PHONE, tab: 'SET' },
  { name: '04-hangar', caption: 'Hangar — permanent upgrades', viewport: PHONE, tab: 'ARMS' },
  { name: '05-ingame', caption: 'Gameplay — cockpit HUD, twin-stick controls', viewport: PHONE, deploy: true, warm: 2600 },
  { name: '06-ingame-paused', caption: 'Paused', viewport: PHONE, deploy: true, warm: 2200, pause: true },
  { name: '07-wave-cleared', caption: 'Wave cleared — upgrade choice', viewport: PHONE, deploy: true, warm: 2600, clearWave: true },
  { name: '08-game-over', caption: 'Run summary and unlocks', viewport: PHONE, deploy: true, warm: 3000, score: 18450, kill: true },
  { name: '09-perf-overlay', caption: 'Development performance overlay', viewport: DESKTOP, deploy: true, warm: 4000, perf: true },
  { name: '10-rotate-to-play', caption: 'Portrait — rotate to play', viewport: PORTRAIT, deploy: true, warm: 900 },
  { name: '11-menu-tablet', caption: 'Tablet layout', viewport: TABLET },
  { name: '12-ingame-tablet', caption: 'Tablet gameplay', viewport: TABLET, deploy: true, warm: 2600 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Caption shown next to a shot. */
const describe = (shot) => shot.caption ?? '';

/**
 * Takes the screenshot.
 *
 * Plain and minimal on purpose. Two things that sound helpful are actively
 * harmful here:
 *
 *   * `animations: 'disabled'` — Playwright implements it by rewriting the
 *     page's animation CSS and then *waiting* for animations to finish, which
 *     never happens when framer-motion is looping something forever.
 *   * touching the frame loop from the harness — a rAF-based freeze does not
 *     actually stop the game's loop, and interfering with it only makes the
 *     capture slower.
 *
 * The freeze CSS injected before the shot is what makes the image
 * reproducible; that is sufficient.
 */
async function shoot(page, name) {
  await page.screenshot({ path: resolve(outDir, `${name}.png`), timeout: 60000 });
}

/**
 * Freezes animations so a screenshot is reproducible run to run. The menu
 * title bobs and the overlay fades; without this, two captures of "the same"
 * screen differ.
 */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
  }
`;

/**
 * Drives one shot on a shared page.
 *
 * A single page is reused across every shot rather than opening a new one
 * each time. The game keeps a reconnecting WebSocket alive, and a page per
 * shot accumulates enough live sockets and render loops to make the browser
 * flaky — the symptom being readiness checks that time out even though the
 * page is demonstrably ready.
 */
async function capture(page, shot) {
  const errors = [];
  page.on('pageerror', (e) => {
    // The Vite dev server has no /ws/game endpoint, so the game's network
    // client cannot connect. That is expected here — the shots are meant to
    // show the OFFLINE state — and the client handles it without breaking.
    if (/WebSocket closed without opened|ERR_CONNECTION_REFUSED|ws:\/\//.test(e.message)) return;
    errors.push(e.message);
  });
  page.setDefaultTimeout(15000);

  await page.setViewportSize(shot.viewport);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.addStyleTag({ content: FREEZE_CSS });

  // Wait for the app to have actually mounted before touching anything.
  //
  // Polled with an explicit loop rather than page.waitForFunction(). The
  // latter intermittently timed out on a page that was demonstrably ready —
  // the dev hook present, the DOM fully rendered — which points at its
  // polling being starved by the game's own requestAnimationFrame loop. A
  // plain evaluate-in-a-loop is immune to that, and costs nothing.
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate(() => Boolean(window.__NEON__)).catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  if (!ready) {
    const diag = await page.evaluate(() => ({
      neon: typeof window.__NEON__,
      ready: document.readyState,
      canvases: document.querySelectorAll('canvas').length,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
    }));
    throw new Error(`${shot.name}: app never mounted. ${JSON.stringify(diag)}`);
  }
  await sleep(250);

  if (shot.tab) {
    // Select by the stable data attribute, not by accessible-name text: a
    // label change should not silently break the capture harness.
    const nav = page.locator(`button[data-nav="${shot.tab}"]`);
    try {
      await nav.click({ timeout: 8000 });
    } catch {
      const dump = await page.evaluate(() => ({
        url: location.href,
        buttons: [...document.querySelectorAll('button')].map((b) =>
          `${b.dataset.nav ?? b.dataset.action ?? b.dataset.primary ?? '?'}:${b.textContent.trim().slice(0, 14)}`),
      }));
      throw new Error(`${shot.name}: cannot click nav "${shot.tab}". ${JSON.stringify(dump)}`);
    }
  }

  if (shot.deploy) {
    // Wait for the button explicitly before clicking: the failure mode
    // otherwise is a bare 30s timeout with no clue which state was missing.
    const deploy = page.locator('button[data-primary="cyan"]');
    await deploy.waitFor({ state: 'visible', timeout: 15000 });
    await deploy.click();
    // Let the wave build up and a few shots land, so the arena is not empty.
    await sleep(shot.warm ?? 2000);
    await page.mouse.move(shot.viewport.width * 0.62, shot.viewport.height * 0.4);
  }

  if (shot.score !== undefined) {
    await page.evaluate((n) => window.__NEON__.setScore(n), shot.score);
    await sleep(150);
  }
  if (shot.clearWave) {
    await page.evaluate(() => window.__NEON__.clearWave());
    await sleep(500);
  }
  if (shot.kill) {
    await page.evaluate(() => window.__NEON__.kill());
    // The engine plays a death beat before the overlay appears.
    await sleep(1600);
  }
  if (shot.pause) {
    await page.locator('button[data-action="pause"]').click();
    await sleep(400);
  }
  if (shot.perf) {
    await page.keyboard.press('F3');
    await sleep(700);
  }

  await shoot(page, shot.name);
  return errors;
}

async function main() {
  console.log('Neon Vanguard — capturing screenshots\n');

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Development-mode build: keeps the __NEON__ hook, drops the HMR client.
  console.log('Building (development mode, for the dev hook)...');
  await rm(buildDir, { recursive: true, force: true });
  const build = spawn(
    'npx',
    ['vite', 'build', '--mode', 'development', '--outDir', buildDir, '--emptyOutDir', '--logLevel', 'warn'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // `vite build` sets NODE_ENV=production unless it is already set, and
      // that is what decides import.meta.env.DEV — so the mode flag alone is
      // not enough to keep the dev hook in the bundle.
      env: { ...process.env, NODE_ENV: 'development' },
    },
  );
  let buildLog = '';
  build.stdout.on('data', (d) => { buildLog += d; });
  build.stderr.on('data', (d) => { buildLog += d; });
  const buildCode = await new Promise((r) => build.on('exit', r));
  if (buildCode !== 0) {
    throw new Error(`vite build failed:\n${buildLog.trim()}`);
  }
  // Prove the build is actually loadable before spending time on captures.
  await readFile(resolve(buildDir, 'index.html'), 'utf8');

  const server = await serveStatic(buildDir);
  const browser = await chromium.launch({
    args: [
      // The symptom of an under-provisioned container is that a timeout
      // lands on whichever step happened to be running, which reads like an
      // application bug and is not one. These make the renderer behave.
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  const page = await browser.newPage({
    viewport: PHONE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  let failures = 0;
  try {
    for (const shot of SHOTS) {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const errors = await capture(page, shot);
          const flag = errors.length ? `  \x1b[33m${errors.length} page error(s)\x1b[0m` : '';
          console.log(`  \x1b[32m✓\x1b[0m ${shot.name.padEnd(22)} ${describe(shot)}${flag}`);
          for (const e of errors) console.log(`      ${e}`);
          break;
        } catch (err) {
          if (attempt === 3) { lastError = err; break; }
          console.log(`  \x1b[33m·\x1b[0m ${shot.name}: ${err.message.split('\n')[0]} — retrying`);
          await sleep(750);
        }
      }
      if (lastError) {
        failures++;
        console.log(`  \x1b[31m✗\x1b[0m ${shot.name.padEnd(22)} ${lastError.message}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
    await rm(buildDir, { recursive: true, force: true });
  }

  console.log(`\n${SHOTS.length} screenshots written to docs/screenshots/`);
  if (failures > 0) {
    console.log(`${failures} shot(s) captured with page errors.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31mFailed:\x1b[0m ${err.message}`);
  console.error('Run `npx playwright install chromium` first if the browser is missing.\n');
  process.exit(1);
});
