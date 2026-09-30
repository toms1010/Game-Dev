# Neon Vanguard — C++ Game Server

Authoritative game server for Neon Vanguard. C++20, CMake, Boost.Asio/Beast,
PostgreSQL. One process serves the real-time game on a WebSocket and a small
REST API on the same port.

The web/mobile client keeps its own simulation for offline play. This server
is what makes a match *authoritative* when it is connected: the client sends
intent, the server decides everything that matters.

---

## Quick start

```bash
# Build (Release by default)
cmake -S server -B server/build -DCMAKE_BUILD_TYPE=Release
cmake --build server/build --parallel

# Run in memory — no database, no setup
./server/build/neon_vanguard_server

# Run with configuration and persistence
cp server/config/server.example.json server/config/server.json
./server/build/neon_vanguard_server --config server/config/server.json \
    --db "postgresql://neon:neon@localhost:5432/neon"

# Tests
cd server/build && ctest --output-on-failure

# End-to-end protocol check (server must be running)
node server/tests/integration/smoke.mjs ws://127.0.0.1:8080
```

Docker:

```bash
docker compose -f server/docker/docker-compose.yml up --build
```

---

## Architecture

```
                    ┌──────────────────────────┐
  Web / Expo ──────▶│  C++ Game Server         │
   (WebSocket)      │                          │
                    │  ┌────────────────────┐  │
                    │  │ fixed 60 Hz loop   │  │──▶ snapshots (20 Hz)
                    │  │ GameState          │  │
                    │  └────────────────────┘  │
                    │  ServerValidator         │  ── intent only:
                    │  RateLimiter             │     move, aim, fire,
                    └───────────┬──────────────┘     ability
                                │ async write queue
                                ▼
                          PostgreSQL
```

The game thread never blocks. It parses, validates and simulates; persistence
is handed to a worker thread through a queue.

### Layout

```
server/
├── include/
│   ├── core/         Config, GameLoop, GameServer, Server
│   ├── game/         Vec, Movement, Collision, Arena, Player, Enemy,
│   │                 Projectile, Weapon, GameState, Match
│   ├── network/      Packet (wire schema), ClientSession, WebSocketServer
│   ├── security/     ServerValidator, RateLimiter
│   ├── matchmaking/  Matchmaker
│   ├── database/     Database (async queue), Postgres (dlopen libpq)
│   └── utils/        Logger, Timer
├── src/              one .cpp per header
├── tests/            harness.hpp + test_game / network / security / performance
├── config/           server.example.json, schema.sql
└── docker/           Dockerfile, docker-compose.yml
```

---

## The trust boundary

The client may only send **intent**. It cannot send a position, a hit, a death,
health, kills or score — those message types do not exist, and
`ServerValidator` rejects anything that is not a recognised intent field.

| Client sends | Server decides |
|---|---|
| `INPUT` — movement vector, aim point, trigger | position, whether shots hit, damage, kills, score |
| `ABILITY` — `"dash"` / `"bomb"` | whether the cooldown permits it, and what it affects |
| `PING` | clock offset and RTT |

Concretely, `server/tests/test_security.cpp` closes off these cheats:

- **Teleport** — a movement vector longer than a full stick is refused;
  the integrator normalises it. Movement is capped at a speed the client
  cannot raise.
- **Fire-rate abuse** — the cooldown lives on the server. Holding the trigger
  for a second produces the shots the weapon allows, not 60.
- **Invulnerability** — health is only ever written by the simulation.
- **Score injection** — score only moves in `awardKill`, which the simulation
  calls when a projectile it spawned actually hit something.
- **Extra bombs/dashes** — charged against the server's own count and
  cooldown; a request is an *ask*, not an action.
- **Replay** — input sequences must be strictly increasing per session.

`RateLimiter` backs this up at the connection level: a token bucket per session
for messages, bytes and input samples, with a hard ceiling that disconnects
rather than merely throttles.

---

## Protocol

WebSocket at `/ws/game`, JSON with single-letter keys and flat numeric arrays
for entities. Shared verbatim with `src/network/protocol.ts` — a change on
either side must be made on both, and `PROTOCOL_VERSION` bumped.

### Client to server

```json
{"t":"CONNECT","v":1,"client":"web","device":"..."}
{"t":"AUTH","name":"Pilot"}
{"t":"JOIN","mode":"arena"}
{"t":"INPUT","s":102,"c":102,"mx":1,"my":0,"ax":720,"ay":300,"f":1}
{"t":"ABILITY","s":103,"k":"dash"}
{"t":"PING","i":7,"c":102}
{"t":"LEAVE"}
```

### Server to client

```json
{"t":"WELCOME","id":1,"tick":1200,"rate":60,"aw":960,"ah":600}
{"t":"AUTH_OK","id":1,"name":"Pilot"}
{"t":"JOINED","match":"1","roster":[{"id":1,"name":"Pilot"}],"mode":"arena"}
{"t":"SNAP","k":1200,"a":102,"p":[[1,412.5,300.1,8.2,0,-1.57,100,100,1]],"e":[[7,0,120.0,80.4,15,20,0.3]]}
{"t":"EV","e":"hit","id":1,"v":12}
{"t":"PONG","i":7,"c":102,"k":1200}
{"t":"ERR","code":1007,"m":"unknown ability"}
```

