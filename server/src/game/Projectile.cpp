#include "game/Projectile.hpp"

namespace neon::game {

Projectile* ProjectilePool::spawn() {
    if (items_.size() >= capacity_) return nullptr;  // drop rather than grow
    items_.emplace_back();
    return &items_.back();
}

}  // namespace neon::game
