// Neon Vanguard — protocol and security tests.
//
// The server is the trust boundary, so these tests are mostly about what the
// server refuses to accept, plus the encode/decode round trip that the
// TypeScript client depends on.

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "game/Arena.hpp"
#include "game/GameState.hpp"
#include "network/Packet.hpp"
#include "security/RateLimiter.hpp"
#include "security/ServerValidator.hpp"
#include "utils/Timer.hpp"
#include "harness.hpp"

using namespace neon::network;
using namespace neon::security;
using namespace neon::utils;
namespace utils = neon::utils;

namespace {

/// Mirrors backoffDelay() in src/network/protocol.ts: 1s, 2s, 4s, ... 30s.
int backoffMs(int attempt) {
    if (attempt <= 1) return 1000;
    const int d = 1000 << (attempt - 1);
    return d > 30000 ? 30000 : d;
}

InboundMessage input(double mx, double my, double ax, double ay, uint64_t seq, bool firing) {
    return parseMessage("{\"t\":\"INPUT\",\"s\":" + std::to_string(seq) + ",\"c\":1,\"mx\":" +
                        std::to_string(mx) + ",\"my\":" + std::to_string(my) + ",\"ax\":" +
                        std::to_string(ax) + ",\"ay\":" + std::to_string(ay) + ",\"f\":" +
                        (firing ? "1" : "0") + "}");
}

}  // namespace

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

TEST_CASE("network", "protocol: a well-formed input message round-trips") {
    const InboundMessage m = input(0.5, -0.25, 100.0, 200.0, 42, true);
    CHECK(m.kind == InboundMessage::Kind::Input);
    CHECK_EQ(m.sequence, uint64_t(42));
    CHECK_NEAR(m.moveX, 0.5, 1e-9);
    CHECK_NEAR(m.moveY, -0.25, 1e-9);
    CHECK_NEAR(m.aimX, 100.0, 1e-9);
    CHECK(m.firing);
}

TEST_CASE("network", "protocol: malformed and unknown frames are rejected, not crashed on") {
    CHECK(parseMessage("not json").kind == InboundMessage::Kind::Unknown);
    CHECK(parseMessage("{}").kind == InboundMessage::Kind::Unknown);
    CHECK(parseMessage("{\"t\":\"NONSENSE\"}").kind == InboundMessage::Kind::Unknown);
    CHECK(parseMessage("[]").kind == InboundMessage::Kind::Unknown);
    CHECK(parseMessage("").kind == InboundMessage::Kind::Unknown);
}

TEST_CASE("network", "protocol: wrong-typed fields fall back instead of throwing") {
    // A client that sends a string where a number belongs must not be able to
    // crash the parser or smuggle a value through.
    const InboundMessage m = parseMessage("{\"t\":\"INPUT\",\"s\":\"abc\",\"mx\":\"x\"}");
    CHECK(m.kind == InboundMessage::Kind::Input);
    CHECK_EQ(m.sequence, uint64_t(0));
    CHECK_NEAR(m.moveX, 0.0, 1e-9);
}

TEST_CASE("network", "protocol: an oversized name field is truncated, not buffered") {
    const std::string huge(4096, 'A');
    const InboundMessage m = parseMessage("{\"t\":\"AUTH\",\"name\":\"" + huge + "\"}");
    // AUTH names are capped at 64 by the parser, well below any legal length.
    CHECK_EQ(m.name.size(), std::size_t(64));
}

TEST_CASE("network", "protocol: every server message type serialises and parses back") {
    const json welcome = makeWelcome(7, 1234, 60, Arena(1280.0, 600.0));
    const InboundMessage parsed = parseMessage(welcome.dump());
    CHECK(parsed.kind == InboundMessage::Kind::Unknown);  // server->client tag
    // The raw JSON still has to be valid and carry the expected keys.
    const json round = json::parse(serialise(welcome));
    CHECK_EQ(round["t"].get<std::string>(), std::string(kWelcome));
    CHECK_EQ(round["id"].get<int>(), 7);
    CHECK_NEAR(round["aw"].get<double>(), 1280.0, 0.1);

    const json error = makeError(kErrRateLimited, "slow down");
    const json errorRound = json::parse(serialise(error));
    CHECK_EQ(errorRound["code"].get<int>(), kErrRateLimited);

    const json pong = makePong(9, 5, 600);
    const json pongRound = json::parse(serialise(pong));
    CHECK_EQ(pongRound["i"].get<int>(), 9);
    CHECK_EQ(pongRound["k"].get<int>(), 600);
}

