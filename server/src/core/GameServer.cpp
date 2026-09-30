#include "core/GameServer.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>

#include <nlohmann/json.hpp>

#include "network/Packet.hpp"
#include "utils/Logger.hpp"
#include "utils/Timer.hpp"

namespace neon::core {

using json = nlohmann::json;
using namespace neon::network;

namespace {

/// How long a connection may be silent before it is closed.
constexpr double kIdleTimeoutSeconds = 45.0;
/// How often the loop wakes for maintenance that is not tied to a tick.
constexpr double kMaintenanceInterval = 1.0;

std::vector<std::string> splitPath(const std::string& path) {
    std::vector<std::string> parts;
    std::size_t pos = 0;
    while (pos < path.size()) {
        const std::size_t slash = path.find('/', pos);
        if (slash == std::string::npos) {
            if (pos < path.size()) parts.push_back(path.substr(pos));
            break;
        }
        if (slash > pos) parts.push_back(path.substr(pos, slash - pos));
        pos = slash + 1;
    }
    return parts;
}

}  // namespace

GameServer::GameServer(Executor executor, const Config& config)
    : executor_(std::move(executor)),
      config_(config),
      matches_(config),
      matchmaker_(config),
      rateLimiter_(security::RateLimiter::Config{config.limits.messages_per_second,
                                                 config.limits.burst,
                                                 config.limits.bytes_per_second,
                                                 config.limits.bytes_per_second * 2.0,
                                                 config.limits.hard_bytes_per_second,
                                                 config.limits.input_per_second}),
      startTime_(utils::Clock::now()) {
    validator_.setLimits(security::ValidationLimits{});

    // Persistence is optional: without a connection string the server is a
    // pure in-memory game server, which is the intended offline deployment.
    if (config_.db.connection_string.empty()) {
        db_ = std::make_unique<database::NullDatabase>();
        NEON_INFO("database: no connection string configured, running in-memory");
    } else {
        db_ = std::make_unique<database::PostgresDatabase>(config_.db.connection_string,
                                                           config_.db.auto_migrate);
    }
    players_ = std::make_unique<database::PlayerRepository>(*db_);
    matchRepo_ = std::make_unique<database::MatchRepository>(*db_);

    matchmaker_.setMatchManager(&matches_);
    matchmaker_.setAssignCallback([this](uint32_t sessionId, uint32_t matchId) {
        // A queued session can be assigned to a match without anyone asking
        // again, so the player is created here rather than in handleJoin.
        assignToMatch(sessionId, matchId);
    });
}

GameServer::~GameServer() {
    stop();
}

bool GameServer::start(std::string& error) {
    std::string dbError;
    if (!db_->connect(dbError)) {
        // Persistence is a nice-to-have. Losing it must not stop the game.
        NEON_WARN("database: unavailable (", dbError, ") — continuing without persistence");
    } else if (db_->enabled()) {
        NEON_INFO("database: connected");
        db_->startWorkers(config_.db.worker_threads);
    }

    server_ = std::make_unique<WebSocketServer>(executor_, config_, *this);

    matches_.setFinishedCallback([this](std::shared_ptr<game::Match> match) {
        const double now = utils::nowMillis() / 1000.0;
        std::vector<game::RunResult> results;
        // The match already emitted its results through the state callback;
        // collect them here for persistence, off the hot path.
        for (const auto& holder : match->state().players()) {
            game::RunResult result;
            result.playerId = holder->id();
            result.playerName = holder->name();
            result.score = holder->score();
            result.kills = holder->kills();
            result.deaths = holder->deaths();
            result.wavesCleared = std::max(0, match->state().wave() - 1);
            result.seconds = match->state().time();
            result.survived = holder->alive();
            results.push_back(std::move(result));
        }
        matchRepo_->saveAsync(match->id(), match->mode(), now, match->state().time(),
                              match->state().wave(), results);
        for (const game::RunResult& result : results) {
            players_->applyRunAsync(result.playerId, result.playerName, result);
        }
        NEON_INFO("match ", match->id(), " finished at wave ", match->state().wave(), " with ",
                  results.size(), " player(s)");
    });

    // The game loop is a plain repeating timer on the io_context. It is the
    // single place GameState is mutated, so the simulation needs no locks.
    gameLoopTimer_ = std::make_unique<net::steady_timer>(executor_);
    scheduleGameLoop();

    // The loop clock starts now, not at construction: database connect and
    // bind happen in between, and counting that as simulation lag would
    // trigger a spurious "dropped time" on the first tick.
    ticker_ = utils::Ticker(config_.dt(), config_.tick.max_catchup_ticks);
    lastLoopTime_ = utils::Clock::now();
    // Seed the wall-clock windows, which are 0 to mean "not started yet".
    snapshotWindowStart_ = 0.0;
    maintenanceWindowStart_ = 0.0;
    rateWindowStart_ = 0.0;

    if (!server_->start()) {
        // The transport already logged the reason; surface it so the process
        // exits non-zero instead of idling on a port it never got.
        error = "failed to bind " + config_.host + ":" + std::to_string(config_.port);
        return false;
    }
    error.clear();
    return true;
}

void GameServer::scheduleGameLoop() {
    // 1 ms granularity: the ticker decides how many fixed steps that buys.
    // Waking this often costs an io_context timer but keeps the tick cadence
    // honest even when a match finishes or a client connects mid-frame.
    gameLoopTimer_->expires_after(std::chrono::milliseconds(1));
    gameLoopTimer_->async_wait([this](boost::system::error_code ec) {
        if (ec || stopping_.load()) return;
        gameLoop();
        scheduleGameLoop();
    });
}

void GameServer::stop() {
    if (!running_) return;
    running_ = false;
    stopping_.store(true);
    if (gameLoopTimer_) gameLoopTimer_->cancel();
    if (server_) server_->stop();
    if (db_) db_->stopWorkers();
}

void GameServer::requestStop() {
    stopping_.store(true);
    if (gameLoopTimer_) gameLoopTimer_->cancel();
    if (server_) server_->stop();
    if (onIoStop_) onIoStop_();
}

double GameServer::now() const {
    return utils::secondsBetween(startTime_, utils::Clock::now());
}

void GameServer::gameLoop() {
    const double dt = config_.dt();
    const utils::TimePoint currentTime = utils::Clock::now();
    const double elapsed = utils::secondsBetween(lastLoopTime_, currentTime);
    lastLoopTime_ = currentTime;

    // How many fixed steps this wake owes. The accumulator carries the
    // remainder between wakes, so a 1 ms timer still yields exactly
    // `tick_rate` steps per second. `Ticker` caps the catch-up and reports
    // when it had to drop time, which is the signal that the tick budget is
    // being exceeded.
    const int steps = ticker_.advance(elapsed);
    if (ticker_.droppedTime()) {
        NEON_WARN("game loop: dropped time; simulated ", steps,
                  " tick(s) and discarded the rest (the tick budget is exceeded)");
    }
    if (steps == 0) return;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        const double wallClock = now();

        for (int i = 0; i < steps; ++i) {
            matches_.tick(dt, wallClock, true);
            ++tick_;
        }

        std::size_t entities = 0;
        for (const auto& [id, match] : matches_.all()) entities += match->state().entityCount();

        const double snapshotInterval = 1.0 / static_cast<double>(config_.tick.snapshot_hz);
        if (wallClock - snapshotWindowStart_ >= snapshotInterval) {
            snapshotWindowStart_ = wallClock;
            broadcastSnapshots();
        }

        // Both of these run on wall-clock windows, measured from `now()`.
        //
        // They must not accumulate the per-wake delta: the timer wakes far
        // more often than the simulation ticks, so summing the delta of the
        // wakes that produced a tick accounts for only a fraction of real
        // time, and a one-second "window" would really be a dozen seconds.
        if (maintenanceWindowStart_ <= 0.0) maintenanceWindowStart_ = wallClock;
        if (wallClock - maintenanceWindowStart_ >= kMaintenanceInterval) {
            maintenanceWindowStart_ = wallClock;
            reapIdleSessions();
            matchmaker_.expireQueue(wallClock, 120.0);
            matchmaker_.pump(wallClock);
        }

        if (rateWindowStart_ <= 0.0) rateWindowStart_ = wallClock;
        rateWindowTicks_ += static_cast<uint64_t>(steps);
        const double rateWindow = wallClock - rateWindowStart_;
        if (rateWindow >= 1.0) {
            tickRateMeter_.set(static_cast<double>(rateWindowTicks_) / rateWindow);
            tickRateMeter_.addSamples(rateWindowTicks_);
            entityMeter_.sample(static_cast<double>(entities));
            rateWindowStart_ = wallClock;
            rateWindowTicks_ = 0;
        }
    }
}

