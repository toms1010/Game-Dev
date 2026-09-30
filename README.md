# Neon Vanguard

Arena shooter. React/TypeScript + Canvas client, Expo SDK 57 mobile app, and
an authoritative C++20 game server.

The game is a **complete single-player experience with no server**. The server
adds authoritative multiplayer and persistence on top; it is never required to
play.

---

## Quick start

```bash
# 1. Web game
npm install
npm run dev              # http://localhost:5173

# 2. Build the single-file bundle the mobile app embeds
npm run build            # -> dist/index.html

# 3. Mobile (Expo)
cd mobile
npm install
npm run sync-html        # copies dist/index.html into src/gameHtml.ts
npm start                # scan the QR, or press w / a / i

# 4. Server (optional)
cd ../server
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/neon_vanguard_server          # in memory, no database needed
```

With Docker, which brings up PostgreSQL too:

```bash
docker compose -f server/docker/docker-compose.yml up --build
```

---

## Architecture

```
                    ┌───────────────────────────────┐
   Browser ────────▶│  Web client (React + Canvas)  │
   Expo app ───────▶│  src/game  — simulation        │
   (WebView)        │  src/ui    — screens           │
                    │  src/network — prediction      │
                    └──────────────┬────────────────┘
                                   │  WebSocket (intent only)
                    ┌──────────────▼────────────────┐
                    │  C++20 game server             │
                    │  server/ — 60 Hz authoritative │
                    └──────────────┬────────────────┘
                                   │ async write queue
                             ┌─────▼─────┐
                             │ PostgreSQL│
                             └───────────┘
```

### One engine, several hosts

`src/game/engine.ts` is the simulation, and it is deliberately free of DOM,
React and canvas concerns. It takes an `Input`, advances by a fixed timestep
and mutates plain state. That is what lets the same rules run:

| Host | What runs there |
|---|---|
| Offline game | the full local simulation |
| Networked game | local prediction + server reconciliation |
| `server/` | an independent C++ implementation of the same rules |

`integrateMovement()` in `src/game/physics.ts` and
`server/src/game/Movement.cpp` are line-for-line identical, and the client
replays that exact function during reconciliation. If they drift, the player
fights a permanent phantom — which is why the test suite pins the behaviour.

---

## Layout

```
src/
├── game/          engine.ts (the simulation) + renderer, physics, weapons,
│                  enemies, entities, save system, audio, stores
├── network/       protocol.ts (wire schema), client.ts (prediction,
│                  reconciliation, reconnection), interpolation.ts
├── ui/            Cockpit.tsx, LoadoutScreen.tsx, PerfOverlay.tsx, Stick,
│                  HangarModal, RotateOverlay, AmbientBackground
└── App.tsx        game loop, input, screen routing

mobile/
├── App.tsx        Expo shell: WebView, orientation, haptics, keep-awake
├── src/           gameHtml.ts (generated), components, storage adapters
├── scripts/       sync-html.js (dist -> gameHtml.ts)
└── native/cpp/    native bridge scaffold (not compiled; see the README there)

server/
├── include/, src/ core, game, network, security, matchmaking, database, utils
├── tests/         harness + game / network / security / performance suites
├── config/        server.example.json, schema.sql
└── docker/        Dockerfile, docker-compose.yml
```

---

## The client

### The rule that shapes the code

**Per-frame game state never goes through React state.**

The loop runs at 60 Hz. A `setState` there would schedule a React render
every frame and diff the whole UI tree — the fastest way to turn a 60 Hz game
into a 20 Hz one on a phone, and it shows up as input lag long before it
shows up as dropped frames.

Instead the loop writes to mutable state and pushes to external stores
(`src/game/store.ts`) that notify React at 10 Hz, and only when a value the
UI actually shows has changed. An idle frame costs one comparison and no
React work at all.

### Adaptive arena

The arena is not a fixed 960x600. `Game.setViewport()` reshapes it to the
device's aspect ratio while holding the **area** constant, so a 20:9 phone
plays exactly as hard as a 16:10 window — it just has a longer arena. The
result is a full-bleed playfield with no letterbox bars on any screen.

### Quality profiles

