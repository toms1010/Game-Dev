#include "game/GameState.hpp"

#include <algorithm>
#include <cmath>

#include "utils/Logger.hpp"

namespace neon::game {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = kPi * 2.0;

/// Spawn margin outside the rim, so enemies arrive rather than pop in.
constexpr double kSpawnMargin = 30.0;

double wrapAngle(double a) {
    while (a > kPi) a -= kTwoPi;
    while (a < -kPi) a += kTwoPi;
    return a;
}

}  // namespace

GameState::GameState(uint32_t matchId, Arena arena, GameStateLimits limits)
    : matchId_(matchId),
      arena_(arena),
      limits_(limits),
      enemies_(limits.maxEnemies),
      projectiles_(limits.maxProjectiles) {
    grid_.configure(arena_.width(), arena_.height(), 64.0);
    // Reserve for the worst case so the steady state never allocates.
    queryScratch_.reserve(64);
    shotScratch_.reserve(16);
    level_ = Progression::levelForWave(wave_);
    enemiesRemainingInWave_ = Progression::rosterSize(wave_, level_);
}

Player* GameState::addPlayer(uint32_t id, const std::string& name) {
    if (players_.size() >= limits_.maxPlayers) return nullptr;
    if (Player* existing = findPlayer(id)) return existing;

    auto player = std::make_unique<Player>(id, name);
    const uint32_t index = static_cast<uint32_t>(players_.size());
    player->position() = arena_.spawnPoint(index, static_cast<uint32_t>(limits_.maxPlayers));
    players_.push_back(std::move(player));
    emit("spawn", id, 0.0);
    return players_.back().get();
}

void GameState::removePlayer(uint32_t id) {
    for (auto it = players_.begin(); it != players_.end(); ++it) {
        if ((*it)->id() == id) {
            players_.erase(it);
            break;
        }
    }
    pendingInputs_.erase(id);
    pendingDash_.erase(id);
    pendingBomb_.erase(id);
    respawnAt_.erase(id);
}

Player* GameState::findPlayer(uint32_t id) {
    for (auto& p : players_) {
        if (p->id() == id) return p.get();
    }
    return nullptr;
}

const Player* GameState::findPlayer(uint32_t id) const {
    for (const auto& p : players_) {
        if (p->id() == id) return p.get();
    }
    return nullptr;
}

void GameState::submitInput(uint32_t playerId, const PlayerInput& input) {
    if (!input.valid) return;
    pendingInputs_[playerId] = input;
}

void GameState::requestAbility(uint32_t playerId, AbilityKind kind) {
    if (kind == AbilityKind::Dash) pendingDash_[playerId] = true;
    else pendingBomb_[playerId] = true;
}

int GameState::enemiesRemaining() const {
    return static_cast<int>(enemies_.size()) + std::max(0, enemiesRemainingInWave_);
}

void GameState::damagePlayer(uint32_t playerId, double amount) {
    Player* player = findPlayer(playerId);
    if (player == nullptr) return;
    if (!player->applyDamage(amount, time_)) return;
    emit("hit", playerId, amount);
    if (!player->alive()) handleDeath(*player);
}

void GameState::handleDeath(Player& player) {
    emit("death", player.id(), 0.0);
    respawnAt_[player.id()] = time_ + limits_.respawnDelay;
}

void GameState::tick(double dt) {
    if (finished_) return;
    time_ += dt;
    ++tick_;

    advancePlayers(dt);
    advanceProjectiles(dt);
    advanceEnemies(dt);
    resolveProjectiles();
    resolveContacts();
    advanceProgression(dt);

    enemies_.removeDead();
}

