#include "game/Arena.hpp"

#include <cmath>

namespace neon::game {

Vec2 Arena::clampPoint(const Vec2& p, double radius) const {
    return {clampd(p.x, radius, width_ - radius), clampd(p.y, radius, height_ - radius)};
}

Vec2 Arena::spawnPoint(uint32_t index, uint32_t count, double inset) const {
    if (count == 0) return centre();
    // Distribute spawns around the rim so players never start stacked, and
    // offset by a quarter turn so the first spawn is never dead centre.
    const double fraction = (static_cast<double>(index) + 0.5) / static_cast<double>(count);
    const double angle = fraction * 6.283185307179586 + 1.5707963267948966;
    const double halfW = std::max(0.0, width_ * 0.5 - inset);
    const double halfH = std::max(0.0, height_ * 0.5 - inset);
    return {width_ * 0.5 + std::cos(angle) * halfW, height_ * 0.5 + std::sin(angle) * halfH};
}

}  // namespace neon::game
