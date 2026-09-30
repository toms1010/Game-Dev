// Neon Vanguard — per-connection rate limiting.
//
// A token bucket per connection, checked on the game thread. Two budgets are
// tracked: message count and inbound bytes. A client that stays under the
// sustained rate but is clearly abusive (a huge burst, or a stream far above
// anything a real client sends) is disconnected rather than merely throttled,
// because nothing legitimate looks like that.

#pragma once

#include <cstdint>
#include <deque>
#include <string>
#include <unordered_map>

namespace neon::security {

class TokenBucket {
public:
    TokenBucket(double ratePerSecond, double burst)
        : rate_(ratePerSecond > 0.0 ? ratePerSecond : 1.0),
          capacity_(burst > 0.0 ? burst : 1.0),
          tokens_(capacity_) {}

    /// Consumes one token. False means the bucket is empty.
    bool take(double nowSeconds, double amount = 1.0) {
        refill(nowSeconds);
        if (tokens_ < amount) return false;
        tokens_ -= amount;
        return true;
    }

    /// Adds tokens directly, for a byte-counted budget.
    void addBack(double amount) { tokens_ += amount; }

    void refill(double nowSeconds) {
        // The first call only seeds the clock: a bucket must not hand out a
        // full burst *and* a full window's worth of tokens. -1 is the "never
        // used" sentinel — 0.0 is a perfectly valid first timestamp.
        if (last_ < 0.0) {
            last_ = nowSeconds;
            return;
        }
        if (nowSeconds <= last_) return;
        tokens_ = std::min(capacity_, tokens_ + (nowSeconds - last_) * rate_);
        last_ = nowSeconds;
    }

    double available() { return tokens_; }
    double capacity() const { return capacity_; }

private:
    double rate_;
    double capacity_;
    double tokens_;
    double last_ = -1.0;
};

struct RateDecision {
    bool allow = true;
    bool disconnect = false;
    const char* reason = "";
};

/**
 * Rate limits every connected session.
 *
 * Owned by the game thread; the counters are not synchronised because there
 * is only ever one thread reading and writing them.
 */
class RateLimiter {
public:
    struct Config {
        double messagesPerSecond = 120.0;
        double messageBurst = 240.0;
        double bytesPerSecond = 65536.0;
        double byteBurst = 131072.0;
        double hardBytesPerSecond = 262144.0;
        double inputsPerSecond = 90.0;
    };

    explicit RateLimiter(const Config& config);

    /// Registers a session with a full budget.
    void attach(uint64_t sessionId);
    void detach(uint64_t sessionId);

    /// Accounts for one inbound message of `bytes` size.
    RateDecision onMessage(uint64_t sessionId, std::size_t bytes, double nowSeconds);

    /// Separate, tighter budget for input samples specifically.
    RateDecision onInput(uint64_t sessionId, double nowSeconds);

    /// Total refusals since boot, for the health endpoint.
    uint64_t refusals() const { return refusals_; }
    std::size_t trackedSessions() const { return sessions_.size(); }

private:
    struct Session {
        TokenBucket messages;
        TokenBucket bytes;
        TokenBucket inputs;
        /// Rolling counters for the hard byte-rate window.
        uint64_t bytesIn = 0;
        uint64_t messagesIn = 0;
        double windowStart = -1.0;
        uint64_t rejected = 0;
        Session(const Config& c)
            : messages(c.messagesPerSecond, c.messageBurst),
              bytes(c.bytesPerSecond, c.byteBurst),
              inputs(c.inputsPerSecond, c.inputsPerSecond * 2.0) {}
    };

    Config config_;
    std::unordered_map<uint64_t, Session> sessions_;
    uint64_t refusals_ = 0;
};

}  // namespace neon::security