void GameServer::broadcastSnapshots() {
    if (!server_) return;

    for (const auto& [matchId, match] : matches_.all()) {
        if (match->phase() != game::MatchPhase::Running) continue;
        const game::GameState& state = match->state();
        const double wallClock = now();

        for (auto& [sessionId, session] : server_->mutableSessions()) {
            if (!session.inMatch() || session.matchId != matchId) continue;
            // Acknowledge the newest input each client has sent us.
            const game::Player* player = state.findPlayer(session.playerId);
            if (player == nullptr) continue;
            const json snapshot = makeSnapshot(state.tickCount(), player->lastInputSeq(), state, wallClock);
            send(session, serialise(snapshot));
            ++session.snapshotsOut;
        }
    }
}

void GameServer::reapIdleSessions() {
    if (!server_) return;
    const double wallClock = now();
    std::vector<uint32_t> stale;
    for (const auto& [sessionId, session] : server_->sessions()) {
        if (session.idleFor(wallClock, kIdleTimeoutSeconds)) stale.push_back(sessionId);
    }
    for (uint32_t sessionId : stale) {
        NEON_INFO("session ", sessionId, ": idle for ", kIdleTimeoutSeconds, "s, closing");
        server_->closeSession(sessionId, "idle timeout");
    }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

void GameServer::send(Session& session, const std::string& payload) {
    if (!server_) return;
    bytesOut_.fetch_add(payload.size());
    server_->sendTo(session.id, payload);
}

void GameServer::sendJson(Session& session, const json& message) {
    send(session, serialise(message));
}

void GameServer::replyError(Session& session, int code, const std::string& message) {
    sendJson(session, makeError(code, message));
}

void GameServer::sendWelcome(Session& session) {
    const game::Arena arena(config_.arena_w, config_.arena_h);
    sendJson(session, makeWelcome(session.playerId, tick_, config_.tick_rate, arena));
}

void GameServer::sendJoined(Session& session, const std::shared_ptr<game::Match>& match) {
    std::vector<std::pair<uint32_t, std::string>> roster;
    for (const auto& holder : match->state().players()) {
        roster.emplace_back(holder->id(), holder->name());
    }
    sendJson(session, makeJoined(match->id(), match->mode(), roster));
}

void GameServer::assignToMatch(uint32_t sessionId, uint32_t matchId) {
    if (!server_) return;
    auto it = server_->mutableSessions().find(sessionId);
    if (it == server_->mutableSessions().end()) return;
    Session& session = it->second;

    auto match = matches_.find(matchId);
    if (!match) return;
    if (session.playerId == 0) session.playerId = nextPlayerId_++;

    if (match->state().findPlayer(session.playerId) == nullptr) {
        match->state().addPlayer(session.playerId, session.name);
    }
    session.matchId = matchId;
    session.state = SessionState::InMatch;
    sessionByPlayer_[session.playerId] = sessionId;

    sendJoined(session, match);
}

// ---------------------------------------------------------------------------
// Inbound message handling
// ---------------------------------------------------------------------------

void GameServer::onSessionOpened(Session& session) {
    // Every connection gets a budget the moment it exists. Doing this on
    // CONNECT instead would mean the handshake itself was unmetered, and a
    // flood of garbage handshakes would never be counted.
    std::lock_guard<std::mutex> lock(mutex_);
    rateLimiter_.attach(session.id);
}

void GameServer::onTextMessage(Session& session, const std::string& payload) {
    std::lock_guard<std::mutex> lock(mutex_);
    const double wallClock = now();
    session.lastSeenSeconds = wallClock;
    ++session.messagesIn;
    session.bytesIn += payload.size();
    messagesIn_.fetch_add(1);
    bytesIn_.fetch_add(payload.size());

    // Rate limiting happens before parsing: a flood should cost a bucket
    // token, not a JSON parse.
    const security::RateDecision decision =
        rateLimiter_.onMessage(session.id, payload.size(), wallClock);
    if (!decision.allow) {
        rateLimited_.fetch_add(1);
        ++session.rejected;
        if (decision.disconnect) {
            NEON_WARN("session ", session.id, ": disconnecting (", decision.reason, ")");
            if (server_) server_->closeSession(session.id, decision.reason);
        }
        return;
    }

    const InboundMessage message = parseMessage(payload);
    switch (message.kind) {
        case InboundMessage::Kind::Connect: handleConnect(session, message); break;
        case InboundMessage::Kind::Auth: handleAuth(session, message); break;
        case InboundMessage::Kind::Join: handleJoin(session, message); break;
        case InboundMessage::Kind::Leave: handleLeave(session); break;
        case InboundMessage::Kind::Input: handleInput(session, message); break;
        case InboundMessage::Kind::Ability: handleAbility(session, message); break;
        case InboundMessage::Kind::Ping: handlePing(session, message); break;
        case InboundMessage::Kind::Resync: handleResync(session, message); break;
        case InboundMessage::Kind::Unknown:
            replyError(session, kErrUnknownType, "unrecognised message type");
            break;
    }
}

void GameServer::handleConnect(Session& session, const InboundMessage& message) {
    if (!security::ServerValidator::supportedVersion(message.version)) {
        replyError(session, kErrVersionMismatch,
                   "unsupported protocol version " + std::to_string(message.version));
        session.close();
        return;
    }
    session.client = message.client.empty() ? "unknown" : message.client;
    session.device = message.device;
    session.state = SessionState::Handshaking;
}

void GameServer::handleAuth(Session& session, const InboundMessage& message) {
    if (session.state == SessionState::Connected) {
        // The handshake must come first; refusing here keeps unauthenticated
        // clients out of the session table's expensive paths.
        replyError(session, kErrNotAuthenticated, "CONNECT must precede AUTH");
        return;
    }

    const std::string name = security::ServerValidator::sanitiseName(message.name, 20);
    if (name.empty()) {
        replyError(session, kErrNameRejected, "display name must be 1-20 printable characters");
        return;
    }
    session.name = name;
    session.authToken = message.token;
    if (session.playerId == 0) session.playerId = nextPlayerId_++;
    session.state = SessionState::Authenticated;

    sendWelcome(session);
    sendJson(session, makeAuthOk(session.playerId, name));

    // Persist the profile in the background; never block the handshake on it.
    database::PlayerRecord record;
    record.id = session.playerId;
    record.name = name;
    record.authToken = message.token;
    record.lastSeen = wallClockSeconds();
    players_->saveAsync(record);
}

void GameServer::handleJoin(Session& session, const InboundMessage& message) {
    if (!session.authenticated()) {
        replyError(session, kErrNotAuthenticated, "AUTH must precede JOIN");
        return;
    }
    std::string mode = message.mode.empty() ? "arena" : message.mode;
    if (!security::ServerValidator::validMode(mode)) {
        replyError(session, kErrInvalidInput, "unknown match mode '" + mode + "'");
        return;
    }

    std::shared_ptr<game::Match> match;
    const matchmaking::JoinResult result =
        matchmaker_.join(session.id, session.name, mode, now(), match);

    switch (result) {
        case matchmaking::JoinResult::Joined:
            if (match) assignToMatch(session.id, match->id());
            break;
        case matchmaking::JoinResult::Queued:
            // The matchmaker will call back through the assign callback once a
            // match exists; the client sees JOINED at that point.
            sendJson(session, json{{"t", "QUEUED"}, {"mode", mode}});
            break;
        case matchmaking::JoinResult::NoCapacity:
            replyError(session, kErrServerFull, "server is at capacity, try again shortly");
            break;
        case matchmaking::JoinResult::BadMode:
            replyError(session, kErrInvalidInput, "unknown match mode");
            break;
    }
}

void GameServer::handleLeave(Session& session) { destroySession(session.id, "client left"); }

void GameServer::handleInput(Session& session, const InboundMessage& message) {
    if (!session.inMatch()) return;

    const security::RateDecision decision = rateLimiter_.onInput(session.id, now());
    if (!decision.allow) {
        rateLimited_.fetch_add(1);
        return;
    }
    ++session.inputsIn;

    game::PlayerInput input;
    const security::RejectReason reason =
        validator_.validateInput(message, session.lastInputSeq, input);
    if (reason != security::RejectReason::Accepted) {
        invalidInputs_.fetch_add(1);
        ++session.rejected;
        NEON_DEBUG("session ", session.id, ": input rejected: ", security::describe(reason));
        return;
    }

    auto match = matches_.find(session.matchId);
    if (!match) {
        destroySession(session.id, "match no longer exists");
        return;
    }
    match->state().submitInput(session.playerId, input);
}

void GameServer::handleAbility(Session& session, const InboundMessage& message) {
    if (!session.inMatch()) return;
    game::AbilityKind kind;
    if (!validator_.validateAbility(message.ability, kind)) {
        replyError(session, kErrInvalidInput, "unknown ability '" + message.ability + "'");
        return;
    }
    auto match = matches_.find(session.matchId);
    if (!match) return;
    // The server applies its own cooldown: a client spamming the request gets
    // exactly as many activations as the rules allow.
    match->state().requestAbility(session.playerId, kind);
}

void GameServer::handlePing(Session& session, const InboundMessage& message) {
    sendJson(session, makePong(message.pingId, message.clientTick, tick_));
}

void GameServer::handleResync(Session& session, const InboundMessage& message) {
    auto match = matches_.find(session.matchId);
    if (!match || match->phase() != game::MatchPhase::Running) return;
    // A full snapshot at the current tick is the cheapest correct answer to a
    // resync request; there is no history to replay from.
    const game::Player* player = match->state().findPlayer(session.playerId);
    const uint64_t ack = player != nullptr ? player->lastInputSeq() : 0;
    sendJson(session, makeSnapshot(match->state().tickCount(), ack, match->state(), now()));
}

void GameServer::onSessionClosed(Session& session, const std::string& reason) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (session.state == SessionState::Closed) return;
    session.close();
    rateLimiter_.detach(session.id);
    sessionByPlayer_.erase(session.playerId);
    matchmaker_.leave(session.id);

    if (auto match = matches_.find(session.matchId)) {
        match->state().removePlayer(session.playerId);
        NEON_DEBUG("session ", session.id, " closed (", reason, "), removed from match ",
                   session.matchId);
    }
    NEON_INFO("session ", session.id, " (", session.name, ") closed: ", reason);
}

