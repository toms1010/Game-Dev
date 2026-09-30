// Neon Vanguard — match lifecycle and the collection of live matches.
//
// A match owns one `GameState` plus the metadata the persistence layer and
// the leaderboard need. `MatchManager` owns every live match, routes
// simulation ticks to each of them, and hands finished matches to the
// database writer.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "core/Config.hpp"
#include "game/GameState.hpp"

namespace neon::game {

enum class MatchPhase { Waiting, Running, Finished };

struct MatchSummary {
    uint32_t id = 0;
    std::string mode = "arena";
    MatchPhase phase = MatchPhase::Waiting;
    int playerCount = 0;
    int wave = 1;
    double startedAt = 0.0;
    double duration = 0.0;
};

class Match {
public:
    Match(uint32_t id, std::string mode, const core::Config& config);

    uint32_t id() const { return id_; }
    const std::string& mode() const { return mode_; }
    MatchPhase phase() const { return phase_; }
    GameState& state() { return state_; }
    const GameState& state() const { return state_; }

    /// True when the match has enough players, or its start delay has elapsed.
    bool readyToStart(double nowSeconds) const;
    void start();
    void tick(double dt);
    bool finished() const { return finished_; }

    void setEventCallback(std::function<void(const std::string&, uint32_t, double)> cb);
    void setResultCallback(std::function<void(const RunResult&)> cb);

    MatchSummary summary(double nowSeconds) const;

private:
    uint32_t id_;
    std::string mode_;
    GameState state_;
    MatchPhase phase_ = MatchPhase::Waiting;
    double createdAt_ = 0.0;
    double startedAt_ = 0.0;
    double startDeadline_ = 0.0;
    double startDelay_ = 3.0;
    bool finished_ = false;
    std::function<void(const std::string&, uint32_t, double)> onEvent_;
    std::function<void(const RunResult&)> onResult_;
};

using MatchFinishedCallback = std::function<void(std::shared_ptr<Match>)>;

class MatchManager {
public:
    explicit MatchManager(const core::Config& config);

    /// Creates and returns a new match, or nullptr when the cap is reached.
    std::shared_ptr<Match> create(const std::string& mode);
    std::shared_ptr<Match> find(uint32_t id);
    void destroy(uint32_t id);

    std::size_t count() const { return matches_.size(); }
    const std::unordered_map<uint32_t, std::shared_ptr<Match>>& all() const { return matches_; }

    /// Advances every live match by one fixed step. Called from the game loop.
    void tick(double dt);
    /// Ticks waiting matches too, so their start deadlines fire.
    void tick(double dt, double nowSeconds, bool includeWaiting);

    void setFinishedCallback(MatchFinishedCallback cb) { onFinished_ = std::move(cb); }

    /// Maximum simultaneous matches. Kept small on purpose: this is a single
    /// process, and a match is CPU-bound. Scale out with more processes, not
    /// more concurrent worlds on one thread.
    std::size_t maxMatches() const { return maxMatches_; }

private:
    core::Config config_;
    std::unordered_map<uint32_t, std::shared_ptr<Match>> matches_;
    uint32_t nextId_ = 0;
    std::size_t maxMatches_ = 32;
    MatchFinishedCallback onFinished_;
};

}  // namespace neon::game