TEST_CASE("network", "protocol: a snapshot carries the ack the client needs to reconcile") {
    GameStateLimits limits;
    GameState state(1, Arena(960.0, 600.0), limits);
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    state.mutableEnemyField().spawn(EnemyKind::Grunt, {100.0, 100.0}, 1);

    PlayerInput in;
    in.sequence = 17;
    in.valid = true;
    state.submitInput(1, in);
    state.tick(1.0 / 60.0);

    const json snapshot = makeSnapshot(state.tickCount(), player->lastInputSeq(), state, 0.0);
    CHECK_EQ(snapshot["t"].get<std::string>(), std::string(kSnap));
    CHECK_EQ(snapshot["a"].get<int>(), 17);
    CHECK_EQ(snapshot["p"].size(), std::size_t(1));
    CHECK_EQ(snapshot["e"].size(), std::size_t(1));
    // Flat numeric arrays, not objects: that is the byte-size optimisation.
    CHECK(snapshot["p"][0].is_array());
    CHECK_EQ(snapshot["p"][0].size(), std::size_t(9));
    CHECK_EQ(snapshot["e"][0].size(), std::size_t(7));
}

TEST_CASE("network", "protocol: quantisation keeps positions within its stated precision") {
    CHECK_NEAR(quantise1(1.234), 1.2, 1e-9);
    CHECK_NEAR(quantise2(0.126), 0.13, 1e-9);
    CHECK_NEAR(quantise3(1.23456), 1.235, 1e-9);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

TEST_CASE("security", "validate: a legitimate sample is accepted and advances the watermark") {
    ServerValidator validator;
    uint64_t lastSequence = 0;
    PlayerInput out;

    CHECK(validator.validateInput(input(0.5, 0.5, 100.0, 100.0, 10, true), lastSequence, out) ==
          RejectReason::Accepted);
    CHECK(out.valid);
    CHECK_EQ(lastSequence, uint64_t(10));
}

TEST_CASE("security", "validate: a replayed or reordered sequence is refused") {
    ServerValidator validator;
    uint64_t lastSequence = 0;
    PlayerInput out;

    validator.validateInput(input(0.0, 0.0, 0.0, 0.0, 10, false), lastSequence, out);
    // Same sequence again: a duplicate delivery.
    CHECK(validator.validateInput(input(0.0, 0.0, 0.0, 0.0, 10, false), lastSequence, out) ==
          RejectReason::StaleSequence);
    // Lower sequence: an old frame arriving late.
    CHECK(validator.validateInput(input(0.0, 0.0, 0.0, 0.0, 5, false), lastSequence, out) ==
          RejectReason::OutOfOrder);
    // The watermark must not have moved backwards.
    CHECK_EQ(lastSequence, uint64_t(10));
}

TEST_CASE("security", "validate: NaN and infinity are refused before reaching the integrator") {
    ServerValidator validator;
    uint64_t lastSequence = 0;
    PlayerInput out;

    // JSON has no NaN literal, so a client sends either an overflowing
    // number (which the parser may reject outright) or a non-numeric type.
    // Either way the sample must never be accepted.
    const InboundMessage overflow = parseMessage("{\"t\":\"INPUT\",\"s\":1,\"mx\":1e400}");
    if (overflow.kind == InboundMessage::Kind::Input) {
        CHECK(validator.validateInput(overflow, lastSequence, out) != RejectReason::Accepted);
    }
    CHECK(!out.valid);
    CHECK_EQ(lastSequence, uint64_t(0));

    InboundMessage inf = input(0.0, 0.0, 0.0, 0.0, 2, false);
    inf.moveX = std::numeric_limits<double>::infinity();
    CHECK(validator.validateInput(inf, lastSequence, out) == RejectReason::NonFinite);
    CHECK_EQ(lastSequence, uint64_t(0));  // unchanged
}

TEST_CASE("security", "validate: an absurd movement vector is refused, not clamped") {
    ServerValidator validator;
    uint64_t lastSequence = 0;
    PlayerInput out;
    CHECK(validator.validateInput(input(50.0, 50.0, 0.0, 0.0, 1, false), lastSequence, out) ==
          RejectReason::MovementTooFast);
    CHECK(!out.valid);
    // A marginal overshoot is still allowed through, since the integrator
    // normalises it anyway.
    CHECK(validator.validateInput(input(1.01, 0.0, 0.0, 0.0, 2, false), lastSequence, out) ==
          RejectReason::Accepted);
}

TEST_CASE("security", "validate: an aim point beyond the limit is clamped by default") {
    ServerValidator validator;
    uint64_t lastSequence = 0;
    PlayerInput out;

    InboundMessage m = input(0.0, 0.0, 1e9, 0.0, 1, false);
    CHECK(validator.validateInput(m, lastSequence, out) == RejectReason::Accepted);
    CHECK_NEAR(out.aim.x, validator.limits().maxAimDistance, 1e-6);

    // In strict mode the same sample is refused outright.
    ValidationLimits strict;
    strict.strictAim = true;
    validator.setLimits(strict);
    uint64_t other = 0;
    CHECK(validator.validateInput(m, other, out) == RejectReason::AimOutOfRange);
}

TEST_CASE("security", "validate: sequence zero is always refused") {
    ServerValidator validator;
    uint64_t lastSequence = 0;
    PlayerInput out;
    CHECK(validator.validateInput(input(0.0, 0.0, 0.0, 0.0, 0, false), lastSequence, out) ==
          RejectReason::StaleSequence);
}

TEST_CASE("security", "validate: only known abilities are accepted") {
    ServerValidator validator;
    neon::game::AbilityKind kind;
    CHECK(validator.validateAbility("dash", kind));
    CHECK(kind == neon::game::AbilityKind::Dash);
    CHECK(validator.validateAbility("bomb", kind));
    CHECK(kind == neon::game::AbilityKind::Bomb);
    CHECK(!validator.validateAbility("teleport", kind));
    CHECK(!validator.validateAbility("", kind));
    CHECK(!validator.validateAbility("DASH", kind));  // case sensitive
}

TEST_CASE("security", "validate: names are stripped of control and invisible characters") {
    CHECK_EQ(ServerValidator::sanitiseName("Pilot"), std::string("Pilot"));
    // ANSI escape injection: the escape and the bracket are removed, so a name
    // can never repaint a terminal or forge a log line.
    const std::string injected = "Pi\x1b[31mlot";
    const std::string clean = ServerValidator::sanitiseName(injected, 20);
    CHECK(clean.find('\x1b') == std::string::npos);
    // The whole CSI sequence goes, not just the escape byte: "[31m" is the
    // part that would render as garbage in a naive log or client.
    CHECK(clean.find('[') == std::string::npos);
    CHECK_EQ(clean, std::string("Pilot"));
    // Right-to-left override, used to disguise a name.
    CHECK(ServerValidator::sanitiseName("a\xe2\x80\xae""b", 20).find('\xe2') == std::string::npos);
    // Length is capped.
    CHECK_EQ(ServerValidator::sanitiseName(std::string(200, 'x'), 20).size(), std::size_t(20));
    // Whitespace is collapsed and trimmed.
    CHECK_EQ(ServerValidator::sanitiseName("  a   b  ", 20), std::string("a b"));
    CHECK(ServerValidator::sanitiseName("   ", 20).empty());
}

TEST_CASE("security", "validate: only supported protocol versions and modes pass") {
    CHECK(ServerValidator::supportedVersion(1));
    CHECK(!ServerValidator::supportedVersion(0));
    CHECK(!ServerValidator::supportedVersion(2));
    CHECK(ServerValidator::validMode("arena"));
    CHECK(ServerValidator::validMode("coop"));
    CHECK(!ServerValidator::validMode("ranked"));
    CHECK(!ServerValidator::validMode(""));
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

TEST_CASE("security", "rate limit: the message bucket allows a burst then throttles") {
    RateLimiter limiter(RateLimiter::Config{});
    limiter.attach(1);

    // The burst allowance is spent first.
    int allowed = 0;
    for (int i = 0; i < 500; ++i) {
        if (limiter.onMessage(1, 10, 0.0).allow) ++allowed;
    }
    CHECK_EQ(allowed, 240);  // the configured burst
    CHECK(!limiter.onMessage(1, 10, 0.0).allow);
}

TEST_CASE("security", "rate limit: tokens refill over time") {
    RateLimiter limiter(RateLimiter::Config{});
    limiter.attach(1);
    while (limiter.onMessage(1, 10, 0.0).allow) {
    }
    // 120 messages per second, so 0.5s buys 60 more.
    int allowed = 0;
    for (int i = 0; i < 100; ++i) {
        if (limiter.onMessage(1, 10, 0.5).allow) ++allowed;
    }
    CHECK_MSG(allowed >= 55 && allowed <= 65, "refill should be about 60 messages, got " +
                                               std::to_string(allowed));
}

TEST_CASE("security", "rate limit: sustained abuse is disconnected, not just throttled") {
    RateLimiter limiter(RateLimiter::Config{});
    limiter.attach(1);
    bool disconnected = false;
    for (int i = 0; i < 300; ++i) {
        const RateDecision d = limiter.onMessage(1, 10, 0.0);
        if (d.disconnect) {
            disconnected = true;
            break;
        }
    }
    CHECK_MSG(disconnected, "a persistent flood must escalate to a disconnect");
}

TEST_CASE("security", "rate limit: an unknown session is refused outright") {
    RateLimiter limiter(RateLimiter::Config{});
    const RateDecision d = limiter.onMessage(999, 10, 0.0);
    CHECK(!d.allow);
    CHECK(d.disconnect);
}

TEST_CASE("security", "rate limit: a hard bandwidth breach disconnects on the spot") {
    RateLimiter::Config config;
    config.hardBytesPerSecond = 1000.0;
    RateLimiter limiter(config);
    limiter.attach(1);

    // 200 KiB inside a one-second window is well past the hard ceiling.
    const RateDecision d = limiter.onMessage(1, 200 * 1024, 0.0);
    CHECK(!d.allow);
    CHECK(d.disconnect);
}

TEST_CASE("security", "rate limit: the input budget is separate and tighter") {
    RateLimiter limiter(RateLimiter::Config{});
    limiter.attach(1);
    // Drain the input bucket, which is much smaller than the message bucket.
    int allowed = 0;
    for (int i = 0; i < 500; ++i) {
        if (limiter.onInput(1, 0.0).allow) ++allowed;
    }
    CHECK_EQ(allowed, 180);  // inputPerSecond * 2
}

TEST_CASE("security", "rate limit: detaching a session forgets its budget") {
    RateLimiter limiter(RateLimiter::Config{});
    limiter.attach(1);
    limiter.detach(1);
    CHECK_EQ(limiter.trackedSessions(), std::size_t(0));
    CHECK(!limiter.onMessage(1, 10, 0.0).allow);
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

TEST_CASE("network", "reconnection: backoff doubles and then holds at the ceiling") {
    // Mirrors backoffDelay() in src/network/protocol.ts.
    CHECK_EQ(backoffMs(1), 1000);
    CHECK_EQ(backoffMs(2), 2000);
    CHECK_EQ(backoffMs(3), 4000);
    CHECK_EQ(backoffMs(4), 8000);
    CHECK_EQ(backoffMs(5), 16000);
    CHECK_EQ(backoffMs(6), 30000);  // ceiling
    CHECK_EQ(backoffMs(20), 30000);
}

TEST_CASE("network", "ticker: a fixed step produces a whole number of ticks") {
    utils::Ticker ticker(1.0 / 60.0, 5);
    // 100ms of real time is exactly six ticks at 60 Hz.
    int steps = 0;
    for (int i = 0; i < 10; ++i) steps += ticker.advance(0.01);
    CHECK_EQ(steps, 6);
}

TEST_CASE("network", "ticker: a long stall drops time instead of spiralling") {
    utils::Ticker ticker(1.0 / 60.0, 5);
    // A five-second freeze: running 300 catch-up ticks would take longer than
    // the freeze itself, so the surplus must be discarded.
    const int steps = ticker.advance(5.0);
    CHECK_EQ(steps, 5);
    CHECK(ticker.droppedTime());
    // And the next window starts clean rather than still owing time.
    CHECK_EQ(ticker.advance(0.0), 0);
}

TEST_CASE("network", "ticker: a partial step is carried, not lost") {
    utils::Ticker ticker(1.0 / 60.0, 5);
    CHECK_EQ(ticker.advance(0.005), 0);
    CHECK_EQ(ticker.advance(0.005), 0);
    // Two half-steps make one whole step.
    CHECK_EQ(ticker.advance(0.008), 1);
}

NEON_TEST_MAIN("network")
