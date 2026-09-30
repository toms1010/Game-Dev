// Neon Vanguard — server configuration.
//
// Loaded from a JSON file (see config/server.example.json), then overridden
// by environment variables. Environment wins so a container image can ship
// one config file and be re-pointed at a different database per deployment.

#pragma once

#include <cstdint>
#include <string>

namespace neon::core {

/** How much work a match is allowed to do before the tick is considered late. */
struct TickBudget {
    /** Snapshot broadcast rate, in Hz. Capped at the tick rate. */
    int snapshot_hz = 20;
    /** Hard ceiling on entities the simulation will simulate. */
    int max_entities = 512;
    /** Hard ceiling on live projectiles. */
    int max_projectiles = 1024;
    /** Players per match. */
    int max_players = 8;
    /** Ticks of accumulated lag the loop will try to catch up before giving
     *  up and dropping time (prevents the spiral of death). */
    int max_catchup_ticks = 5;
};

struct RateLimitConfig {
    /** Sustained messages per second from one connection. */
    double messages_per_second = 120.0;
    /** Burst allowance, i.e. the token bucket depth. */
    double burst = 240.0;
    /** Sustained inbound bytes per second from one connection. */
    double bytes_per_second = 65536.0;
    /** A connection sending faster than this is dropped, not just throttled. */
    double hard_bytes_per_second = 262144.0;
    /** Input samples per second above which samples are discarded. */
    double input_per_second = 90.0;
};

struct DatabaseConfig {
    /** Empty disables persistence; the server runs entirely in memory. */
    std::string connection_string;
    /** Applied on boot when the schema is missing. */
    bool auto_migrate = true;
    /** Background writer. Persistence must never block the game thread. */
    int worker_threads = 1;
    /** Rows a single batched insert may carry. */
    int batch_size = 256;
};

struct Config {
    std::string host = "0.0.0.0";
    uint16_t port = 8080;

    /** Fixed simulation rate. Gameplay is defined in terms of this. */
    int tick_rate = 60;
    double tick_dt = 1.0 / 60.0;

    /** Arena size in world units; matches the client's baseline. */
    double arena_w = 960.0;
    double arena_h = 600.0;

    TickBudget tick;
    RateLimitConfig limits;
    DatabaseConfig db;

    /** io_context worker threads. 0 means "derive from core count". */
    unsigned io_threads = 0;

    std::string log_level = "info";
    bool log_to_file = false;
    std::string log_file = "neon-server.log";

    /** Seconds an unfilled match waits for players before starting anyway. */
    double match_start_delay = 3.0;
    /** Seconds a disconnected player is held before being dropped. */
    double rejoin_grace = 30.0;

    /**
     * Reads `path` (JSON) over the defaults, then applies NEON_* environment
     * overrides. Returns false and fills `error` when the file is unreadable
     * or malformed; defaults are still usable in that case.
     */
    static bool load(const std::string& path, Config& out, std::string& error);

    /** Validates ranges and derives `tick_dt`. */
    bool validate(std::string& error);

    /** Seconds of match time per tick, for the simulation. */
    double dt() const { return tick_dt; }
};

}  // namespace neon::core