void GameServer::destroySession(uint32_t sessionId, const std::string& reason) {
    if (server_) server_->closeSession(sessionId, reason);
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

HttpResponse GameServer::onHttp(const HttpRequest& request) {
    HttpResponse response;
    try {
        response = routeRest(request);
    } catch (const std::exception& e) {
        response.status = 500;
        response.body = json{{"error", "internal error"}}.dump();
    }
    return response;
}

HttpResponse GameServer::routeRest(const HttpRequest& request) {
    HttpResponse response;
    const std::vector<std::string> parts = splitPath(request.path);

    if (request.method == "OPTIONS") {
        response.status = 204;
        return response;
    }

    // CORS preflight and simple GETs.
    if (request.path == "/healthz" || request.path == "/api/health") {
        response.body = handleHealth().dump();
        return response;
    }
    if (request.path == "/api/auth/login" && request.method == "POST") {
        response.body = handleLogin(request).dump();
        return response;
    }
    if (request.path == "/api/auth/register" && request.method == "POST") {
        response.body = handleRegister(request).dump();
        return response;
    }
    if (request.path == "/api/player/profile" && request.method == "GET") {
        response.body = handleProfile(request).dump();
        return response;
    }
    if (request.path == "/api/leaderboard" && request.method == "GET") {
        response.body = handleLeaderboard(request).dump();
        return response;
    }
    if (request.path == "/api/matches" && request.method == "GET") {
        response.body = handleMatches(request).dump();
        return response;
    }

    (void)parts;
    response.status = 404;
    response.body = json{{"error", "not found"}}.dump();
    return response;
}

json GameServer::handleHealth() {
    const ServerStats s = stats();
    return json{{"status", "ok"},
                {"uptimeSeconds", s.uptimeSeconds},
                {"tick", s.tick},
                {"tickRate", std::round(s.tickRate)},
                {"tickLoad", s.tickLoad},
                {"sessions", s.sessions},
                {"matches", s.matches},
                {"players", s.players},
                {"queued", s.queued},
                {"entities", s.entities},
                {"messagesIn", s.messagesIn},
                {"bytesIn", s.bytesIn},
                {"bytesOut", s.bytesOut},
                {"rateLimited", s.rateLimited},
                {"invalidInputs", s.invalidInputs},
                {"database", s.databaseConnected ? "connected" : "disabled"}};
}

json GameServer::handleLogin(const HttpRequest& request) {
    json body;
    try {
        body = json::parse(request.body);
    } catch (...) {
        return json{{"error", "malformed JSON"}};
    }
    const std::string name = security::ServerValidator::sanitiseName(
        body.value("name", std::string()), 20);
    if (name.empty()) return json{{"error", "name is required"}};

    database::PlayerRecord record;
    std::string error;
    if (!db_->enabled() || !players_->findByName(name, record, error)) {
        // Without persistence a token is all that can be issued; the client
        // still gets a stable identity for the session.
        return json{{"ok", true}, {"name", name}, {"persisted", false}};
    }
    return json{{"ok", true},
                {"id", record.id},
                {"name", record.name},
                {"bestScore", record.bestScore},
                {"credits", record.credits},
                {"persisted", true}};
}

json GameServer::handleRegister(const HttpRequest& request) {
    json body;
    try {
        body = json::parse(request.body);
    } catch (...) {
        return json{{"error", "malformed JSON"}};
    }
    const std::string name = security::ServerValidator::sanitiseName(
        body.value("name", std::string()), 20);
    if (name.empty()) return json{{"error", "name is required"}};

    database::PlayerRecord record;
    record.name = name;
    record.lastSeen = wallClockSeconds();

    database::PlayerRecord existing;
    std::string error;
    if (players_->findByName(name, existing, error)) {
        return json{{"error", "name is taken"}};
    }
    if (!db_->enabled()) {
        return json{{"ok", true}, {"name", name}, {"persisted", false}};
    }
    if (!players_->upsert(record, existing, error)) {
        return json{{"error", error}};
    }
    return json{{"ok", true}, {"id", existing.id}, {"name", existing.name}, {"persisted", true}};
}

json GameServer::handleProfile(const HttpRequest& request) {
    // `?name=` for an explicit lookup, otherwise the most recently joined
    // session's player.
    std::string name;
    const std::size_t query = request.target.find('?');
    if (query != std::string::npos) {
        const std::string tail = request.target.substr(query + 1);
        const std::size_t eq = tail.find('=');
        if (tail.rfind("name=", 0) == 0) name = tail.substr(5);
    }
    if (name.empty()) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!server_ || server_->sessions().empty()) return json{{"error", "no active session"}};
        for (const auto& [sessionId, session] : server_->sessions()) {
            (void)sessionId;
            if (session.authenticated()) {
                name = session.name;
                break;
            }
        }
    }
    if (name.empty()) return json{{"error", "name is required"}};

    database::PlayerRecord record;
    std::string error;
    if (!players_->findByName(name, record, error)) {
        return json{{"found", false}, {"name", name}};
    }
    return json{{"found", true},
                {"id", record.id},
                {"name", record.name},
                {"bestScore", record.bestScore},
                {"totalScore", record.totalScore},
                {"totalKills", record.totalKills},
                {"totalDeaths", record.totalDeaths},
                {"totalWaves", record.totalWaves},
                {"credits", record.credits},
                {"gamesPlayed", record.gamesPlayed}};
}

