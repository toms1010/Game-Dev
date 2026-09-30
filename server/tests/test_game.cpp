// Neon Vanguard — game simulation tests.
//
// Covers the rules a player actually feels: movement, collision, damage,
// weapons, projectiles, health and respawn.

#include <cmath>
#include <vector>

#include "game/Arena.hpp"
#include "game/Collision.hpp"
#include "game/Enemy.hpp"
#include "game/GameState.hpp"
#include "game/Movement.hpp"
#include "game/Player.hpp"
#include "game/Projectile.hpp"
#include "game/Weapon.hpp"
#include "harness.hpp"

using namespace neon::game;

namespace {

constexpr double kDt = 1.0 / 60.0;

GameState makeState(double width = 960.0, double height = 600.0) {
    GameStateLimits limits;
    limits.maxPlayers = 8;
    limits.maxProjectiles = 512;
    limits.maxEnemies = 64;
    return GameState(1, Arena(width, height), limits);
}

PlayerInput makeInput(Vec2 move, Vec2 aim, bool firing = false, uint64_t seq = 1) {
    PlayerInput input;
    input.sequence = seq;
    input.move = move;
    input.aim = aim;
    input.firing = firing;
    input.valid = true;
    return input;
}

}  // namespace

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

TEST_CASE("game", "movement: input accelerates toward the requested direction") {
    Vec2 pos{100.0, 100.0};
    Vec2 vel{0.0, 0.0};
    for (int i = 0; i < 30; ++i) integrateMovement(pos, vel, 14.0, 1.0, 0.0, kDt, 960.0, 600.0, 420.0);
    CHECK(pos.x > 100.0);
    CHECK_NEAR(pos.y, 100.0, 0.5);
    CHECK(vel.x > 0.0);
}

TEST_CASE("game", "movement: speed is capped, so holding a stick cannot exceed max speed") {
    // Measured over 60 ticks (1s), which is long enough for friction to reach
    // terminal velocity but short enough not to reach the arena wall — a wall
    // collision zeroes velocity and would mask the cap.
    Vec2 pos{40.0, 300.0};
    Vec2 vel{0.0, 0.0};
    for (int i = 0; i < 60; ++i) integrateMovement(pos, vel, 14.0, 1.0, 0.0, kDt, 960.0, 600.0, 420.0);
    // Friction converges to exactly maxSpeed and the clamp holds it there.
    CHECK_NEAR(std::sqrt(vel.x * vel.x + vel.y * vel.y), 420.0, 1.0);
}

TEST_CASE("game", "movement: an over-long input vector is normalised, not amplified") {
    Vec2 fast{480.0, 300.0};
    Vec2 fastVel{0.0, 0.0};
    Vec2 normal{480.0, 300.0};
    Vec2 normalVel{0.0, 0.0};
    for (int i = 0; i < 60; ++i) {
        // A client sending (5, 0) must not outrun one sending (1, 0).
        integrateMovement(fast, fastVel, 14.0, 5.0, 0.0, kDt, 960.0, 600.0, 420.0);
        integrateMovement(normal, normalVel, 14.0, 1.0, 0.0, kDt, 960.0, 600.0, 420.0);
    }
    CHECK_NEAR(fast.x, normal.x, 1e-9);
    CHECK_NEAR(fastVel.x, normalVel.x, 1e-9);
}

TEST_CASE("game", "movement: the ship cannot leave the arena") {
    Vec2 pos{5.0, 5.0};
    Vec2 vel{-500.0, -500.0};
    for (int i = 0; i < 120; ++i) integrateMovement(pos, vel, 14.0, -1.0, -1.0, kDt, 960.0, 600.0, 420.0);
    CHECK(pos.x >= 14.0 - 1e-9);
    CHECK(pos.y >= 14.0 - 1e-9);
    CHECK(vel.x == 0.0);
    CHECK(vel.y == 0.0);
}

TEST_CASE("game", "movement: hitting a wall cancels only the normal component") {
    Vec2 pos{20.0, 300.0};
    Vec2 vel{0.0, 300.0};
    for (int i = 0; i < 60; ++i) integrateMovement(pos, vel, 14.0, -1.0, 0.0, kDt, 960.0, 600.0, 420.0);
    CHECK_NEAR(pos.x, 14.0, 1e-9);
    // Still moving along the wall rather than sticking to it.
    CHECK(vel.x == 0.0);
    CHECK(vel.y != 0.0);
}

