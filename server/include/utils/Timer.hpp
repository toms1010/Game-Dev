// Neon Vanguard — timing utilities.
//
// The game loop must run a *fixed* timestep. `Ticker` accumulates real elapsed
// time and hands back whole simulation steps, so gameplay is frame-rate
// independent while wall-clock drift is still corrected.

#pragma once

#include <chrono>
#include <cstdint>
#include <string>

namespace neon::utils {

using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;
using Duration = std::chrono::duration<double>;

inline double secondsBetween(TimePoint a, TimePoint b) {
    return std::chrono::duration<double>(b - a).count();
}

inline uint64_t nowMillis() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count());
}

/// RFC3339-ish UTC timestamp for log lines and match records.
std::string isoTimestamp();

/**
 * Fixed-step accumulator.
 *
 * Feed it real elapsed seconds; it returns how many simulation steps are due.
 * If the process is suspended or a tick overruns badly, the surplus is
 * discarded (up to `maxCatchup`) rather than simulated, otherwise the loop
 * spends forever catching up and the server becomes unresponsive — the
 * classic spiral of death.
 */
class Ticker {
public:
    Ticker(double stepSeconds = 1.0 / 60.0, int maxCatchup = 5);

    void reset();

    /// Adds elapsed real time and returns the number of steps to run.
    int advance(double realSeconds);

    /// True when the previous advance had to drop time.
    bool droppedTime() const { return dropped_; }

    /// Fraction of the previous period actually simulated, for monitoring.
    double loadFactor() const { return load_; }

    double step() const { return step_; }
    uint64_t stepCount() const { return steps_; }

private:
    double step_ = 1.0 / 60.0;
    int maxCatchup_ = 5;
    double accumulator_ = 0.0;
    uint64_t steps_ = 0;
    bool dropped_ = false;
    double load_ = 0.0;
};

/**
 * Exponentially smoothed rate meter, used for tick rate, entity count and
 * message rate reporting. A raw per-second counter is too jumpy to read.
 */
class RateMeter {
public:
    /// Folds a new sample in with a smoothing factor.
    void sample(double value);

    /// Sets the value outright, for callers that measure over their own
    /// window (the game loop counts ticks per second rather than per wake).
    void set(double value) { value_ = value; }
    void addSamples(uint64_t n) { samples_ += n; }

    double value() const { return value_; }
    uint64_t count() const { return samples_; }

private:
    double value_ = 0.0;
    uint64_t samples_ = 0;
    double elapsed_ = 0.0;
};

}  // namespace neon::utils
