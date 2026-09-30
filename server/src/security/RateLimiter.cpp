#include "security/RateLimiter.hpp"

#include <algorithm>

namespace neon::security {

RateLimiter::RateLimiter(const Config& config) : config_(config) {}

void RateLimiter::attach(uint64_t sessionId) {
    // emplace rather than operator[]: Session is not default-constructible,
    // and this also resets any budget the id may have had from a prior
    // connection with the same id.
    auto [it, inserted] = sessions_.try_emplace(sessionId, config_);
    it->second.windowStart = -1.0;
    it->second.bytesIn = 0;
    it->second.messagesIn = 0;
    it->second.rejected = 0;
    if (!inserted) {
        // Re-attach: give the session a fresh set of buckets.
        it->second = Session(config_);
    }
}

void RateLimiter::detach(uint64_t sessionId) { sessions_.erase(sessionId); }

RateDecision RateLimiter::onMessage(uint64_t sessionId, std::size_t bytes, double nowSeconds) {
    auto it = sessions_.find(sessionId);
    if (it == sessions_.end()) {
        // Unknown session: the caller has already torn the connection down.
        return {false, true, "unknown session"};
    }
    Session& session = it->second;

    // A single frame bigger than the entire hard budget cannot be legitimate:
    // a real input message is under 200 bytes. Catch it here rather than
    // waiting for the one-second window to close.
    if (static_cast<double>(bytes) > config_.hardBytesPerSecond) {
        ++refusals_;
        return {false, true, "single message exceeds the hard byte budget"};
    }

    session.bytesIn += bytes;
    session.messagesIn += 1;

    // Hard byte ceiling, measured over a real one-second window. Nothing a
    // legitimate client sends comes close, so exceeding it means abuse rather
    // than a bursty but honest connection.
    if (session.windowStart < 0.0) session.windowStart = nowSeconds;
    const double window = nowSeconds - session.windowStart;
    if (window >= 1.0) {
        const double rate = static_cast<double>(session.bytesIn) / window;
        session.bytesIn = 0;
        session.windowStart = nowSeconds;
        if (rate > config_.hardBytesPerSecond) {
            ++refusals_;
            return {false, true, "exceeded the hard byte rate limit"};
        }
    }

    if (!session.bytes.take(nowSeconds, static_cast<double>(bytes))) {
        ++refusals_;
        ++session.rejected;
        // A sustained breach is a disconnect, not a throttle: a client that
        // keeps pushing after being limited is not going to comply.
        const bool fatal = session.rejected > 32;
        return {false, fatal, fatal ? "sustained bandwidth abuse" : "bandwidth limit exceeded"};
    }

    if (!session.messages.take(nowSeconds)) {
        ++refusals_;
        ++session.rejected;
        const bool fatal = session.rejected > 32;
        return {false, fatal, fatal ? "sustained message flood" : "message rate limit exceeded"};
    }

    return {true, false, ""};
}

RateDecision RateLimiter::onInput(uint64_t sessionId, double nowSeconds) {
    auto it = sessions_.find(sessionId);
    if (it == sessions_.end()) return {false, false, "unknown session"};
    Session& session = it->second;
    if (!session.inputs.take(nowSeconds)) {
        ++refusals_;
        return {false, false, "input rate limit exceeded"};
    }
    return {true, false, ""};
}

}  // namespace neon::security
