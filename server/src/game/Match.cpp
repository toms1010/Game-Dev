#include "game/Match.hpp"

#include <algorithm>

#include "utils/Logger.hpp"
#include "utils/Timer.hpp"

namespace neon::game {

Match::Match(uint32_t id, std::string mode, const core::Config& config)
    : id_(id),
      mode_(std::move(mode)),
      state_(id, Arena(config.arena_w, config.arena_h),
             GameStateLimits{
                 static_cast<std::size_t>(config.tick.max_players),
                 static_cast<std::size_t>(config.tick.max_projectiles),
                 // A third of the entity budget goes to enemies; the rest is
                 // headroom for players and projectiles.
                 static_cast<std::size_t>(std::max(16, config.tick.max_entities / 2)),
                 3.0}),
      createdAt_(utils::nowMillis() / 1000.0),
      startDeadline_(createdAt_ + config.match_start_delay),
      startDelay_(config.match_start_delay) {
    state_.setEventCallback([this](const std::string& kind, uint32_t id, double value) {
        if (onEvent_) onEvent_(kind, id, value);
    });
    state_.setResultCallback([this](const RunResult& result) {
        if (onResult_) onResult_(result);
    });
}

void Match::setEventCallback(std::function<void(const std::string&, uint32_t, double)> cb) {
    onEvent_ = std::move(cb);
    state_.setEventCallback(onEvent_);
}

void Match::setResultCallback(std::function<void(const RunResult&)> cb) {
    onResult_ = std::move(cb);
    state_.setResultCallback(onResult_);
}

bool Match::readyToStart(double nowSeconds) const {
    if (phase_ != MatchPhase::Waiting) return false;
    // Start as soon as it is worth waiting for, or once the deadline passes so
    // a solo player is never stranded in a queue.
    const std::size_t comfortable = state_.playerCount() >= 2 ? 2 : 1;
    return state_.playerCount() >= comfortable || nowSeconds >= startDeadline_;
}

void Match::start() {
    if (phase_ != MatchPhase::Waiting) return;
    phase_ = MatchPhase::Running;
    startedAt_ = utils::nowMillis() / 1000.0;
    NEON_INFO("match ", id_, " started with ", state_.playerCount(), " player(s), mode=", mode_);
}

void Match::tick(double dt) {
    if (phase_ != MatchPhase::Running) return;
    state_.tick(dt);
    if (state_.finished()) finished_ = true;
}

MatchSummary Match::summary(double nowSeconds) const {
    MatchSummary s;
    s.id = id_;
    s.mode = mode_;
    s.phase = phase_;
    s.playerCount = static_cast<int>(state_.playerCount());
    s.wave = state_.wave();
    s.startedAt = startedAt_;
    s.duration = phase_ == MatchPhase::Running ? nowSeconds - startedAt_ : 0.0;
    return s;
}

MatchManager::MatchManager(const core::Config& config) : config_(config) {
    // One match per two cores is a reasonable starting point; the loop is the
    // bottleneck, and it is single-threaded by design.
    const unsigned cores = std::thread::hardware_concurrency();
    maxMatches_ = std::max<std::size_t>(4, cores / 2);
}

std::shared_ptr<Match> MatchManager::create(const std::string& mode) {
    if (matches_.size() >= maxMatches_) return nullptr;
    auto match = std::make_shared<Match>(++nextId_, mode, config_);
    matches_.emplace(match->id(), match);
    return match;
}

std::shared_ptr<Match> MatchManager::find(uint32_t id) {
    auto it = matches_.find(id);
    return it == matches_.end() ? nullptr : it->second;
}

void MatchManager::destroy(uint32_t id) { matches_.erase(id); }

void MatchManager::tick(double dt) { tick(dt, 0.0, false); }

void MatchManager::tick(double dt, double nowSeconds, bool includeWaiting) {
    std::vector<uint32_t> finished;
    for (auto& [id, match] : matches_) {
        if (includeWaiting) {
            if (match->phase() == MatchPhase::Waiting) {
                if (match->readyToStart(nowSeconds)) match->start();
                else continue;
            }
        }
        match->tick(dt);
        if (match->finished()) finished.push_back(id);
    }
    for (uint32_t id : finished) {
        auto it = matches_.find(id);
        if (it == matches_.end()) continue;
        auto match = it->second;
        match->state().finish();
        if (onFinished_) onFinished_(match);
        matches_.erase(it);
    }
}

}  // namespace neon::game
