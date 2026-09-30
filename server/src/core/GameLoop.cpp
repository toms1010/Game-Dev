#include "core/GameLoop.hpp"

#include <algorithm>

namespace neon::core {

GameLoop::GameLoop(const Config& config, TickFn onTick, SnapshotFn onSnapshot)
    : config_(config),
      onTick_(std::move(onTick)),
      onSnapshot_(std::move(onSnapshot)),
      ticker_(config.stepSeconds, config.maxCatchupTicks) {
    if (config_.snapshotHz < 1) config_.snapshotHz = 1;
    // A snapshot rate above the tick rate would just duplicate frames.
    const double implied = 1.0 / std::max(1e-6, config_.stepSeconds);
    if (static_cast<double>(config_.snapshotHz) > implied) {
        config_.snapshotHz = static_cast<int>(implied);
    }
}

int GameLoop::advance(double realSeconds) {
    const int steps = ticker_.advance(realSeconds);
    for (int i = 0; i < steps; ++i) {
        onTick_(ticker_.step(), tick_);
        ++tick_;
    }
    if (steps > 0) tickRateMeter_.sample(static_cast<double>(steps) / std::max(1e-6, realSeconds));

    snapshotAccumulator_ += realSeconds;
    const double interval = 1.0 / static_cast<double>(config_.snapshotHz);
    // Emit at most one snapshot per call, so a long stall cannot produce a
    // burst of catch-up frames.
    if (snapshotAccumulator_ >= interval) {
        snapshotAccumulator_ = 0.0;
        if (onSnapshot_) {
            onSnapshot_(tick_);
            ++snapshots_;
        }
    }
    return steps;
}

}  // namespace neon::core
