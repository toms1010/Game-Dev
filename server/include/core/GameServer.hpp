// Neon Vanguard — game server core.
//
// Owns the session bookkeeping, the matchmaker, the fixed-rate game loop and
// the persistence layer, and implements the callbacks the transport needs.
//
// Threading model
// ---------------
// The io_context may run on several worker threads, but every callback that
// touches game state takes `mutex_`, and the simulation is only ever advanced
// from the game-loop timer. `GameState` therefore needs no internal locking,
// which is what keeps the hot path free of locks. Network callbacks are
// short: parse, validate, queue. Nothing slow ever happens under the lock.

#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <boost/asio/any_io_executor.hpp>
#include <boost/asio/steady_timer.hpp>

#include "core/Config.hpp"
#include "database/Database.hpp"
#include "database/PlayerRepository.hpp"
#include "database/Postgres.hpp"
#include "game/Match.hpp"
#include "matchmaking/Matchmaker.hpp"
#include "network/ClientSession.hpp"
#include "network/WebSocketServer.hpp"
#include "security/RateLimiter.hpp"
#include "security/ServerValidator.hpp"
#include "utils/Timer.hpp"

namespace neon::core {

/// Live server statistics, exposed on /healthz.
struct ServerStats {
    uint64_t uptimeSeconds = 0;
    uint64_t tick = 0;
    double tickRate = 0.0;
    double tickLoad = 0.0;
    std::size_t sessions = 0;
    std::size_t matches = 0;
    std::size_t players = 0;
    std::size_t queued = 0;
    std::size_t entities = 0;
    uint64_t messagesIn = 0;
    uint64_t bytesIn = 0;
    uint64_t bytesOut = 0;
    uint64_t rateLimited = 0;
    uint64_t invalidInputs = 0;
    bool databaseConnected = false;
    uint64_t dbQueued = 0;
    uint64_t dbWritten = 0;
};

class GameServer : public network::TransportHandler {
public:
    using Executor = boost::asio::any_io_executor;

    GameServer(Executor executor, const Config& config);
    ~GameServer() override;

    /// Binds, starts the game loop and the acceptor. False on a bind failure.
    bool start(std::string& error);

    /// Stops the loop, the acceptor and the database workers.
    void stop();

    /// Asks the owning `Server` to shut the io_context down. Safe to call
    /// from a signal-handling thread.
    void requestStop();

    /// Set by `Server` so `requestStop()` can reach the io_context.
    void setIoStopHandler(std::function<void()> handler) { onIoStop_ = std::move(handler); }

    uint16_t port() const { return server_ ? server_->port() : config_.port; }

    ServerStats stats() const;

    /// Exposed for the test suite.
    std::mutex& mutex() { return mutex_; }
    game::MatchManager& matches() { return matches_; }
    matchmaking::Matchmaker& matchmaker() { return matchmaker_; }
    network::WebSocketServer& transport() { return *server_; }

    // --- TransportHandler ---
    void onSessionOpened(network::Session& session) override;
    void onTextMessage(network::Session& session, const std::string& payload) override;
    void onSessionClosed(network::Session& session, const std::string& reason) override;
    void send(network::Session& session, const std::string& payload) override;
    network::HttpResponse onHttp(const network::HttpRequest& request) override;
    double now() const override;

private:
    void scheduleGameLoop();
    void gameLoop();
    void broadcastSnapshots();
    void reapIdleSessions();

    void handleConnect(network::Session& s, const network::InboundMessage& m);
    void handleAuth(network::Session& s, const network::InboundMessage& m);
    void handleJoin(network::Session& s, const network::InboundMessage& m);
    void handleLeave(network::Session& s);
    void handleInput(network::Session& s, const network::InboundMessage& m);
    void handleAbility(network::Session& s, const network::InboundMessage& m);
    void handlePing(network::Session& s, const network::InboundMessage& m);
    void handleResync(network::Session& s, const network::InboundMessage& m);

    /// Puts a player into a match and tells the client. Used by both an
    /// explicit JOIN and the matchmaker's queue-assignment callback.
    void assignToMatch(uint32_t sessionId, uint32_t matchId);

    /// Closes a session, which triggers `onSessionClosed` and the teardown.
    void destroySession(uint32_t sessionId, const std::string& reason);

    void replyError(network::Session& s, int code, const std::string& message);
    void sendJson(network::Session& s, const nlohmann::json& message);
    void sendWelcome(network::Session& s);
    void sendJoined(network::Session& s, const std::shared_ptr<game::Match>& match);

    network::HttpResponse routeRest(const network::HttpRequest& request);
    nlohmann::json handleHealth();
    nlohmann::json handleLogin(const network::HttpRequest& request);
    nlohmann::json handleRegister(const network::HttpRequest& request);
    nlohmann::json handleProfile(const network::HttpRequest& request);
    nlohmann::json handleLeaderboard(const network::HttpRequest& request);
    nlohmann::json handleMatches(const network::HttpRequest& request);

    /// Wall-clock seconds since the epoch, for persisted timestamps.
    static double wallClockSeconds() { return static_cast<double>(utils::nowMillis()) / 1000.0; }

    Executor executor_;
    Config config_;

    std::unique_ptr<network::WebSocketServer> server_;
    std::unique_ptr<net::steady_timer> gameLoopTimer_;
    game::MatchManager matches_;
    matchmaking::Matchmaker matchmaker_;
    security::RateLimiter rateLimiter_;
    security::ServerValidator validator_;
    /// Persistent fixed-step accumulator. It must outlive a single wake:
    /// re-creating it would throw away the partial step every time and the loop
    /// would run at the wake rate instead of the tick rate.
    utils::Ticker ticker_;
    utils::RateMeter tickRateMeter_;
    utils::RateMeter entityMeter_;

    std::unique_ptr<database::Database> db_;
    std::unique_ptr<database::PlayerRepository> players_;
    std::unique_ptr<database::MatchRepository> matchRepo_;

    /// Guards the session->match routing and the match tick. Held for short,
    /// bounded sections only; never across I/O.
    mutable std::mutex mutex_;
    std::unordered_map<uint32_t, uint32_t> sessionByPlayer_;
    uint32_t nextPlayerId_ = 1;

    utils::TimePoint startTime_;
    utils::TimePoint lastLoopTime_;
    uint64_t tick_ = 0;
    // Wall-clock window starts, in seconds since boot. 0 means "not yet
    // started", which is why they are seeded in `start()`.
    double snapshotWindowStart_ = 0.0;
    double maintenanceWindowStart_ = 0.0;
    /// Rolling window used to report the observed tick rate.
    double rateWindowStart_ = 0.0;
    uint64_t rateWindowTicks_ = 0;
    std::atomic<bool> stopping_{false};
    std::function<void()> onIoStop_;
    bool running_ = false;

    std::atomic<uint64_t> messagesIn_{0};
    std::atomic<uint64_t> bytesIn_{0};
    std::atomic<uint64_t> bytesOut_{0};
    std::atomic<uint64_t> rateLimited_{0};
    std::atomic<uint64_t> invalidInputs_{0};
};

}  // namespace neon::core
