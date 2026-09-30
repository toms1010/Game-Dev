// Neon Vanguard — projectiles.
//
// Fixed-capacity pools with a swap-and-pop sweep. The ceiling is a hard cap:
// when it is reached, spawns are dropped rather than growing the heap, which
// keeps worst-case memory flat no matter what a client does.

#pragma once

#include <cstdint>
#include <vector>

#include "game/Vec.hpp"

namespace neon::game {

struct Projectile {
    Vec2 position;
    Vec2 previous;
    Vec2 velocity;
    double radius = 4.0;
    double life = 1.0;
    double damage = 12.0;
    uint32_t color = 0x7df9ff;
    /// Owner player id; 0 means the environment shot it.
    uint32_t ownerId = 0;
    /// True for enemy fire, which collides with players instead of enemies.
    bool hostile = false;
    bool homing = false;
    bool dead = false;
};

/**
 * A pool of projectiles with swap-and-pop removal.
 *
 * Not thread safe by design: only the game thread touches it. Snapshot
 * serialisation reads it after the tick, on the same thread.
 */
class ProjectilePool {
public:
    explicit ProjectilePool(std::size_t capacity = 1024) : capacity_(capacity) {
        items_.reserve(capacity_);
    }

    /// Returns nullptr when the pool is full.
    Projectile* spawn();
    std::size_t size() const { return items_.size(); }
    bool full() const { return items_.size() >= capacity_; }
    std::size_t capacity() const { return capacity_; }

    /// Iterates the live list, allowing removal during the walk. Never
    /// allocates: `out` is a caller-owned scratch vector.
    template <typename Fn>
    void forEach(Fn&& fn) {
        for (std::size_t i = 0; i < items_.size();) {
            const bool erase = fn(items_[i]);
            if (erase) {
                items_[i] = items_.back();
                items_.pop_back();
            } else {
                ++i;
            }
        }
    }

    void clear() { items_.clear(); }

private:
    std::size_t capacity_;
    std::vector<Projectile> items_;
};

}  // namespace neon::game
