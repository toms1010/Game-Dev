#include "utils/Timer.hpp"

#include <algorithm>
#include <cstdio>
#include <ctime>

namespace neon::utils {

std::string isoTimestamp() {
    using namespace std::chrono;
    const auto now = system_clock::now();
    const auto secs = system_clock::to_time_t(now);
    const auto ms = duration_cast<milliseconds>(now.time_since_epoch()).count() % 1000;
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &secs);
#else
    gmtime_r(&secs, &tm);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    char out[48];
    std::snprintf(out, sizeof(out), "%s.%03dZ", buf, static_cast<int>(ms));
    return out;
}

Ticker::Ticker(double stepSeconds, int maxCatchup)
    : step_(stepSeconds > 0.0 ? stepSeconds : 1.0 / 60.0), maxCatchup_(maxCatchup > 0 ? maxCatchup : 1) {}

void Ticker::reset() {
    accumulator_ = 0.0;
    dropped_ = false;
    load_ = 0.0;
}

int Ticker::advance(double realSeconds) {
    if (!(realSeconds > 0.0)) return 0;

    accumulator_ += realSeconds;
    int steps = static_cast<int>(accumulator_ / step_);
    dropped_ = false;

    if (steps > maxCatchup_) {
        // Behind by more than the catch-up allowance. Simulate what we can and
        // discard the rest: replaying the backlog would guarantee another
        // late frame, and the queue would never drain.
        dropped_ = true;
        load_ = static_cast<double>(maxCatchup_) * step_ / realSeconds;
        steps = maxCatchup_;
        accumulator_ = 0.0;
    } else {
        accumulator_ -= steps * step_;
        load_ = steps * step_ / realSeconds;
    }

    steps_ += static_cast<uint64_t>(steps);
    return steps;
}

void RateMeter::sample(double value) {
    // Exponential moving average, seeded by the first sample so a fresh meter
    // reports something useful immediately.
    if (samples_ == 0) value_ = value;
    else value_ += (value - value_) * 0.1;
    ++samples_;
}

}  // namespace neon::utils
