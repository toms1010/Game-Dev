// Neon Vanguard — repository layer.
//
// Repositories are thin, synchronous facades over a `Database`. They are
// called from HTTP request handlers and the database worker thread — never
// from the game loop, which only ever uses the async `enqueue*` path.
//
// Keeping them separate from `PostgresDatabase` means the SQL lives apart
// from the connection handling, and a future second backend does not have to
// duplicate the query shapes.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "database/Database.hpp"
#include "game/GameState.hpp"

namespace neon::database {

/// Player accounts, profiles and lifetime statistics.
class PlayerRepository {
public:
    explicit PlayerRepository(Database& db) : db_(db) {}

    /// Creates or updates by id, then reads the row back into `out`.
    bool upsert(const PlayerRecord& player, PlayerRecord& out, std::string& error);

    bool findById(uint32_t id, PlayerRecord& out, std::string& error);
    bool findByName(const std::string& name, PlayerRecord& out, std::string& error);

    /// Queues a write for the background worker. Safe from the game thread.
    void saveAsync(const PlayerRecord& player);

    /// Applies a finished run to a profile and persists it asynchronously.
    void applyRunAsync(uint32_t playerId, const std::string& name, const game::RunResult& run);

private:
    Database& db_;
};

/// Match history and the leaderboard.
class MatchRepository {
public:
    explicit MatchRepository(Database& db) : db_(db) {}

    /// Queues a completed match and all of its participants.
    void saveAsync(uint32_t matchId, const std::string& mode, double startedAt, double duration,
                   int wave, const std::vector<game::RunResult>& results);

    bool recent(std::size_t limit, std::vector<MatchRecord>& out, std::string& error);
    bool top(std::size_t limit, std::vector<LeaderboardEntry>& out, std::string& error);

private:
    Database& db_;
};

}  // namespace neon::database
