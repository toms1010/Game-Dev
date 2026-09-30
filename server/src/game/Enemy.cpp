#include "game/Enemy.hpp"

#include <algorithm>
#include <unordered_map>

namespace neon::game {

namespace {

// Mirrors ENEMY_CONFIG in src/game/engine.ts.
constexpr EnemyConfig kGrunt{15.0, 20.0, 95.0, 12.0, 100, 0xff4d6d};
constexpr EnemyConfig kRusher{11.0, 14.0, 205.0, 12.0, 150, 0xffd166};
constexpr EnemyConfig kTank{26.0, 90.0, 55.0, 22.0, 500, 0x22d3ee};
constexpr EnemyConfig kShooter{17.0, 30.0, 75.0, 10.0, 250, 0x8b5cf6};
constexpr EnemyConfig kSplitter{16.0, 24.0, 100.0, 12.0, 180, 0xfb7185};
constexpr EnemyConfig kHealer{14.0, 22.0, 80.0, 12.0, 220, 0x4ade80};
constexpr EnemyConfig kBoss{48.0, 1200.0, 35.0, 30.0, 5000, 0xa855f7};

}  // namespace

const EnemyConfig& enemyConfig(EnemyKind kind) {
    switch (kind) {
        case EnemyKind::Rusher: return kRusher;
        case EnemyKind::Tank: return kTank;
        case EnemyKind::Shooter: return kShooter;
        case EnemyKind::Splitter: return kSplitter;
        case EnemyKind::Healer: return kHealer;
        case EnemyKind::Boss: return kBoss;
        case EnemyKind::Grunt:
        default: return kGrunt;
    }
}

const char* enemyName(EnemyKind kind) {
    switch (kind) {
        case EnemyKind::Rusher: return "rusher";
        case EnemyKind::Tank: return "tank";
        case EnemyKind::Shooter: return "shooter";
        case EnemyKind::Splitter: return "splitter";
        case EnemyKind::Healer: return "healer";
        case EnemyKind::Boss: return "boss";
        case EnemyKind::Grunt:
        default: return "grunt";
    }
}

EnemyKind enemyFromName(const std::string& name) {
    if (name == "rusher") return EnemyKind::Rusher;
    if (name == "tank") return EnemyKind::Tank;
    if (name == "shooter") return EnemyKind::Shooter;
    if (name == "splitter") return EnemyKind::Splitter;
    if (name == "healer") return EnemyKind::Healer;
    if (name == "boss") return EnemyKind::Boss;
    return EnemyKind::Grunt;
}

Enemy* EnemyField::spawn(EnemyKind kind, const Vec2& position, int level) {
    if (items_.size() >= capacity_) return nullptr;

    const EnemyConfig& cfg = enemyConfig(kind);
    const double levelMult = 1.0 + (level - 1) * 0.4;
    const double hp = kind == EnemyKind::Boss
                          ? std::round(cfg.hp * (1.0 + (level - 5) * 0.5))
                          : std::round(cfg.hp * levelMult * (1.0 + (level - 1) * 0.1));

    Enemy e;
    e.id = nextId();
    e.kind = kind;
    e.position = position;
    e.velocity = {0.0, 0.0};
    e.radius = cfg.radius + (level - 1);
    e.hp = hp;
    e.maxHp = hp;
    e.angle = 0.0;
    e.attackCooldown = 1.0 + static_cast<double>(kind) * 0.2;
    e.level = level;
    e.age = 0.0;
    e.spawnProgress = 0.0;
    e.dead = false;

    items_.push_back(e);
    index_[e.id] = items_.size() - 1;
    return &items_.back();
}

Enemy* EnemyField::find(uint32_t id) {
    auto it = index_.find(id);
    if (it == index_.end()) return nullptr;
    if (it->second >= items_.size()) return nullptr;
    Enemy& e = items_[it->second];
    return e.dead ? nullptr : &e;
}

void EnemyField::removeDead() {
    // Swap-and-pop: order is irrelevant to AI, collision and rendering, and
    // this avoids a per-tick allocation from std::remove_if.
    for (std::size_t i = 0; i < items_.size();) {
        if (items_[i].dead) {
            items_[i] = items_.back();
            items_.pop_back();
        } else {
            ++i;
        }
    }
    index_.clear();
    for (std::size_t i = 0; i < items_.size(); ++i) index_[items_[i].id] = i;
}

void EnemyField::clear() {
    items_.clear();
    index_.clear();
}

}  // namespace neon::game