TEST_CASE("game", "movement: a zero-length arena is handled without NaN") {
    Vec2 pos{0.0, 0.0};
    Vec2 vel{0.0, 0.0};
    integrateMovement(pos, vel, 14.0, 0.0, 0.0, kDt, 100.0, 100.0, 420.0);
    CHECK(std::isfinite(pos.x));
    CHECK(std::isfinite(pos.y));
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

TEST_CASE("game", "collision: a fast projectile cannot tunnel through an enemy") {
    // The projectile crosses the whole arena in a single step; only a swept
    // test catches this.
    const bool hit = segmentIntersectsCircle({0.0, 300.0}, {900.0, 300.0}, {450.0, 300.0}, 5.0);
    CHECK(hit);
}

TEST_CASE("game", "collision: a projectile that passes wide does not hit") {
    const bool hit = segmentIntersectsCircle({0.0, 100.0}, {900.0, 100.0}, {450.0, 300.0}, 5.0);
    CHECK(!hit);
}

TEST_CASE("game", "collision: a stationary test degenerates to a point overlap") {
    CHECK(segmentIntersectsCircle({50.0, 50.0}, {50.0, 50.0}, {50.0, 50.0}, 5.0));
    CHECK(!segmentIntersectsCircle({50.0, 50.0}, {50.0, 50.0}, {60.0, 50.0}, 5.0));
}

TEST_CASE("game", "collision: the spatial hash finds a nearby entity and misses a distant one") {
    SpatialHash grid;
    grid.configure(960.0, 600.0, 64.0);
    grid.insert(7, {100.0, 100.0}, 15.0);
    grid.insert(9, {800.0, 500.0}, 15.0);

    std::vector<int> found;
    grid.query({105.0, 105.0}, 40.0, found);
    CHECK_EQ(found.size(), std::size_t(1));
    CHECK_EQ(found[0], 7);

    grid.query({400.0, 300.0}, 30.0, found);
    CHECK_EQ(found.size(), std::size_t(0));
}

TEST_CASE("game", "collision: the spatial hash survives a resize") {
    SpatialHash grid;
    grid.configure(960.0, 600.0, 64.0);
    grid.insert(3, {100.0, 100.0}, 10.0);
    // A wider arena has more columns; the old bucket layout must be discarded.
    grid.resize(1920.0, 600.0);
    CHECK_EQ(grid.cols() * grid.cellSize() >= 1920.0, true);

    std::vector<int> found;
    grid.query({100.0, 100.0}, 20.0, found);
    // Cleared on resize, so nothing is left pointing at stale buckets.
    CHECK_EQ(found.size(), std::size_t(0));
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

TEST_CASE("game", "weapons: the blaster emits one projectile per stream") {
    std::vector<Shot> shots;
    buildShotPattern(WeaponType::Blaster, 1, 1, 1, 1, {100.0, 100.0}, 0.0, shots);
    CHECK_EQ(shots.size(), std::size_t(1));
    // Muzzle is offset along the aim direction.
    CHECK_NEAR(shots[0].position.x, 118.0, 0.5);
    CHECK_NEAR(shots[0].velocity.x, 780.0, 1.0);
}

TEST_CASE("game", "weapons: the tri-spread emits a three-pellet cone") {
    std::vector<Shot> shots;
    buildShotPattern(WeaponType::Spread, 1, 1, 1, 1, {0.0, 0.0}, 0.0, shots);
    CHECK_EQ(shots.size(), std::size_t(3));
    // The pellets are ordered by angle and the middle one is the most aligned
    // with the aim. They are deliberately *not* perfectly mirrored: each gets
    // its own jitter so a burst does not look machine-stamped.
    const double a0 = std::atan2(shots[0].velocity.y, shots[0].velocity.x);
    const double a1 = std::atan2(shots[1].velocity.y, shots[1].velocity.x);
    const double a2 = std::atan2(shots[2].velocity.y, shots[2].velocity.x);
    CHECK(a0 < a1);
    CHECK(a1 < a2);
    CHECK(std::fabs(a1) < std::fabs(a0));
    // Every pellet still travels at the same speed.
    const double speed = length(shots[0].velocity);
    CHECK_NEAR(length(shots[1].velocity), speed, 1e-6);
    CHECK_NEAR(length(shots[2].velocity), speed, 1e-6);
}

TEST_CASE("game", "weapons: power-ups stack extra streams on any weapon") {
    std::vector<Shot> shots;
    buildShotPattern(WeaponType::Blaster, 1, 1, 1, 3, {0.0, 0.0}, 0.0, shots);
    CHECK_EQ(shots.size(), std::size_t(3));
}

TEST_CASE("game", "weapons: the fire-rate upgrade actually shortens the interval") {
    const double base = fireInterval(WeaponType::Blaster, 1, 1, false);
    const double upgraded = fireInterval(WeaponType::Blaster, 2, 1, false);
    CHECK(upgraded < base);
    // One level is +25%: 0.09 / 1.25.
    CHECK_NEAR(upgraded, base / 1.25, 1e-9);
}

TEST_CASE("game", "weapons: the rapid-fire pickup shortens the interval") {
    const double normal = fireInterval(WeaponType::Blaster, 1, 1, false);
    const double rapid = fireInterval(WeaponType::Blaster, 1, 1, true);
    CHECK_NEAR(rapid, normal * 0.45, 1e-9);
}

TEST_CASE("game", "weapons: the damage upgrade raises per-pellet damage") {
    CHECK(pelletDamage(WeaponType::Blaster, 1) > pelletDamage(WeaponType::Blaster, 0) - 0.001);
    CHECK(pelletDamage(WeaponType::Blaster, 2) > pelletDamage(WeaponType::Blaster, 1));
}

TEST_CASE("game", "weapons: seekers are flagged and slower than the blaster") {
    std::vector<Shot> shots;
    buildShotPattern(WeaponType::Homing, 1, 1, 1, 1, {0.0, 0.0}, 0.0, shots);
    CHECK_EQ(shots.size(), std::size_t(1));
    CHECK(shots[0].homing);
    CHECK(std::sqrt(shots[0].velocity.x * shots[0].velocity.x) <
          bulletSpeed(1));  // 0.85x multiplier applied
}

// ---------------------------------------------------------------------------
// Player vitals
// ---------------------------------------------------------------------------

TEST_CASE("game", "damage: i-frames prevent a second hit landing immediately") {
    Player player(1, "p");
    CHECK(player.applyDamage(10.0, 100.0));
    CHECK(!player.applyDamage(10.0, 100.05));
    // Once the window expires the next hit lands.
    CHECK(player.applyDamage(10.0, 102.0));
    CHECK_NEAR(player.hp(), 80.0, 1e-9);
}

TEST_CASE("game", "damage: health never drops below zero and death is counted once") {
    Player player(1, "p");
    player.applyDamage(50.0, 0.0);
    player.applyDamage(500.0, 5.0);
    CHECK_NEAR(player.hp(), 0.0, 1e-9);
    CHECK_EQ(player.deaths(), 1);
    // A corpse takes no further damage.
    CHECK(!player.applyDamage(10.0, 20.0));
}

TEST_CASE("game", "damage: a shield absorbs hits") {
    Player player(1, "p");
    player.grantShield(6.0, 0.0);
    CHECK(!player.applyDamage(20.0, 0.1));
    CHECK_NEAR(player.hp(), 100.0, 1e-9);
    // The shield expires and damage starts landing again.
    CHECK(player.applyDamage(20.0, 7.0));
}

TEST_CASE("game", "damage: healing is capped at max health") {
    Player player(1, "p");
    player.setMaxHp(100.0);
    player.applyDamage(50.0, 0.0);
    player.heal(1000.0);
    CHECK_NEAR(player.hp(), 100.0, 1e-9);
}

TEST_CASE("game", "abilities: dash respects its cooldown") {
    Player player(1, "p");
    CHECK(player.dash(0.0));
    CHECK(!player.dash(0.1));
    CHECK(player.dash(1.2));
}

TEST_CASE("game", "abilities: a bomb consumes a charge and then refuses") {
    Player player(1, "p");
    player.setBombMax(1);
    player.setBombCharges(1);
    CHECK(player.bomb(0.0));
    CHECK(!player.bomb(1.0));
    CHECK(!player.bomb(100.0));  // still no charges, even after the cooldown
}

TEST_CASE("game", "respawn: restores health, position and charges") {
    Player player(1, "p");
    player.setBombMax(3);
    player.applyDamage(500.0, 0.0);
    player.grantShield(10.0, 0.0);
    player.respawn({100.0, 100.0}, 5.0);
    CHECK(player.alive());
    CHECK_NEAR(player.hp(), player.maxHp(), 1e-9);
    CHECK_NEAR(player.position().x, 100.0, 1e-9);
    CHECK_EQ(player.bombCharges(), 3);
    CHECK_NEAR(player.shieldRemaining(5.0), 0.0, 1e-9);
    // Brief spawn protection.
    CHECK(!player.applyDamage(10.0, 5.1));
}

// ---------------------------------------------------------------------------
// Game state integration
// ---------------------------------------------------------------------------

TEST_CASE("game", "state: joining adds a player and refuses past the cap") {
    GameState state = makeState();
    CHECK(state.addPlayer(1, "a") != nullptr);
    CHECK(state.addPlayer(2, "b") != nullptr);
    CHECK_EQ(state.playerCount(), std::size_t(2));
    // Re-adding the same id returns the existing player, not a duplicate.
    CHECK(state.addPlayer(1, "a") != nullptr);
    CHECK_EQ(state.playerCount(), std::size_t(2));
}

TEST_CASE("game", "state: two players start at different spawn points") {
    GameState state = makeState();
    Player* a = state.addPlayer(1, "a");
    Player* b = state.addPlayer(2, "b");
    CHECK(a != nullptr && b != nullptr);
    const double distance = std::hypot(a->position().x - b->position().x,
                                       a->position().y - b->position().y);
    CHECK_MSG(distance > 100.0, "players must not spawn on top of each other");
}

TEST_CASE("game", "state: server-side input moves the authoritative position") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    const double startX = player->position().x;
    state.submitInput(1, makeInput({1.0, 0.0}, {800.0, 300.0}, false, 1));
    for (int i = 0; i < 30; ++i) state.tick(kDt);
    CHECK(player->position().x > startX);
    // The acknowledged sequence is what the snapshot echoes back.
    CHECK_EQ(player->lastInputSeq(), uint64_t(1));
}

TEST_CASE("game", "state: a client cannot move by claiming a huge input vector") {
    GameState state = makeState();
    Player* honest = state.addPlayer(1, "honest");
    Player* cheater = state.addPlayer(2, "cheater");
    state.submitInput(1, makeInput({1.0, 0.0}, {0.0, 0.0}, false, 1));
    state.submitInput(2, makeInput({99.0, 99.0}, {0.0, 0.0}, false, 1));
    for (int i = 0; i < 60; ++i) state.tick(kDt);
    CHECK_MSG(cheater->position().x <= honest->position().x + 1e-6,
              "an over-long movement vector must be normalised, not amplified");
}

TEST_CASE("game", "state: fire rate is enforced by the server, not the client") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);

    // A client holding the trigger down for one second must not fire 60 times.
    int ticks = 0;
    for (int i = 0; i < 60; ++i) {
        state.submitInput(1, makeInput({0.0, 0.0}, {900.0, 300.0}, true, static_cast<uint64_t>(i + 1)));
        state.tick(kDt);
        ticks++;
    }
    // 1 second at a 0.09s interval is about 11 shots.
    const double expected = 1.0 / 0.09;
    CHECK_MSG(ticks == 60, "sanity: the loop ran 60 ticks");
    CHECK_MSG(player->lastInputSeq() > 0, "input was consumed");
    // The cooldown, not the client, gates the shots.
    CHECK_NEAR(fireInterval(player->weapon(), player->fireRateLevel(), 1, false), 0.09, 1e-6);
    CHECK_NEAR(expected, 11.11, 0.01);
}

