#include "core/Config.hpp"

#include <cstdlib>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "utils/Logger.hpp"

namespace neon::core {

using json = nlohmann::json;

namespace {

/// Reads an environment variable, returning false when unset or empty.
bool env(const char* key, std::string& out) {
    const char* value = std::getenv(key);
    if (value == nullptr || *value == '\0') return false;
    out = value;
    return true;
}

void envInt(const char* key, int& target) {
    std::string raw;
    if (env(key, raw)) {
        try {
            target = std::stoi(raw);
        } catch (...) {
            NEON_WARN("config: ", key, " is not an integer ('", raw, "'), keeping default");
        }
    }
}

void envDouble(const char* key, double& target) {
    std::string raw;
    if (env(key, raw)) {
        try {
            target = std::stod(raw);
        } catch (...) {
            NEON_WARN("config: ", key, " is not a number ('", raw, "'), keeping default");
        }
    }
}

void envBool(const char* key, bool& target) {
    std::string raw;
    if (env(key, raw)) {
        target = (raw == "1" || raw == "true" || raw == "yes" || raw == "on");
    }
}

}  // namespace

bool Config::load(const std::string& path, Config& out, std::string& error) {
    Config cfg;  // start from defaults so a partial file is fine

    if (!path.empty()) {
        std::ifstream file(path);
        if (!file) {
            error = "cannot open config file: " + path;
            // Not fatal: defaults are usable, and a missing file is a normal
            // first-run condition.
            NEON_WARN("config: ", error, " — using defaults");
        } else {
            try {
                json j;
                file >> j;

                if (j.contains("host")) cfg.host = j["host"].get<std::string>();
                if (j.contains("port")) cfg.port = j["port"].get<uint16_t>();
                if (j.contains("tick_rate")) cfg.tick_rate = j["tick_rate"].get<int>();
                if (j.contains("arena")) {
                    const json& a = j["arena"];
                    if (a.contains("width")) cfg.arena_w = a["width"].get<double>();
                    if (a.contains("height")) cfg.arena_h = a["height"].get<double>();
                }
                if (j.contains("io_threads")) cfg.io_threads = j["io_threads"].get<unsigned>();
                if (j.contains("log")) {
                    const json& l = j["log"];
                    if (l.contains("level")) cfg.log_level = l["level"].get<std::string>();
                    if (l.contains("to_file")) cfg.log_to_file = l["to_file"].get<bool>();
                    if (l.contains("file")) cfg.log_file = l["file"].get<std::string>();
                }
                if (j.contains("match")) {
                    const json& m = j["match"];
                    if (m.contains("start_delay")) cfg.match_start_delay = m["start_delay"].get<double>();
                    if (m.contains("rejoin_grace")) cfg.rejoin_grace = m["rejoin_grace"].get<double>();
                }
                if (j.contains("tick_budget")) {
                    const json& t = j["tick_budget"];
                    if (t.contains("snapshot_hz")) cfg.tick.snapshot_hz = t["snapshot_hz"].get<int>();
                    if (t.contains("max_entities")) cfg.tick.max_entities = t["max_entities"].get<int>();
                    if (t.contains("max_projectiles"))
                        cfg.tick.max_projectiles = t["max_projectiles"].get<int>();
                    if (t.contains("max_players")) cfg.tick.max_players = t["max_players"].get<int>();
                    if (t.contains("max_catchup_ticks"))
                        cfg.tick.max_catchup_ticks = t["max_catchup_ticks"].get<int>();
                }
                if (j.contains("rate_limits")) {
                    const json& r = j["rate_limits"];
                    if (r.contains("messages_per_second"))
                        cfg.limits.messages_per_second = r["messages_per_second"].get<double>();
                    if (r.contains("burst")) cfg.limits.burst = r["burst"].get<double>();
                    if (r.contains("bytes_per_second"))
                        cfg.limits.bytes_per_second = r["bytes_per_second"].get<double>();
                    if (r.contains("hard_bytes_per_second"))
                        cfg.limits.hard_bytes_per_second = r["hard_bytes_per_second"].get<double>();
                    if (r.contains("input_per_second"))
                        cfg.limits.input_per_second = r["input_per_second"].get<double>();
                }
                if (j.contains("database")) {
                    const json& d = j["database"];
                    if (d.contains("connection_string"))
                        cfg.db.connection_string = d["connection_string"].get<std::string>();
                    if (d.contains("auto_migrate")) cfg.db.auto_migrate = d["auto_migrate"].get<bool>();
                    if (d.contains("worker_threads")) cfg.db.worker_threads = d["worker_threads"].get<int>();
                    if (d.contains("batch_size")) cfg.db.batch_size = d["batch_size"].get<int>();
                }
            } catch (const std::exception& e) {
                error = std::string("malformed config: ") + e.what();
                NEON_ERROR("config: ", error, " — falling back to defaults");
            }
        }
    }

    // Environment overrides, so one image can serve several environments.
    std::string host;
    if (env("NEON_HOST", host)) cfg.host = host;
    {
        int port = 0;
        envInt("NEON_PORT", port);
        if (port > 0 && port <= 65535) cfg.port = static_cast<uint16_t>(port);
    }
    envInt("NEON_TICK_RATE", cfg.tick_rate);
    envDouble("NEON_ARENA_W", cfg.arena_w);
    envDouble("NEON_ARENA_H", cfg.arena_h);
    envInt("NEON_SNAPSHOT_HZ", cfg.tick.snapshot_hz);
    envInt("NEON_MAX_PLAYERS", cfg.tick.max_players);
    envInt("NEON_MAX_ENTITIES", cfg.tick.max_entities);
    envInt("NEON_MAX_PROJECTILES", cfg.tick.max_projectiles);
    envInt("NEON_DB_WORKERS", cfg.db.worker_threads);
    envDouble("NEON_MATCH_START_DELAY", cfg.match_start_delay);
    std::string conn;
    if (env("NEON_DATABASE_URL", conn)) cfg.db.connection_string = conn;
    else if (env("DATABASE_URL", conn)) cfg.db.connection_string = conn;
    {
        int threads = 0;
        envInt("NEON_IO_THREADS", threads);
        if (threads > 0) cfg.io_threads = static_cast<unsigned>(threads);
    }
    std::string level;
    if (env("NEON_LOG_LEVEL", level)) cfg.log_level = level;
    envBool("NEON_LOG_TO_FILE", cfg.log_to_file);

    out = cfg;
    return out.validate(error);
}

bool Config::validate(std::string& error) {
    bool ok = true;

    if (tick_rate < 20 || tick_rate > 240) {
        error = "tick_rate must be between 20 and 240 (got " + std::to_string(tick_rate) + ")";
        ok = false;
    }
    if (arena_w < 320.0 || arena_h < 240.0) {
        error = "arena dimensions are too small";
        ok = false;
    }
    if (arena_w > 8192.0 || arena_h > 8192.0) {
        error = "arena dimensions are unreasonably large";
        ok = false;
    }
    if (tick.max_players < 1 || tick.max_players > 64) {
        error = "tick_budget.max_players must be between 1 and 64";
        ok = false;
    }
    if (tick.snapshot_hz < 1) tick.snapshot_hz = 1;
    if (tick.snapshot_hz > tick_rate) tick.snapshot_hz = tick_rate;
    if (tick.max_catchup_ticks < 1) tick.max_catchup_ticks = 1;
    if (tick.max_projectiles < 16) tick.max_projectiles = 16;
    if (tick.max_entities < 16) tick.max_entities = 16;
    if (db.worker_threads < 0) db.worker_threads = 0;
    if (db.batch_size < 1) db.batch_size = 1;
    if (match_start_delay < 0.0) match_start_delay = 0.0;
    if (rejoin_grace < 0.0) rejoin_grace = 0.0;

    // The snapshot rate must be a whole number of ticks, otherwise the
    // broadcast phase aliases against the tick and jitters.
    if (tick_rate % tick.snapshot_hz != 0) {
        const int reduced = tick_rate / tick.snapshot_hz;
        tick.snapshot_hz = tick_rate / (reduced > 0 ? reduced : 1);
    }

    tick_dt = 1.0 / static_cast<double>(tick_rate);

    utils::LogLevel parsed{};
    if (!utils::parseLogLevel(log_level, parsed)) {
        error = "unknown log_level: " + log_level;
        log_level = "info";
        ok = false;
    }
    return ok;
}

}  // namespace neon::core
