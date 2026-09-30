// Neon Vanguard — persistence interface and the async write queue.
//
// The rule this module exists to enforce: the 60 Hz game thread must never
// wait for PostgreSQL. Simulation code calls `enqueue()` (a push onto a
// mutex-protected queue) and returns. A worker thread drains the queue and
// talks to the database.
//
// If no connection string is configured, every call is a no-op and the
// server runs as a pure in-memory game server, which is the intended
// single-player/offline deployment shape.

#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace neon::database {

/// A player profile, as persisted.
struct PlayerRecord {
    uint32_t id = 0;
    std::string name;
    std::string authToken;
    int64_t totalScore = 0;
    int64_t totalKills = 0;
    int64_t totalDeaths = 0;
    int64_t totalWaves = 0;
    int64_t bestScore = 0;
    int64_t credits = 0;
    int64_t gamesPlayed = 0;
    double lastSeen = 0.0;
};

/// A finished match, as persisted.
struct MatchRecord {
    uint32_t id = 0;
    std::string mode;
    double startedAt = 0.0;
    double duration = 0.0;
    int wave = 0;
    int playerCount = 0;
};

/// One participant's result in a match.
struct MatchPlayerRecord {
    uint32_t matchId = 0;
    uint32_t playerId = 0;
    std::string playerName;
    int64_t score = 0;
    int kills = 0;
    int deaths = 0;
    int wavesCleared = 0;
    bool survived = false;
};

/// A leaderboard row.
struct LeaderboardEntry {
    uint32_t rank = 0;
    std::string name;
    int64_t bestScore = 0;
    int64_t totalScore = 0;
    int64_t kills = 0;
    int games = 0;
};

/**
 * The persistence contract. Implemented by `PostgresDatabase`; a
 * `NullDatabase` is used when persistence is disabled, so callers never need
 * a null check.
 */
class Database {
public:
    virtual ~Database() = default;

    /// Opens the connection and applies migrations. False means persistence
    /// is unavailable, and the server should continue without it.
    virtual bool connect(std::string& error) = 0;
    virtual void disconnect() = 0;
    virtual bool connected() const = 0;

    virtual bool upsertPlayer(const PlayerRecord& player, std::string& error) = 0;
    virtual bool findPlayer(uint32_t id, PlayerRecord& out, std::string& error) = 0;
    virtual bool findPlayerByName(const std::string& name, PlayerRecord& out, std::string& error) = 0;

    virtual bool saveMatch(const MatchRecord& match, const std::vector<MatchPlayerRecord>& players,
                           std::string& error) = 0;
    virtual bool recentMatches(std::size_t limit, std::vector<MatchRecord>& out, std::string& error) = 0;
    virtual bool leaderboard(std::size_t limit, std::vector<LeaderboardEntry>& out, std::string& error) = 0;

    /// Round-trips a trivial query; used by the health endpoint.
    virtual bool ping(std::string& error) = 0;

    /**
     * Buffers a write for the background worker. Returns immediately.
     * These are the only persistence entry points the game loop may use.
     */
    void enqueuePlayer(const PlayerRecord& player);
    void enqueueMatch(const MatchRecord& match, std::vector<MatchPlayerRecord> players);

    /// Starts the worker thread(s).
    void startWorkers(int threads);
    /// Drains the queue and joins. Called on shutdown.
    void stopWorkers();

    uint64_t queued() const { return queued_.load(); }
    uint64_t written() const { return written_.load(); }
    uint64_t dropped() const { return dropped_.load(); }
    uint64_t lastErrorCount() const { return errors_.load(); }
    bool enabled() const { return enabled_; }

protected:
    /// Set by the backend's `connect()`. False means "run without persistence".
    bool enabled_ = false;

    virtual bool writePlayer(const PlayerRecord& player, std::string& error) = 0;
    virtual bool writeMatch(const MatchRecord& match, const std::vector<MatchPlayerRecord>& players,
                            std::string& error) = 0;

private:
    struct Job {
        enum class Kind { Player, Match } kind = Kind::Player;
        PlayerRecord player;
        MatchRecord match;
        std::vector<MatchPlayerRecord> players;
    };

    void workerLoop();

    std::deque<Job> queue_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::vector<std::thread> workers_;
    bool running_ = false;
    std::atomic<uint64_t> queued_{0};
    std::atomic<uint64_t> written_{0};
    std::atomic<uint64_t> dropped_{0};
    std::atomic<uint64_t> errors_{0};
};

}  // namespace neon::database