void GameState::advancePlayers(double dt) {
    const uint32_t count = static_cast<uint32_t>(players_.size());

    for (std::size_t slot = 0; slot < players_.size(); ++slot) {
        Player& p = *players_[slot];

        auto respawnIt = respawnAt_.find(p.id());
        if (respawnIt != respawnAt_.end()) {
            if (time_ >= respawnIt->second) {
                p.respawn(arena_.spawnPoint(static_cast<uint32_t>(slot), count), time_);
                respawnAt_.erase(respawnIt);
                emit("spawn", p.id(), 0.0);
            } else {
                continue;  // dead and waiting: nothing to process
            }
        }

        if (!p.alive()) continue;

        // --- abilities ---
        // These are handled before, and independently of, the input sample.
        // A client is entitled to use an ability on a tick where its input
        // packet was lost, and gating them on `pendingInputs_` would silently
        // drop the request.
        auto dashIt = pendingDash_.find(p.id());
        if (dashIt != pendingDash_.end()) {
            if (dashIt->second) {
                p.dash(time_);
                emit("dash", p.id(), 0.0);
            }
            pendingDash_.erase(dashIt);
        }

        auto bombIt = pendingBomb_.find(p.id());
        if (bombIt != pendingBomb_.end()) {
            const bool requested = bombIt->second;
            pendingBomb_.erase(bombIt);
            if (requested && p.bomb(time_)) {
                // The bomb damages every enemy in the arena. The client only
                // ever asked for it; the damage, score and kills below are
                // all computed here.
                emit("bomb", p.id(), 0.0);
                // Snapshot the count: awarding a kill can append splitter
                // children, which would invalidate a range-for iterator and
                // leave the reference dangling.
                const std::size_t enemyCount = enemies_.size();
                for (std::size_t i = 0; i < enemyCount; ++i) {
                    Enemy* enemy = &enemies_.mutableItems()[i];
                    if (enemy->dead) continue;
                    enemy->hp = 0.0;
                    awardKill(p, *enemy);
                }
            }
        }

        auto inputIt = pendingInputs_.find(p.id());
        if (inputIt == pendingInputs_.end()) continue;
        const PlayerInput& input = inputIt->second;
        p.setInput(input);
        p.setLastInputSeq(input.sequence);

        // --- aim: rotate toward the requested point at a capped rate ---
        const Vec2 aim = input.aim;
        if (lengthSq(aim) > 1e-6) {
            const Vec2 delta = aim - p.position();
            if (lengthSq(delta) > 1e-6) {
                const double want = std::atan2(delta.y, delta.x);
                const double diff = wrapAngle(want - p.angle());
                p.setAngle(p.angle() + diff * std::min(1.0, dt * 26.0));
            }
        }

        // --- movement: the one and only integrator ---
        const double maxSpeed = 420.0;
        integrateMovement(p.position(), p.velocity(), p.radius(), input.move.x, input.move.y, dt,
                          arena_.width(), arena_.height(), maxSpeed);

        // --- firing: rate limited by the server's own cooldown ---
        if (input.firing && p.canFire(time_)) {
            p.onFired(time_);
            const WeaponType weapon = p.weapon();
            buildShotPattern(weapon, p.fireRateLevel(), p.damageLevel(), p.bulletSpeedLevel(),
                             p.powerLevel(), p.position(), p.angle(), shotScratch_);
            for (const Shot& shot : shotScratch_) {
                Projectile* projectile = projectiles_.spawn();
                if (projectile == nullptr) break;  // pool full: drop, never grow
                projectile->position = shot.position;
                projectile->previous = shot.position;
                projectile->velocity = shot.velocity;
                projectile->radius = shot.radius;
                projectile->life = shot.life;
                projectile->damage = shot.damage;
                projectile->color = shot.color;
                projectile->hostile = false;
                projectile->homing = shot.homing;
                projectile->ownerId = p.id();
                projectile->dead = false;
            }
        }
    }
}

void GameState::advanceProjectiles(double dt) {
    projectiles_.forEach([&](Projectile& b) {
        b.previous = b.position;

        // Seekers steer toward the nearest enemy through the spatial hash, so
        // the cost tracks local density rather than the total enemy count.
        if (b.homing && !b.hostile) {
            grid_.query(b.position, 420.0, queryScratch_);
            Enemy* target = nullptr;
            double bestSq = 420.0 * 420.0;
            for (int slot : queryScratch_) {
                Enemy* e = enemies_.find(static_cast<uint32_t>(slot));
                if (e == nullptr || e->dead) continue;
                const double dx = e->position.x - b.position.x;
                const double dy = e->position.y - b.position.y;
                const double dSq = dx * dx + dy * dy;
                if (dSq < bestSq) {
                    bestSq = dSq;
                    target = e;
                }
            }
            if (target != nullptr) {
                const double spd = length(b.velocity);
                const double want = std::atan2(target->position.y - b.position.y,
                                               target->position.x - b.position.x);
                const double cur = std::atan2(b.velocity.y, b.velocity.x);
                const double na = cur + wrapAngle(want - cur) * std::min(1.0, 4.5 * dt);
                b.velocity = {std::cos(na) * spd, std::sin(na) * spd};
            }
        }

        b.position += b.velocity * dt;
        b.life -= dt;

        if (b.life <= 0.0) return true;
        if (b.position.x < -40.0 || b.position.x > arena_.width() + 40.0) return true;
        if (b.position.y < -40.0 || b.position.y > arena_.height() + 40.0) return true;
        return false;
    });
}

