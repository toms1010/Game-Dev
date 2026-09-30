#include "database/PlayerRepository.hpp"

#include "utils/Logger.hpp"
#include "utils/Timer.hpp"

namespace neon::database {

// ---------------------------------------------------------------------------
// Database: async write queue
// ---------------------------------------------------------------------------

void Database::enqueuePlayer(const PlayerRecord& player) {
    if (!enabled_) return;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        queue_.push_back(Job{Job::Kind::Player, player, MatchRecord{}, {}});
        queued_.fetch_add(1);
    }
    cv_.notify_one();
}

void Database::enqueueMatch(const MatchRecord& match, std::vector<MatchPlayerRecord> players) {
    if (!enabled_) return;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        queue_.push_back(Job{Job::Kind::Match, PlayerRecord{}, match, std::move(players)});
        queued_.fetch_add(1);
    }
    cv_.notify_one();
}

void Database::startWorkers(int threads) {
    if (running_) return;
    if (threads < 1) threads = 1;
    running_ = true;
    workers_.reserve(static_cast<std::size_t>(threads));
    for (int i = 0; i < threads; ++i) {
        workers_.emplace_back([this] { workerLoop(); });
    }
    NEON_INFO("database: ", threads, " writer thread(s) started");
}

void Database::stopWorkers() {
    if (!running_) return;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        running_ = false;
    }
    cv_.notify_all();
    for (std::thread& worker : workers_) {
        if (worker.joinable()) worker.join();
    }
    workers_.clear();
}

void Database::workerLoop() {
    for (;;) {
        Job job;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait(lock, [this] { return !running_ || !queue_.empty(); });
            // Drain whatever is queued before exiting, so a clean shutdown does
            // not throw away the last few seconds of results.
            if (!running_ && queue_.empty()) return;
            job = std::move(queue_.front());
            queue_.pop_front();
        }

        std::string error;
        bool ok = false;
        if (job.kind == Job::Kind::Player) {
            ok = writePlayer(job.player, error);
        } else {
            ok = writeMatch(job.match, job.players, error);
        }

        if (ok) {
            written_.fetch_add(1);
        } else {
            errors_.fetch_add(1);
            // One failure is not a reason to spin: log and drop. A persistently
            // broken database is a deployment problem, not something retrying
            // in a tight loop can fix.
            NEON_WARN("database: write failed: ", error);
        }
    }
}

// ---------------------------------------------------------------------------
// PlayerRepository
// ---------------------------------------------------------------------------

bool PlayerRepository::upsert(const PlayerRecord& player, PlayerRecord& out, std::string& error) {
    if (!db_.upsertPlayer(player, error)) return false;
    if (!db_.findPlayerByName(player.name, out, error)) {
        // The row exists (the upsert succeeded) but the read-back did not find
        // it. Report it rather than returning a half-populated record.
        error = "player was written but could not be read back";
        return false;
    }
    return true;
}

bool PlayerRepository::findById(uint32_t id, PlayerRecord& out, std::string& error) {
    return db_.findPlayer(id, out, error);
}

bool PlayerRepository::findByName(const std::string& name, PlayerRecord& out, std::string& error) {
    return db_.findPlayerByName(name, out, error);
}

void PlayerRepository::saveAsync(const PlayerRecord& player) { db_.enqueuePlayer(player); }

void PlayerRepository::applyRunAsync(uint32_t playerId, const std::string& name,
                                    const game::RunResult& run) {
    if (!db_.enabled()) return;

    // Read-modify-write on a background thread. A race between two concurrent
    // finishes for the same player is possible in principle; in practice a
    // player is in one match at a time, and GREATEST() in the upsert keeps
    // monotonic fields monotonic regardless.
    PlayerRecord record;
    record.id = playerId;
    record.name = name;
    record.lastSeen = static_cast<double>(utils::nowMillis()) / 1000.0;
    std::string error;
    if (db_.findPlayerByName(name, record, error) && record.id == 0) {
        record.id = playerId;
    }

    record.totalScore += run.score;
    record.totalKills += run.kills;
    record.totalDeaths += run.deaths;
    record.totalWaves += run.wavesCleared;
    record.bestScore = std::max(record.bestScore, run.score);
    record.gamesPlayed += 1;
    // Credits mirror the offline economy: one per 100 points, plus one per kill.
    record.credits += run.score / 100 + run.kills;
    record.lastSeen = static_cast<double>(utils::nowMillis()) / 1000.0;

    saveAsync(record);
}

// ---------------------------------------------------------------------------
// MatchRepository
// ---------------------------------------------------------------------------

void MatchRepository::saveAsync(uint32_t matchId, const std::string& mode, double startedAt,
                                double duration, int wave,
                                const std::vector<game::RunResult>& results) {
    if (!db_.enabled()) return;

    MatchRecord record;
    record.id = matchId;
    record.mode = mode;
    record.startedAt = startedAt;
    record.duration = duration;
    record.wave = wave;
    record.playerCount = static_cast<int>(results.size());

    std::vector<MatchPlayerRecord> players;
    players.reserve(results.size());
    for (const game::RunResult& result : results) {
        MatchPlayerRecord p;
        p.matchId = matchId;
        p.playerId = result.playerId;
        p.playerName = result.playerName;
        p.score = result.score;
        p.kills = result.kills;
        p.deaths = result.deaths;
        p.wavesCleared = result.wavesCleared;
        p.survived = result.survived;
        players.push_back(std::move(p));
    }

    db_.enqueueMatch(record, std::move(players));
}

bool MatchRepository::recent(std::size_t limit, std::vector<MatchRecord>& out, std::string& error) {
    return db_.recentMatches(limit, out, error);
}

bool MatchRepository::top(std::size_t limit, std::vector<LeaderboardEntry>& out, std::string& error) {
    return db_.leaderboard(limit, out, error);
}

}  // namespace neon::database