`LOW` / `MEDIUM` / `HIGH` control particle ceilings, glow, trails, the neon
grid, the enemy cap and the spatial-hash cell size. A frame-time watchdog
(`autoTune`) steps down when the rolling average exceeds budget and steps back
up when there is real headroom — and stops entirely once the player picks a
tier in Settings, because an explicit choice should not be second-guessed.

Glow (`ctx.shadowBlur`) is the first thing the low tier switches off: it is by
far the most expensive operation in the renderer.

### Performance

| Measure | Cost | Notes |
|---|---|---|
| Spatial hash query | ~0.2 µs | scales with local density, not entity count |
| Enemy sweep (256) | ~0.5 µs | swap-and-pop, no allocation |
| Object pools | fixed ceilings | past the cap, spawns are dropped not grown |

No `setState` in the loop, no allocation in the steady state, no `filter` per
frame, and object pools for bullets, particles, enemies and pickups.

Press `` ` `` or **F3** for the development overlay: FPS, frame/sim/render
times, entity and particle counts, spatial-hash occupancy, plus RTT, server
tick rate and packet loss when connected. It is off by default and never
enabled by a production build.

---

## The network

`src/network/client.ts` does four things, in this order of importance for feel:

1. **Stays connected.** Exponential backoff (1s → 30s ceiling) with ±20%
   jitter, so a server restart does not produce a thundering herd, and a
   session token so a reconnect rejoins the same match.
2. **Responds instantly.** Every input is applied locally on the frame it is
   sampled (prediction), so the ship never waits for the round trip.
3. **Stays honest.** Snapshots acknowledge the last input consumed; anything
   newer is replayed on top of the authoritative state (reconciliation). A
   small positional error is absorbed as a decaying visual offset rather than
   a teleport.
4. **Degrades quietly.** Nothing in the single-player path depends on this
   class. If the socket never opens, `status` stays `offline` and the game is
   a complete local experience.

The status pill in the top bar shows `ONLINE` / `OFFLINE` / `CONNECTING` /
`RECONNECTING`, with the arena still fully playable underneath.

### Trust model

The client sends **intent only** — move, aim, fire, ability. It cannot send a
position, a hit, a death, health, kills or score, because those message types
do not exist. `server/tests/test_security.cpp` closes off teleport, fire-rate
abuse, invulnerability, score injection, extra bombs, and input replay.

---

## The server

See **[server/README.md](server/README.md)** for the full picture: layout,
protocol, trust boundary, configuration, measured performance and scaling
notes.

Quick verification:

```bash
cd server/build && ctest --output-on-failure
./build/neon_vanguard_server &
node server/tests/integration/smoke.mjs ws://127.0.0.1:8080
```

---

## Verification

Everything below was run as part of building this, and the commands are
repeatable.

```bash
# TypeScript
npx tsc --noEmit                     # client
cd mobile && npx tsc --noEmit        # Expo app
npm run build                        # single-file bundle
node mobile/scripts/sync-html.js     # embed it

# C++
cmake -S server -B server/build -DCMAKE_BUILD_TYPE=Release
cmake --build server/build --parallel
cd server/build && ctest --output-on-failure   # 76 tests, 4 suites

# End to end
./server/build/neon_vanguard_server &
node server/tests/integration/smoke.mjs ws://127.0.0.1:8080
```

The C++ suite found several bugs the TypeScript never would have: a rate-limit
budget created *after* the first message was metered, a `signal_set` destroyed
immediately after construction (turning `SIGTERM` back into an abrupt kill),
and rate windows that accumulated per-wake time rather than wall-clock, making
a one-second window really twelve seconds. The browser interaction pass found
a dead nav button and a z-order bug that hid the menu's own navigation.

**Not verified here:** real Android and iOS devices, and the Docker image
build. Those need hardware and a longer CI run.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | single-file bundle to `dist/index.html` |
| `npm run build:mobile` | build + sync into the Expo app |
| `cd mobile && npm start` | Expo dev server |
| `cd mobile && npm run sync-html` | copy `dist/index.html` into `src/gameHtml.ts` |
| `cd mobile && npx expo prebuild` | generate native projects |
| `server/build/neon_vanguard_server --help` | server options |