void GameState::advanceEnemies(double dt) {
    for (Enemy& e : enemies_.mutableItems()) {
        e.age += dt;
        e.spawnProgress = std::min(1.0, e.spawnProgress + dt * 3.0);
        e.angle += dt * 2.0;
        if (e.hitFlash > 0.0) e.hitFlash -= dt;

        // Chase the nearest living player; with several players around, the
        // nearest is the one creating the most pressure.
        Player* target = nullptr;
        double bestSq = 1e18;
        for (auto& p : players_) {
            if (!p->alive()) continue;
            const double dx = p->position().x - e.position.x;
            const double dy = p->position().y - e.position.y;
            const double dSq = dx * dx + dy * dy;
            if (dSq < bestSq) {
                bestSq = dSq;
                target = p.get();
            }
        }
        if (target == nullptr) continue;

        const Vec2 toTarget = target->position() - e.position;
        const double dist = std::max(1e-6, length(toTarget));
        const EnemyConfig& cfg = enemyConfig(e.kind);
        const double speed = (cfg.speed + wave_ * 3.0) * (1.0 + (e.level - 1) * 0.08);
        const bool ranged = e.kind == EnemyKind::Shooter || e.kind == EnemyKind::Healer;

        Vec2 desired{0.0, 0.0};
        if (ranged && dist < 330.0) {
            desired = {-toTarget.x / dist * speed, -toTarget.y / dist * speed};
        } else {
            desired = {toTarget.x / dist * speed, toTarget.y / dist * speed};
        }

        // Steer towards the desired velocity rather than snapping, which keeps
        // motion readable when a target changes direction.
        e.velocity.x += (desired.x - e.velocity.x) * std::min(1.0, dt * 4.0);
        e.velocity.y += (desired.y - e.velocity.y) * std::min(1.0, dt * 4.0);
        e.position += e.velocity * dt;
        e.angle = e.kind == EnemyKind::Rusher ? std::atan2(e.velocity.y, e.velocity.x) : e.angle;

        // --- archetype attacks ---
        e.attackCooldown -= dt;
        if (e.attackCooldown > 0.0) continue;

        if (e.kind == EnemyKind::Shooter) {
            e.attackCooldown = std::max(0.9, 1.6 - e.level * 0.1);
            const int shots = e.level >= 3 ? 5 : 3;
            const double base = std::atan2(toTarget.y, toTarget.x);
            for (int i = 0; i < shots; ++i) {
                const double a = base + (i - (shots - 1) / 2.0) * 0.18;
                if (Projectile* p = projectiles_.spawn()) {
                    p->position = e.position;
                    p->previous = e.position;
                    p->velocity = {std::cos(a) * 320.0, std::sin(a) * 320.0};
                    p->radius = 5.0;
                    p->life = 3.0;
                    p->damage = 10.0;
                    p->color = 0xc084fc;
                    p->hostile = true;
                    p->homing = false;
                    p->ownerId = 0;
                    p->dead = false;
                }
            }
        } else if (e.kind == EnemyKind::Healer) {
            e.attackCooldown = 2.0;
            for (Enemy& other : enemies_.mutableItems()) {
                if (other.dead || other.id == e.id) continue;
                if (lengthSq(other.position - e.position) < 140.0 * 140.0 &&
                    other.hp < other.maxHp) {
                    other.hp = std::min(other.maxHp, other.hp + other.maxHp * 0.25);
                }
            }
        } else if (e.kind == EnemyKind::Boss) {
            // Boss alternates a dense ring with an aimed shotgun spread.
            e.attackCooldown = std::max(0.8, 1.6 - e.level * 0.1);
            const int ring = 16 + e.level * 4;
            for (int i = 0; i < ring; ++i) {
                const double a = (static_cast<double>(i) / ring) * kTwoPi + e.age;
                if (Projectile* p = projectiles_.spawn()) {
                    p->position = e.position;
                    p->previous = e.position;
                    p->velocity = {std::cos(a) * 260.0, std::sin(a) * 260.0};
                    p->radius = 6.0;
                    p->life = 4.0;
                    p->damage = 12.0;
                    p->color = 0xc084fc;
                    p->hostile = true;
                    p->homing = false;
                    p->ownerId = 0;
                    p->dead = false;
                }
            }
            const double base = std::atan2(toTarget.y, toTarget.x);
            for (int i = -2; i <= 2; ++i) {
                const double a = base + i * 0.15;
                if (Projectile* p = projectiles_.spawn()) {
                    p->position = e.position;
                    p->previous = e.position;
                    p->velocity = {std::cos(a) * 380.0, std::sin(a) * 380.0};
                    p->radius = 7.0;
                    p->life = 3.0;
                    p->damage = 18.0;
                    p->color = 0xf43f5e;
                    p->hostile = true;
                    p->homing = false;
                    p->ownerId = 0;
                    p->dead = false;
                }
            }
        } else {
            // Contact archetypes attack on contact, not on a timer.
            e.attackCooldown = 1.0;
        }
    }
}

