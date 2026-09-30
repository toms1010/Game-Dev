#include "database/Postgres.hpp"

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include <dlfcn.h>

#include "utils/Logger.hpp"

namespace neon::database {

namespace {

/// A few schema versions live here rather than in a file so a fresh checkout
/// has no runtime file dependency. Idempotent: safe to run on every boot.
const char* kSchemaSql = R"SQL(
CREATE TABLE IF NOT EXISTS players (
    id             SERIAL PRIMARY KEY,
    name           VARCHAR(32) NOT NULL UNIQUE,
    auth_token     VARCHAR(64) NOT NULL DEFAULT '',
    total_score    BIGINT  NOT NULL DEFAULT 0,
    total_kills    BIGINT  NOT NULL DEFAULT 0,
    total_deaths   BIGINT  NOT NULL DEFAULT 0,
    total_waves    BIGINT  NOT NULL DEFAULT 0,
    best_score     BIGINT  NOT NULL DEFAULT 0,
    credits        BIGINT  NOT NULL DEFAULT 0,
    games_played   BIGINT  NOT NULL DEFAULT 0,
    last_seen      DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
    id            SERIAL PRIMARY KEY,
    match_uid     INTEGER NOT NULL,
    mode          VARCHAR(16) NOT NULL,
    started_at    DOUBLE PRECISION NOT NULL,
    duration      DOUBLE PRECISION NOT NULL,
    wave          INTEGER NOT NULL,
    player_count  INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_players (
    match_id      INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    player_name   VARCHAR(32) NOT NULL,
    score         BIGINT NOT NULL DEFAULT 0,
    kills         INTEGER NOT NULL DEFAULT 0,
    deaths        INTEGER NOT NULL DEFAULT 0,
    waves_cleared INTEGER NOT NULL DEFAULT 0,
    survived      BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (match_id, player_id)
);

-- Leaderboard reads are "top N by best score", so index exactly that.
CREATE INDEX IF NOT EXISTS players_best_score_idx ON players (best_score DESC);
CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players (player_id);
CREATE INDEX IF NOT EXISTS matches_created_idx ON matches (created_at DESC);
)SQL";

std::once_flag g_loadOnce;
LibPqApi g_api;

}  // namespace

std::vector<std::string> defaultLibPqCandidates() {
    return {"libpq.so.5", "libpq.so", "libpq.5.dylib", "libpq.dylib"};
}

bool loadLibPq(const std::vector<std::string>& candidates, LibPqApi& out) {
    void* handle = nullptr;
    for (const std::string& name : candidates) {
        handle = dlopen(name.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (handle != nullptr) break;
    }
    if (handle == nullptr) {
        out.error = "libpq not found; tried " + [&] {
            std::string joined;
            for (std::size_t i = 0; i < candidates.size(); ++i) {
                if (i) joined += ", ";
                joined += candidates[i];
            }
            return joined;
        }();
        return false;
    }

    struct Binding {
        const char* name;
        void** slot;
    };
    const Binding bindings[] = {
        {"PQconnectdb", reinterpret_cast<void**>(&out.connectdb)},
        {"PQfinish", reinterpret_cast<void**>(&out.finish)},
        {"PQstatus", reinterpret_cast<void**>(&out.status)},
        {"PQexec", reinterpret_cast<void**>(&out.exec)},
        {"PQexecParams", reinterpret_cast<void**>(&out.execParams)},
        {"PQresultStatus", reinterpret_cast<void**>(&out.resultStatus)},
        {"PQresultErrorMessage", reinterpret_cast<void**>(&out.resultErrorMessage)},
        {"PQclear", reinterpret_cast<void**>(&out.clear)},
        {"PQntuples", reinterpret_cast<void**>(&out.ntuples)},
        {"PQnfields", reinterpret_cast<void**>(&out.nfields)},
        {"PQgetvalue", reinterpret_cast<void**>(&out.getvalue)},
        {"PQgetisnull", reinterpret_cast<void**>(&out.getisnull)},
        {"PQcmdTuples", reinterpret_cast<void**>(&out.cmdTuples)},
    };

    for (const Binding& b : bindings) {
        void* symbol = dlsym(handle, b.name);
        if (symbol == nullptr) {
            // Leave the handle open: the caller may still be able to report a
            // clearer error, and unloading here would lose the dlerror text.
            out.error = std::string("libpq is missing symbol ") + b.name;
            return false;
        }
        *b.slot = symbol;
    }

    out.loaded = true;
    out.error.clear();
    // Intentionally not dlclose'd: the handle stays for the process lifetime.
    return true;
}

bool PostgresDatabase::libraryAvailable() {
    std::call_once(g_loadOnce, [] { loadLibPq(defaultLibPqCandidates(), g_api); });
    return g_api.loaded;
}

PostgresDatabase::PostgresDatabase(std::string connectionString, bool autoMigrate)
    : connectionString_(std::move(connectionString)), autoMigrate_(autoMigrate) {}

PostgresDatabase::~PostgresDatabase() { disconnect(); }

std::string PostgresDatabase::Result::value(int row, int col) const {
    if (res_ == nullptr) return {};
    char* raw = api_->getvalue(res_, row, col);
    return raw == nullptr ? std::string() : std::string(raw);
}

bool PostgresDatabase::Result::isNull(int row, int col) const {
    return res_ == nullptr || api_->getisnull(res_, row, col) != 0;
}

int64_t PostgresDatabase::Result::asInt(int row, int col) const {
    if (res_ == nullptr || isNull(row, col)) return 0;
    return std::strtoll(value(row, col).c_str(), nullptr, 10);
}

double PostgresDatabase::Result::asDouble(int row, int col) const {
    if (res_ == nullptr || isNull(row, col)) return 0.0;
    return std::strtod(value(row, col).c_str(), nullptr);
}

bool PostgresDatabase::connect(std::string& error) {
    if (connectionString_.empty()) {
        error = "no connection string configured";
        enabled_ = false;
        return false;
    }

    if (!g_api.loaded) loadLibPq(defaultLibPqCandidates(), g_api);
    if (!g_api.loaded) {
        error = g_api.error;
        enabled_ = false;
        return false;
    }

    conn_ = g_api.connectdb(connectionString_.c_str());
    if (conn_ == nullptr) {
        error = "PQconnectdb returned null";
        enabled_ = false;
        return false;
    }
    if (g_api.status(conn_) != CONNECTION_OK) {
        error = "database connection refused or failed";
        g_api.finish(conn_);
        conn_ = nullptr;
        enabled_ = false;
        return false;
    }

    connected_ = true;
    enabled_ = true;
    error.clear();

    if (autoMigrate_) {
        std::string migrationError;
        if (!migrate(migrationError)) {
            // A migration failure is not fatal: the server can still run for
            // this session, it just will not persist. Say so loudly.
            NEON_ERROR("database: migration failed: ", migrationError,
                       " — continuing without persistence");
            enabled_ = false;
        }
    }
    return true;
}

void PostgresDatabase::disconnect() {
    if (conn_ != nullptr && g_api.loaded) {
        g_api.finish(static_cast<LibPqApi::PGconn*>(conn_));
    }
    conn_ = nullptr;
    connected_ = false;
}

bool PostgresDatabase::exec(const std::string& sql, Result& out, std::string& error) {
    if (!connected_) {
        error = "not connected";
        return false;
    }
    void* raw = g_api.exec(static_cast<LibPqApi::PGconn*>(conn_), sql.c_str());
    if (raw == nullptr) {
        error = "PQexec returned null";
        return false;
    }
    if (g_api.resultStatus(raw) != PGRES_COMMAND_OK && g_api.resultStatus(raw) != PGRES_TUPLES_OK) {
        const char* message = g_api.resultErrorMessage(raw);
        error = message != nullptr ? message : "query failed";
        g_api.clear(raw);
        return false;
    }
    out = Result(g_api, raw);  // ownership moves to the caller's handle
    return true;
}

bool PostgresDatabase::execParams(const std::string& sql, const std::vector<std::string>& params,
                                  Result& out, std::string& error) {
    if (!connected_) {
        error = "not connected";
        return false;
    }
    if (params.empty()) return exec(sql, out, error);

    std::vector<const char*> values;
    values.reserve(params.size());
    for (const std::string& p : params) values.push_back(p.c_str());

    void* raw = g_api.execParams(static_cast<LibPqApi::PGconn*>(conn_), sql.c_str(),
                                 static_cast<int>(values.size()), nullptr, values.data(), nullptr,
                                 nullptr, 0);
    if (raw == nullptr) {
        error = "PQexecParams returned null";
        return false;
    }
    if (g_api.resultStatus(raw) != PGRES_COMMAND_OK && g_api.resultStatus(raw) != PGRES_TUPLES_OK) {
        const char* message = g_api.resultErrorMessage(raw);
        error = message != nullptr ? message : "query failed";
        g_api.clear(raw);
        return false;
    }
    out = Result(g_api, raw);
    return true;
}

bool PostgresDatabase::migrate(std::string& error) {
    Result result(g_api, nullptr);
    return exec(kSchemaSql, result, error);
}

bool PostgresDatabase::ping(std::string& error) {
    if (!connected_) {
        error = "not connected";
        return false;
    }
    Result result(g_api, nullptr);
    return exec("SELECT 1", result, error);
}

bool PostgresDatabase::readPlayer(const Result& res, PlayerRecord& out) const {
    if (res.rows() < 1 || res.fields() < 11) return false;
    out.id = static_cast<uint32_t>(res.asInt(0, 0));
    out.name = res.value(0, 1);
    out.authToken = res.value(0, 2);
    out.totalScore = res.asInt(0, 3);
    out.totalKills = res.asInt(0, 4);
    out.totalDeaths = res.asInt(0, 5);
    out.totalWaves = res.asInt(0, 6);
    out.bestScore = res.asInt(0, 7);
    out.credits = res.asInt(0, 8);
    out.gamesPlayed = res.asInt(0, 9);
    out.lastSeen = res.asDouble(0, 10);
    return true;
}

namespace {
const char* kSelectPlayer =
    "SELECT id, name, auth_token, total_score, total_kills, total_deaths, total_waves, "
    "best_score, credits, games_played, last_seen FROM players ";
}  // namespace

bool PostgresDatabase::upsertPlayer(const PlayerRecord& player, std::string& error) {
    // ON CONFLICT on the unique name keeps this idempotent for reconnects,
    // which re-auth with the same identity.
    const std::string sql =
        "INSERT INTO players (name, auth_token, total_score, total_kills, total_deaths, "
        "total_waves, best_score, credits, games_played, last_seen) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) "
        "ON CONFLICT (name) DO UPDATE SET "
        " total_score = GREATEST(players.total_score, EXCLUDED.total_score),"
        " total_kills = GREATEST(players.total_kills, EXCLUDED.total_kills),"
        " total_deaths = GREATEST(players.total_deaths, EXCLUDED.total_deaths),"
        " total_waves = GREATEST(players.total_waves, EXCLUDED.total_waves),"
        " best_score  = GREATEST(players.best_score, EXCLUDED.best_score),"
        " credits     = players.credits + EXCLUDED.credits,"
        " games_played = GREATEST(players.games_played, EXCLUDED.games_played),"
        " last_seen   = EXCLUDED.last_seen "
        "RETURNING id";
    std::vector<std::string> params{
        player.name,
        player.authToken,
        std::to_string(player.totalScore),
        std::to_string(player.totalKills),
        std::to_string(player.totalDeaths),
        std::to_string(player.totalWaves),
        std::to_string(player.bestScore),
        std::to_string(player.credits),
        std::to_string(player.gamesPlayed),
        std::to_string(player.lastSeen),
    };
    Result result(g_api, nullptr);
    if (!execParams(sql, params, result, error)) return false;
    if (result.rows() < 1 || result.fields() < 1) {
        error = "upsert returned no id";
        return false;
    }
    return true;
}

bool PostgresDatabase::findPlayer(uint32_t id, PlayerRecord& out, std::string& error) {
    Result result(g_api, nullptr);
    if (!execParams(std::string(kSelectPlayer) + "WHERE id = $1", {std::to_string(id)}, result, error)) {
        return false;
    }
    return readPlayer(result, out);
}

bool PostgresDatabase::findPlayerByName(const std::string& name, PlayerRecord& out, std::string& error) {
    Result result(g_api, nullptr);
    if (!execParams(std::string(kSelectPlayer) + "WHERE name = $1", {name}, result, error)) {
        return false;
    }
    return readPlayer(result, out);
}

bool PostgresDatabase::writePlayer(const PlayerRecord& player, std::string& error) {
    return upsertPlayer(player, error);
}

bool PostgresDatabase::saveMatch(const MatchRecord& match, const std::vector<MatchPlayerRecord>& players,
                                 std::string& error) {
    // One transaction for the match and its participants: a half-written match
    // would corrupt the leaderboard.
    Result beginResult(g_api, nullptr);
    if (!exec("BEGIN", beginResult, error)) return false;

    Result insertMatch(g_api, nullptr);
    const std::string matchSql =
        "INSERT INTO matches (match_uid, mode, started_at, duration, wave, player_count) "
        "VALUES ($1,$2,$3,$4,$5,$6) RETURNING id";
    if (!execParams(matchSql,
                    {std::to_string(match.id), match.mode, std::to_string(match.startedAt),
                     std::to_string(match.duration), std::to_string(match.wave),
                     std::to_string(match.playerCount)},
                    insertMatch, error)) {
        exec("ROLLBACK", beginResult, error);
        return false;
    }
    if (insertMatch.rows() < 1) {
        exec("ROLLBACK", beginResult, error);
        error = "match insert returned no id";
        return false;
    }
    const int64_t rowId = std::strtoll(insertMatch.value(0, 0).c_str(), nullptr, 10);

    for (const MatchPlayerRecord& p : players) {
        Result inserted(g_api, nullptr);
        const std::string sql =
            "INSERT INTO match_players (match_id, player_id, player_name, score, kills, deaths, "
            "waves_cleared, survived) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) "
            "ON CONFLICT (match_id, player_id) DO UPDATE SET score = EXCLUDED.score, "
            "kills = EXCLUDED.kills, deaths = EXCLUDED.deaths, "
            "waves_cleared = EXCLUDED.waves_cleared, survived = EXCLUDED.survived";
        const std::vector<std::string> params{
            std::to_string(rowId), std::to_string(p.playerId), p.playerName,
            std::to_string(p.score),  std::to_string(p.kills), std::to_string(p.deaths),
            std::to_string(p.wavesCleared), p.survived ? "true" : "false"};
        if (!execParams(sql, params, inserted, error)) {
            exec("ROLLBACK", beginResult, error);
            return false;
        }
    }

    Result commit(g_api, nullptr);
    if (!exec("COMMIT", commit, error)) {
        exec("ROLLBACK", beginResult, error);
        return false;
    }
    return true;
}

bool PostgresDatabase::writeMatch(const MatchRecord& match, const std::vector<MatchPlayerRecord>& players,
                                  std::string& error) {
    return saveMatch(match, players, error);
}

bool PostgresDatabase::recentMatches(std::size_t limit, std::vector<MatchRecord>& out,
                                     std::string& error) {
    out.clear();
    Result result(g_api, nullptr);
    const std::string sql =
        "SELECT id, mode, started_at, duration, wave, player_count FROM matches "
        "ORDER BY created_at DESC LIMIT $1";
    if (!execParams(sql, {std::to_string(limit)}, result, error)) return false;
    for (int row = 0; row < result.rows(); ++row) {
        MatchRecord record;
        record.id = static_cast<uint32_t>(result.asInt(row, 0));
        record.mode = result.value(row, 1);
        record.startedAt = result.asDouble(row, 2);
        record.duration = result.asDouble(row, 3);
        record.wave = static_cast<int>(result.asInt(row, 4));
        record.playerCount = static_cast<int>(result.asInt(row, 5));
        out.push_back(std::move(record));
    }
    return true;
}

bool PostgresDatabase::leaderboard(std::size_t limit, std::vector<LeaderboardEntry>& out,
                                   std::string& error) {
    out.clear();
    Result result(g_api, nullptr);
    const std::string sql =
        "SELECT name, best_score, total_score, total_kills, games_played FROM players "
        "WHERE best_score > 0 ORDER BY best_score DESC LIMIT $1";
    if (!execParams(sql, {std::to_string(limit)}, result, error)) return false;
    uint32_t rank = 1;
    for (int row = 0; row < result.rows(); ++row) {
        LeaderboardEntry entry;
        entry.rank = rank++;
        entry.name = result.value(row, 0);
        entry.bestScore = result.asInt(row, 1);
        entry.totalScore = result.asInt(row, 2);
        entry.kills = result.asInt(row, 3);
        entry.games = static_cast<int64_t>(result.asInt(row, 4));
        out.push_back(std::move(entry));
    }
    return true;
}

}  // namespace neon::database