json GameServer::handleLeaderboard(const HttpRequest& request) {
    std::size_t limit = 20;
    const std::size_t query = request.target.find('?');
    if (query != std::string::npos) {
        const std::string tail = request.target.substr(query + 1);
        if (tail.rfind("limit=", 0) == 0) {
            const long parsed = std::strtol(tail.substr(6).c_str(), nullptr, 10);
            if (parsed > 0) limit = std::min<std::size_t>(100, static_cast<std::size_t>(parsed));
        }
    }
    std::vector<database::LeaderboardEntry> entries;
    std::string error;
    if (!matchRepo_->top(limit, entries, error)) {
        return json{{"error", error.empty() ? "leaderboard unavailable" : error}};
    }
    json rows = json::array();
    for (const auto& entry : entries) {
        rows.push_back(json{{"rank", entry.rank},
                            {"name", entry.name},
                            {"bestScore", entry.bestScore},
                            {"totalScore", entry.totalScore},
                            {"kills", entry.kills},
                            {"games", entry.games}});
    }
    return json{{"entries", std::move(rows)}};
}

json GameServer::handleMatches(const HttpRequest& request) {
    std::size_t limit = 20;
    const std::size_t query = request.target.find('?');
    if (query != std::string::npos) {
        const std::string tail = request.target.substr(query + 1);
        if (tail.rfind("limit=", 0) == 0) {
            const long parsed = std::strtol(tail.substr(6).c_str(), nullptr, 10);
            if (parsed > 0) limit = std::min<std::size_t>(100, static_cast<std::size_t>(parsed));
        }
    }
    std::vector<database::MatchRecord> records;
    std::string error;
    if (!matchRepo_->recent(limit, records, error)) {
        return json{{"error", error.empty() ? "match history unavailable" : error}};
    }
    json rows = json::array();
    for (const auto& record : records) {
        rows.push_back(json{{"id", record.id},
                            {"mode", record.mode},
                            {"startedAt", record.startedAt},
                            {"duration", record.duration},
                            {"wave", record.wave},
                            {"players", record.playerCount}});
    }
    return json{{"matches", std::move(rows)}};
}

ServerStats GameServer::stats() const {
    ServerStats s;
    s.uptimeSeconds = static_cast<uint64_t>(now());
    s.tick = tick_;
    s.tickRate = tickRateMeter_.value();
    s.tickLoad = ticker_.loadFactor();
    s.sessions = server_ ? server_->activeSessions() : 0;
    s.matches = matches_.count();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        s.players = sessionByPlayer_.size();
    }
    s.queued = matchmaker_.queueLength();
    s.entities = static_cast<std::size_t>(entityMeter_.value());
    s.messagesIn = messagesIn_.load();
    s.bytesIn = bytesIn_.load();
    s.bytesOut = bytesOut_.load();
    s.rateLimited = rateLimited_.load();
    s.invalidInputs = invalidInputs_.load();
    s.databaseConnected = db_ && db_->connected();
    s.dbQueued = db_ ? db_->queued() : 0;
    s.dbWritten = db_ ? db_->written() : 0;
    return s;
}

}  // namespace neon::core
