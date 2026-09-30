#include "matchmaking/Matchmaker.hpp"

#include <algorithm>

#include "utils/Logger.hpp"

namespace neon::matchmaking {

Matchmaker::Matchmaker(const core::Config& config) : config_(config) {}

JoinResult Matchmaker::join(uint32_t sessionId, const std::string& playerName, const std::string& mode,
                            double nowSeconds, std::shared_ptr<game::Match>& outMatch) {
    if (matches_ == nullptr) return JoinResult::NoCapacity;
    if (!security::ServerValidator::validMode(mode)) return JoinResult::BadMode;

    // Already in a match: re-join is a no-op rather than a second assignment.
    auto existing = assignment_.find(sessionId);
    if (existing != assignment_.end()) {
        if (auto match = matches_->find(existing->second)) {
            outMatch = match;
            return JoinResult::Joined;
        }
        assignment_.erase(existing);
    }

    const std::size_t cap = static_cast<std::size_t>(config_.tick.max_players);
    const std::size_t comfortable = comfortableFill(cap);

    // Prefer a waiting match for this mode that is already viable: adding to
    // a half-full match is always better than opening an empty one.
    for (auto& [id, match] : matches_->all()) {
        if (match->mode() != mode) continue;
        if (match->phase() != game::MatchPhase::Waiting) continue;
        if (static_cast<std::size_t>(match->state().playerCount()) >= cap) continue;
        if (static_cast<std::size_t>(match->state().playerCount()) >= comfortable) {
            outMatch = match;
            assignment_[sessionId] = id;
            if (onAssign_) onAssign_(sessionId, id);
            return JoinResult::Joined;
        }
    }

    // Otherwise join the emptiest waiting match, so partial groups coalesce.
    game::Match* best = nullptr;
    std::size_t bestCount = 0;
    for (auto& [id, match] : matches_->all()) {
        if (match->mode() != mode) continue;
        if (match->phase() != game::MatchPhase::Waiting) continue;
        const std::size_t count = static_cast<std::size_t>(match->state().playerCount());
        if (count >= cap) continue;
        if (best == nullptr || count < bestCount) {
            best = match.get();
            bestCount = count;
        }
    }
    if (best != nullptr) {
        outMatch = matches_->find(best->id());
        assignment_[sessionId] = best->id();
        if (onAssign_) onAssign_(sessionId, best->id());
        return JoinResult::Joined;
    }

    // A queued player waiting for a partner: any existing queue entry for this
    // session is replaced, and the group is flushed to a new match.
    queue_.erase(std::remove_if(queue_.begin(), queue_.end(),
                                [sessionId](const QueueEntry& e) { return e.sessionId == sessionId; }),
                 queue_.end());

    for (const QueueEntry& entry : queue_) {
        if (entry.mode != mode) continue;
        if (auto match = matches_->create(mode)) {
            // The waiting player is paired now; the game server is told to
            // add them, and will do the same for the joining session.
            assignment_[entry.sessionId] = match->id();
            if (onAssign_) onAssign_(entry.sessionId, match->id());
            outMatch = match;
            assignment_[sessionId] = match->id();

            queue_.erase(std::remove_if(queue_.begin(), queue_.end(), [&](const QueueEntry& e) {
                             return e.sessionId == entry.sessionId;
                         }),
                         queue_.end());
            return JoinResult::Joined;
        }
    }

    if (matches_->count() >= matches_->maxMatches()) return JoinResult::NoCapacity;

    queue_.push_back(QueueEntry{sessionId, playerName, mode, nowSeconds});
    return JoinResult::Queued;
}

void Matchmaker::leave(uint32_t sessionId) {
    assignment_.erase(sessionId);
    queue_.erase(std::remove_if(queue_.begin(), queue_.end(),
                                [sessionId](const QueueEntry& e) { return e.sessionId == sessionId; }),
                 queue_.end());
}

std::size_t Matchmaker::expireQueue(double nowSeconds, double timeoutSeconds) {
    const std::size_t before = queue_.size();
    queue_.erase(std::remove_if(queue_.begin(), queue_.end(),
                                [&](const QueueEntry& e) {
                                    return nowSeconds - e.queuedAt > timeoutSeconds;
                                }),
                 queue_.end());
    return before - queue_.size();
}

void Matchmaker::pump(double nowSeconds) {
    if (matches_ == nullptr) return;
    if (queue_.empty()) return;

    // Any two queued players of the same mode form a match.
    while (queue_.size() >= 2) {
        const QueueEntry a = queue_.front();
        bool paired = false;
        for (std::size_t i = 1; i < queue_.size(); ++i) {
            if (queue_[i].mode != a.mode) continue;
            const QueueEntry b = queue_[i];
            auto match = matches_->create(a.mode);
            if (!match) return;
            assignment_[a.sessionId] = match->id();
            assignment_[b.sessionId] = match->id();
            if (onAssign_) {
                onAssign_(a.sessionId, match->id());
                onAssign_(b.sessionId, match->id());
            }
            queue_.erase(queue_.begin() + static_cast<long>(i));
            queue_.erase(queue_.begin());
            paired = true;
            break;
        }
        if (!paired) break;
    }

    // Anything still queued past the start delay gets a match to itself, so a
    // lone player is never stuck waiting for a second human.
    if (!queue_.empty() && nowSeconds - queue_.front().queuedAt > config_.match_start_delay) {
        auto match = matches_->create(queue_.front().mode);
        if (match) {
            assignment_[queue_.front().sessionId] = match->id();
            if (onAssign_) onAssign_(queue_.front().sessionId, match->id());
        }
        queue_.clear();
    }
}

std::size_t Matchmaker::waitingMatches() const {
    if (matches_ == nullptr) return 0;
    std::size_t count = 0;
    for (const auto& [id, match] : matches_->all()) {
        if (match->phase() == game::MatchPhase::Waiting) ++count;
    }
    return count;
}

}  // namespace neon::matchmaking
