// Neon Vanguard — enemies.
//
// The server owns the enemy field. Clients receive positions and health in
// snapshots and render them; they never spawn, damage or kill an enemy.

#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "game/Vec.hpp"

namespace neon::game {

/// Archetype ids must match `ENEMY_KINDS` in `src/network/protocol.ts`.
enum class EnemyKind : uint8_t {
    Grunt = 0, Rusher, Tank, Shooter, Splitter, Healer, Boss, Count
};

struct EnemyConfig {
    double radius;
    double hp;
    double speed;
    double damage;
    int64_t score;
    uint32_t color;
};

const EnemyConfig& enemyConfig(EnemyKind kind);
const char* enemyName(EnemyKind kind);
/// Parses an archetype name; falls back to Grunt.
EnemyKind enemyFromName(const std::string& name);

struct Enemy {
    uint32_t id = 0;
    EnemyKind kind = EnemyKind::Grunt;
    Vec2 position;
    Vec2 velocity;
    double radius = 15.0;
    double hp = 20.0;
    double maxHp = 20.0;
    double angle = 0.0;
    double attackCooldown = 0.0;
    double hitFlash = 0.0;
    double age = 0.0;
    int level = 1;
    /// Spawn animation scale, 0..1, so arrivals read as arrivals.
    double spawnProgress = 0.0;
    /// Splitter children: half size, and they do not split again.
    bool mini = false;
    bool dead = false;
};

/**
 * The enemy population for one match.
 *
 * Pooled and capped: a wave roster beyond `capacity` is deferred to the next
 * spawn window rather than dropped, so the entity budget is respected without
 * changing what the player has to clear.
 */
class EnemyField {
public:
    explicit EnemyField(std::size_t capacity = 256) : capacity_(capacity) {
        items_.reserve(capacity_);
        index_.reserve(capacity_);
    }

    std::size_t size() const { return items_.size(); }
    std::size_t capacity() const { return capacity_; }
    bool full() const { return items_.size() >= capacity_; }
    const std::vector<Enemy>& items() const { return items_; }
    /// Mutable view, for the simulation only. Never exposed to a snapshot.
    std::vector<Enemy>& mutableItems() { return items_; }

    Enemy* spawn(EnemyKind kind, const Vec2& position, int level);
    /// O(1) lookup by id. The index is rebuilt by `removeDead()`, which the
    /// game loop calls once per tick, so a linear scan never enters the hot
    /// path.
    Enemy* find(uint32_t id);
    void removeDead();
    void clear();

    /// Frees ids for reuse; monotonic so clients can distinguish respawns.
    uint32_t nextId() { return ++nextId_; }

private:
    std::size_t capacity_;
    uint32_t nextId_ = 0;
    std::vector<Enemy> items_;
    /// id -> slot in `items_`, rebuilt on removal. Iteration order of the map
    /// is irrelevant; only lookups go through it.
    std::unordered_map<uint32_t, std::size_t> index_;
};

}  // namespace neon::game
