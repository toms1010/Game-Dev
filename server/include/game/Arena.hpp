// Neon Vanguard — arena bounds.
//
// The arena is reshaped client-side to match the device aspect while holding
// its area constant; the server is told the resulting size in its
// configuration and uses the same numbers, so both sides clamp identically.

#pragma once

#include <cstdint>

#include "game/Vec.hpp"

namespace neon::game {

class Arena {
public:
    Arena() = default;
    Arena(double width, double height) : width_(width), height_(height) {}

    double width() const { return width_; }
    double height() const { return height_; }
    double area() const { return width_ * height_; }

    void resize(double width, double height) {
        if (width > 0.0) width_ = width;
        if (height > 0.0) height_ = height;
    }

    Vec2 centre() const { return {width_ * 0.5, height_ * 0.5}; }

    /// Clamps a point so a body of `radius` stays fully inside.
    Vec2 clampPoint(const Vec2& p, double radius) const;

    /// A spawn point on the arena rim, spread evenly by `index`/`count` so
    /// players never stack on top of each other at match start.
    Vec2 spawnPoint(uint32_t index, uint32_t count, double inset = 60.0) const;

private:
    double width_ = 960.0;
    double height_ = 600.0;
};

}  // namespace neon::game
