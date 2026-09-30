// Neon Vanguard — fixed-rate game loop.
//
// Runs the simulation at a constant rate regardless of how the transport or
// the OS is behaving. Real elapsed time is accumulated by `Ticker`; whole
// steps are run until the accumulator drains, then the next snapshot is due.
//
// If a step overruns badly the surplus time is dropped rather than simulated.
// Catching up would mean running more simulation while already behind, which
// only makes the next frame later — the spiral of death. Dropping time is
// visible as a brief slowdown; a spiral is visible as a dead server.

#pragma once

#include <cstdint>
#include <functional>

#include "utils/Timer.hpp"

namespace neon::core {

class GameLoop {
public:
    struct Config {
        double stepSeconds = 1.0 / 60.0;
        int maxCatchupTicks = 5;
        /// Snapshot broadcast rate, Hz. Clamped to the tick rate.
        int snapshotHz = 20;
    };

    using TickFn = std::function<void(double dt, uint64_t tick)>;
    using SnapshotFn = std::function<void(uint64_t tick)>;

    GameLoop(const Config& config, TickFn onTick, SnapshotFn onSnapshot);

    /// Advances the loop. `realSeconds` is measured wall-clock since the
    /// previous call. Returns how many simulation steps ran.
    int advance(double realSeconds);

    uint64_t tick() const { return tick_; }
    double tickRate() const { return tickRateMeter_.value(); }
    double load() const { return ticker_.loadFactor(); }
    bool droppedTime() const { return ticker_.droppedTime(); }
    uint64_t snapshots() const { return snapshots_; }

private:
    Config config_;
    TickFn onTick_;
    SnapshotFn onSnapshot_;
    utils::Ticker ticker_;
    utils::RateMeter tickRateMeter_;
    double snapshotAccumulator_ = 0.0;
    uint64_t tick_ = 0;
    uint64_t snapshots_ = 0;
};

}  // namespace neon::core