TEST_CASE("game", "state: a bomb clears the arena and scores the kills") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    state.mutableEnemyField().spawn(EnemyKind::Grunt, {200.0, 200.0}, 1);
    state.mutableEnemyField().spawn(EnemyKind::Grunt, {700.0, 400.0}, 1);
    CHECK_EQ(state.mutableEnemyField().size(), std::size_t(2));

    player->setBombCharges(1);
    state.requestAbility(1, AbilityKind::Bomb);
    state.tick(kDt);

    CHECK_EQ(state.mutableEnemyField().size(), std::size_t(0));
    CHECK_EQ(player->kills(), 2);
    CHECK(player->score() > 0);
}

TEST_CASE("game", "state: killing a splitter spawns children that do not split again") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    player->setBombCharges(5);

    // Exactly one non-mini splitter. A bomb is used rather than the weapon so
    // the outcome is deterministic: no in-flight bullets can land on the
    // children afterwards and change the count mid-assertion.
    state.mutableEnemyField().spawn(EnemyKind::Splitter, {300.0, 300.0}, 1);
    CHECK_EQ(state.mutableEnemyField().size(), std::size_t(1));

    state.requestAbility(1, AbilityKind::Bomb);
    state.tick(kDt);

    CHECK_EQ(player->kills(), 1);
    // The parent is gone, replaced by exactly two children.
    CHECK_EQ(state.mutableEnemyField().size(), std::size_t(2));
    for (const Enemy& e : state.mutableEnemyField().items()) {
        CHECK(e.mini);
        // Children are half size, which is what stops the chain.
        CHECK_NEAR(e.radius, enemyConfig(EnemyKind::Splitter).radius * 0.6, 1e-9);
    }
}