void GameState::resolveProjectiles() {
    // Rebuild the broad phase once per tick. Clearing and refilling is
    // cheaper than incremental bookkeeping at these entity counts.
    grid_.clear();
    for (const Enemy& e : enemies_.items()) {
        if (!e.dead) grid_.insert(static_cast<int>(e.id), e.position, e.radius);
    }

    projectiles_.forEach([&](Projectile& b) {
        if (b.hostile) {
            for (auto& p : players_) {
                if (!p->alive()) continue;
                if (segmentIntersectsCircle(b.previous, b.position, p->position(),
                                            b.radius + p->radius())) {
                    // Server-authoritative damage: the client's claim is never
                    // read, only this call writes hp.
                    damagePlayer(p->id(), b.damage);
                    return true;
                }
            }
            return false;
        }

        grid_.query(b.position, b.radius + 30.0, queryScratch_);
        for (int slot : queryScratch_) {
            Enemy* e = enemies_.find(static_cast<uint32_t>(slot));
            if (e == nullptr || e->dead) continue;
            if (!segmentIntersectsCircle(b.previous, b.position, e->position, b.radius + e->radius)) {
                continue;
            }
            e->hp -= b.damage;
            e->hitFlash = 0.12;
            Player* shooter = findPlayer(b.ownerId);
            if (e->hp <= 0.0 && shooter != nullptr) {
                awardKill(*shooter, *e);
            }
            return true;  // one hit per projectile
        }
        return false;
    });
}

void GameState::resolveContacts() {
    for (Enemy& e : enemies_.mutableItems()) {
        if (e.dead) continue;
        for (auto& p : players_) {
            if (!p->alive()) continue;
            if (circlesOverlap(e.position, e.radius, p->position(), p->radius())) {
                damagePlayer(p->id(), enemyConfig(e.kind).damage);
                // Knock the enemy back so it does not grind the player down
                // every frame while overlapping.
                const Vec2 push = normalized(e.position - p->position(), {1.0, 0.0});
                e.velocity = push * 260.0;
            }
        }
    }
}

void GameState::awardKill(Player& shooter, Enemy& enemy) {
    if (enemy.dead) return;
    enemy.dead = true;

    const int64_t gain = static_cast<int64_t>(std::round(enemyConfig(enemy.kind).score *
                                                         (1.0 + (enemy.level - 1) * 0.25)));
    shooter.addScore(gain);
    shooter.addKill();
    emit("kill", enemy.id, static_cast<double>(gain));

    // Splitters leave two half-size children that do not split again and are
    // not counted in the wave roster.
    if (enemy.kind == EnemyKind::Splitter && !enemy.mini) {
        for (int i = 0; i < 2; ++i) {
            Enemy* child = enemies_.spawn(EnemyKind::Splitter, enemy.position, enemy.level);
            if (child == nullptr) break;
            child->mini = true;
            child->radius *= 0.6;
            child->hp = child->maxHp * 0.45;
            child->spawnProgress = 0.5;
        }
    }
}