`s` is a monotonic input sequence; `a` in a snapshot is the newest one the
server consumed, which is what the client reconciles against.

Entities are flat arrays rather than objects because it removes every key from
the payload. Positions are quantised to 0.1 world units — far finer than the
14-unit ship radius. The layout maps one-to-one onto a packed binary protocol
if that is ever needed; only the encoder changes.

---

## REST API

Same port as the WebSocket — the transport dispatches on the first request, so
`wss://host/ws/game` and `https://host/api` share one listener.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness, plus tick rate, entity count, and rate-limit counters |
| POST | `/api/auth/register` | Create a profile |
| POST | `/api/auth/login` | Resolve a profile by name |
| GET | `/api/player/profile?name=` | Lifetime statistics |
| GET | `/api/leaderboard?limit=` | Top players by best score |
| GET | `/api/matches?limit=` | Recent match history |

---

## Configuration

Precedence: command line > environment > config file > defaults.

| Flag | Environment | Default |
|---|---|---|
| `--port` | `NEON_PORT` | 8080 |
| `--host` | `NEON_HOST` | 0.0.0.0 |
| `--tick-rate` | `NEON_TICK_RATE` | 60 |
| `--arena WxH` | `NEON_ARENA_W` / `NEON_ARENA_H` | 960x600 |
| `--snapshot-hz` | `NEON_SNAPSHOT_HZ` | 20 |
| `--db` | `NEON_DATABASE_URL` | *(none: in memory)* |
| `--log-level` | `NEON_LOG_LEVEL` | info |

See `config/server.example.json` for everything, including the tick budget and
rate limits.

### About `libpq`

libpq is resolved with `dlopen` at runtime, not linked at build time. Two
consequences, both deliberate:

- the server builds and runs on a machine with no PostgreSQL client library;
- if the library or the database is unavailable, the server logs a warning and
  runs entirely in memory instead of refusing to start.

`libpq.so.5`, `libpq.so`, `libpq.5.dylib` and `libpq.dylib` are tried in that
order.

---

## Performance

Measured on the development machine, Release build, arena 1920x600:

| Scenario | Cost | Share of a 60 Hz frame |
|---|---|---|
| 8 players, moving | 0.0035 ms/tick | 0.02% |
| 500 enemies | 0.214 ms/tick | 1.3% |
| 200 enemies + firing | 0.073 ms/tick | 0.4% |
| Spatial hash query | 0.0002 ms | — |
| 6,000-tick match | 0.0056 ms/tick avg | 0.03% |

`tests/test_performance.cpp` asserts these as *budgets* (10% of a frame), not
absolute times, so a slower CI machine does not produce a false failure. The
tests exist to catch an order-of-magnitude regression — someone removing the
spatial hash or a pool — not to benchmark the hardware.

What keeps it there:

- **Spatial hash** broad phase, rebuilt once per tick. Bullet-versus-enemy cost
  scales with local density, not with the enemy count.
- **Swept collision** against the segment a projectile travelled, so fast
  bullets cannot tunnel through an enemy at 60 Hz.
- **Fixed-capacity pools** for projectiles, particles, enemies and pickups.
  The ceilings are hard: past them, spawns are dropped rather than growing the
  heap, so worst-case memory is flat no matter what a client does.
- **In-place compaction.** Every per-tick "filter" is a swap-and-pop; a busy
  frame performs no allocation.
- **No work in the tick** that touches I/O. Persistence is queued, not awaited.

---

## Testing

```bash
cd server/build && ctest --output-on-failure
```

| Suite | Covers |
|---|---|
| `test_game` | movement, collision, weapons, damage, respawn, progression, integration |
| `test_network` | protocol round-trips, malformed input, validation, rate limits, ticker |
| `test_security` | every cheat the server is meant to refuse |
| `test_performance` | per-tick budgets at 8 players / 500 entities |

Plus an end-to-end check that drives the real wire format:

```bash
./server/build/neon_vanguard_server &
node server/tests/integration/smoke.mjs ws://127.0.0.1:8080
```

That one caught several bugs the unit tests could not: a rate-limit budget
that was created after the first message was metered, a `signal_set` destroyed
immediately after construction (so `SIGTERM` killed the process outright
instead of shutting it down), and rate windows that accumulated per-wake time
instead of wall-clock, making a one-second window really twelve seconds.

---

## Scaling

Deliberately not built yet, and the seams are in place for it:

- **More matches** — a match is CPU bound and single threaded. Run more
  processes and shard by mode; the session→match table is per process, so a
  client must stick to the process it connected to (sticky sessions at the
  load balancer, or a consistent-hash on player id).
- **Read replicas** — the leaderboard is the only read-heavy path.
- **Redis** — the natural home for the session→process routing table and
  matchmaking queues once there is more than one process.
- **Binary protocol** — the encoder is isolated in `Packet.cpp`; the entity
  arrays already map onto a packed layout.

What is *not* needed yet, and adding it early is the classic way to make a
game server unshippable: microservices, a message queue, a distributed
database, Kubernetes.