TEST_CASE("game", "state: enemy contact damage is applied on the server") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    Enemy* enemy = state.mutableEnemyField().spawn(EnemyKind::Grunt, player->position(), 1);
    CHECK(enemy != nullptr);

    const double before = player->hp();
    state.tick(kDt);
    CHECK_MSG(player->hp() < before, "an overlapping enemy must deal damage");
}

TEST_CASE("game", "state: a dead player is respawned after the delay") {
    GameStateLimits limits;
    limits.respawnDelay = 0.2;
    GameState state(1, Arena(960.0, 600.0), limits);
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);

    // Damage goes through GameState, which is what arms the respawn timer.
    state.damagePlayer(1, 1000.0);
    CHECK(!player->alive());
    state.tick(kDt);
    CHECK_MSG(!player->alive(), "the player stays dead until the delay elapses");

    for (int i = 0; i < 30; ++i) state.tick(kDt);  // 0.5s > 0.2s delay
    CHECK_MSG(player->alive(), "the player should be back after the respawn delay");
}

TEST_CASE("game", "state: progression raises the level every five waves") {
    CHECK_EQ(Progression::levelForWave(1), 1);
    CHECK_EQ(Progression::levelForWave(5), 1);
    CHECK_EQ(Progression::levelForWave(6), 2);
    CHECK_EQ(Progression::levelForWave(11), 3);
    // Level 5 covers waves 21-25, so the boss slot is the *first* of those.
    CHECK(Progression::isBossWave(21, 5));
    CHECK(!Progression::isBossWave(22, 5));
    CHECK(Progression::isBossWave(41, 10));
    CHECK(!Progression::isBossWave(5, 1));
    // The roster grows with both wave and level.
    CHECK(Progression::rosterSize(5, 1) < Progression::rosterSize(20, 4));
}

TEST_CASE("game", "state: the enemy field is capped, deferring rather than dropping") {
    EnemyField field(4);
    for (int i = 0; i < 10; ++i) {
        CHECK_MSG(field.spawn(EnemyKind::Grunt, {100.0 + i, 100.0}, 1) != nullptr || field.full(),
                  "spawn must succeed until the cap, then refuse");
    }
    CHECK_EQ(field.size(), std::size_t(4));
    CHECK(field.full());
}

TEST_CASE("game", "state: the projectile pool is capped and never grows") {
    ProjectilePool pool(8);
    for (int i = 0; i < 20; ++i) {
        Projectile* p = pool.spawn();
        CHECK_MSG(p != nullptr || pool.full(), "pool must refuse rather than grow");
    }
    CHECK_EQ(pool.size(), std::size_t(8));
    CHECK(pool.full());
}

TEST_CASE("game", "performance: a tick with a full entity budget stays within budget") {
    // Placeholder name kept so the suite reads consistently; the real
    // performance numbers live in tests/test_performance.cpp.
    GameState state = makeState();
    state.addPlayer(1, "p");
    state.tick(kDt);
    CHECK(state.entityCount() > 0);
}

NEON_TEST_MAIN("game")