void GameState::advanceProgression(double dt) {
    if (finished_) return;

    // A roster is only "cleared" when the spawn queue is empty *and* nothing
    // is left alive. Both conditions matter: a splitter that split after the
    // last roster enemy died would otherwise end the wave early.
    if (!spawningFinished_ && enemiesRemainingInWave_ > 0) {
        if (enemies_.size() >= limits_.maxEnemies) return;  // defer, never drop
        spawnTimer_ -= dt;
        if (spawnTimer_ > 0.0) return;
        spawnTimer_ = std::max(0.28, 1.25 - wave_ * 0.08 - (level_ - 1) * 0.05);
        spawnWaveEnemy();
        return;
    }

    if (!enemies_.items().empty()) return;

    emit("wave", 0, static_cast<double>(wave_));
    ++wave_;
    level_ = Progression::levelForWave(wave_);
    spawningFinished_ = false;
    spawnTimer_ = 0.6;
    enemiesRemainingInWave_ = Progression::isBossWave(wave_, level_)
                                 ? 1
                                 : Progression::rosterSize(wave_, level_);
}

void GameState::spawnWaveEnemy() {
    if (enemiesRemainingInWave_ <= 0) {
        spawningFinished_ = true;
        return;
    }

    const bool bossWave = Progression::isBossWave(wave_, level_);
    if (bossWave) {
        if (Enemy* boss = enemies_.spawn(EnemyKind::Boss, {arena_.width() * 0.5, -60.0}, level_)) {
            boss->radius = enemyConfig(EnemyKind::Boss).radius;
        }
        --enemiesRemainingInWave_;
        if (enemiesRemainingInWave_ <= 0) spawningFinished_ = true;
        return;
    }

    // Spawn on a random edge, tier chosen by the same thresholds as the
    // offline campaign so a networked wave feels familiar.
    const int side = static_cast<int>(std::rand() % 4);
    const double w = arena_.width();
    const double h = arena_.height();
    double x = 0.0, y = 0.0;
    switch (side) {
        case 0: x = static_cast<double>(std::rand() % 1000) / 1000.0 * w; y = -kSpawnMargin; break;
        case 1: x = w + kSpawnMargin; y = static_cast<double>(std::rand() % 1000) / 1000.0 * h; break;
        case 2: x = static_cast<double>(std::rand() % 1000) / 1000.0 * w; y = h + kSpawnMargin; break;
        default: x = -kSpawnMargin; y = static_cast<double>(std::rand() % 1000) / 1000.0 * h; break;
    }

    const double roll = static_cast<double>(std::rand()) / static_cast<double>(RAND_MAX);
    const double lv = static_cast<double>(level_ - 1);
    const double tankOdds = std::max(0.955, 0.97 - lv * 0.006);
    const double healerOdds = std::max(0.905, 0.945 - lv * 0.008);
    const double shooterOdds = std::max(0.84, 0.90 - lv * 0.012);
    const double splitterOdds = std::max(0.74, 0.84 - lv * 0.02);
    const double rusherOdds = std::max(0.6, 0.72 - lv * 0.024);

    EnemyKind kind = EnemyKind::Grunt;
    if (wave_ > 6 && roll > tankOdds) kind = EnemyKind::Tank;
    else if (wave_ > 5 && roll > healerOdds) kind = EnemyKind::Healer;
    else if (wave_ > 4 && roll > shooterOdds) kind = EnemyKind::Shooter;
    else if (wave_ > 3 && roll > splitterOdds) kind = EnemyKind::Splitter;
    else if (wave_ > 2 && roll > rusherOdds) kind = EnemyKind::Rusher;

    if (enemies_.spawn(kind, {x, y}, level_) == nullptr) return;  // full: retry next tick
    --enemiesRemainingInWave_;
    if (enemiesRemainingInWave_ <= 0) spawningFinished_ = true;
}

void GameState::finish() {
    if (finished_) return;
    finished_ = true;

    if (onResult_) {
        for (const auto& p : players_) {
            RunResult result;
            result.playerId = p->id();
            result.playerName = p->name();
            result.score = p->score();
            result.kills = p->kills();
            result.deaths = p->deaths();
            result.wavesCleared = std::max(0, wave_ - 1);
            result.seconds = time_;
            result.survived = p->alive();
            onResult_(result);
        }
    }
    emit("match_end", 0, static_cast<double>(wave_));
}

void GameState::emit(const std::string& kind, uint32_t id, double value) {
    if (onEvent_) onEvent_(kind, id, value);
}

}  // namespace neon::game
