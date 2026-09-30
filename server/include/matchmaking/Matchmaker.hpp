// Neon Vanguard — matchmaking.
//
// Intentionally simple, because premature matchmaking infrastructure is the
// classic way to make a game server unshippable. Fills a match up to its
// player cap, starts it early once it is comfortable, and starts it late
// anyway after a short deadline so a solo player is never stuck in a queue.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "core/Config.hpp"
#include "game/Match.hpp"
#include "security/ServerValidator.hpp"

namespace neon::matchmaking {

struct QueueEntry {
    uint32_t sessionId = 0;
    std::string playerName;
    std::string mode = "arena";
    double queuedAt = 0.0;
};

enum class JoinResult { Joined, Queued, NoCapacity, BadMode };

class Matchmaker {
public:
    /**
     * Invoked when a session is assigned to a match, including for sessions
     * that were queued. The matchmaker decides *routing* only: creating the
     * player belongs to the game server, which owns the id space and the
     * session table.
     */
    using AssignCallback = std::function<void(uint32_t sessionId, uint32_t matchId)>;

    explicit Matchmaker(const core::Config& config);

    void setAssignCallback(AssignCallback cb) { onAssign_ = std::move(cb); }

    /// Places a session in the best match for its mode, or queues it.
    JoinResult join(uint32_t sessionId, const std::string& playerName, const std::string& mode,
                    double nowSeconds, std::shared_ptr<game::Match>& outMatch);

    /// Pulls a session out of both any match and the queue.
    void leave(uint32_t sessionId);

    /// Removes queued entries older than `timeoutSeconds` (their clients gave
    /// up). Returns how many were dropped.
    std::size_t expireQueue(double nowSeconds, double timeoutSeconds);

    /// Moves waiting players into matches that have become viable.
    void pump(double nowSeconds);

    std::size_t queueLength() const { return queue_.size(); }
    const std::vector<QueueEntry>& queue() const { return queue_; }
    std::size_t waitingMatches() const;

    void setMatchManager(game::MatchManager* manager) { matches_ = manager; }

    /// sessionId -> matchId, for the game server to reconcile against.
    const std::unordered_map<uint32_t, uint32_t>& assignments() const { return assignment_; }

private:
    /// A match is "comfortable" at this occupancy and starts without waiting.
    static std::size_t comfortableFill(std::size_t cap) { return cap >= 3 ? 2 : 1; }

    core::Config config_;
    game::MatchManager* matches_ = nullptr;
    std::vector<QueueEntry> queue_;
    /// sessionId -> matchId, so a disconnect can find its match in O(1).
    std::unordered_map<uint32_t, uint32_t> assignment_;
    AssignCallback onAssign_;
};

}  // namespace neon::matchmaking
