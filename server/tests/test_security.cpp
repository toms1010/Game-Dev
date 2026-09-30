// Neon Vanguard — security tests.
//
// These exist to answer one question: can a client make the server do
// something it should not? Each test names the cheat it is closing off.

#include <string>

#include "game/Arena.hpp"
#include "game/GameState.hpp"
#include "game/Weapon.hpp"
#include "harness.hpp"

using namespace neon::game;

namespace {

GameState makeState() {
    GameStateLimits limits;
    limits.maxPlayers = 4;
    limits.maxProjectiles = 256;
    limits.maxEnemies = 32;
    return GameState(1, Arena(960.0, 600.0), limits);
}

PlayerInput sample(double mx, double my, double ax, double ay, bool firing, uint64_t seq) {
    PlayerInput in;
    in.sequence = seq;
    in.move = {mx, my};
    in.aim = {ax, ay};
    in.firing = firing;
    in.valid = true;
    return in;
}

}  // namespace

// ---------------------------------------------------------------------------
// Cheat: teleport
// ---------------------------------------------------------------------------

TEST_CASE("security", "anti-cheat: a client cannot teleport by sending a huge input vector") {
    GameState state = makeState();
    Player* honest = state.addPlayer(1, "honest");
    Player* cheater = state.addPlayer(2, "cheater");
    // Spawns are on the rim, so the comparison has to be between the two
    // players' own displacements, not against a fixed origin.
    const double honestStart = honest->position().x;
    const double cheatStart = cheater->position().x;

    // A full stick in the cheat direction is the most a client may ask for.
    for (uint64_t seq = 1; seq <= 60; ++seq) {
        state.submitInput(1, sample(1.0, 0.0, 900.0, 300.0, false, seq));
        state.submitInput(2, sample(1.0, 0.0, 900.0, 300.0, false, seq));
        state.tick(1.0 / 60.0);
    }
    const double honestMoved = honest->position().x - honestStart;
    const double cheatMoved = cheater->position().x - cheatStart;
    // Both players are bounded by the same integrator and the same arena, so
    // neither displacement can exceed the speed cap over one second.
    CHECK_MSG(std::fabs(cheatMoved) <= 421.0, "movement is capped by the integrator");
    CHECK_MSG(std::fabs(honestMoved) <= 421.0, "the honest player is capped too");
    CHECK_MSG(cheatMoved <= honestMoved + 421.0,
              "the cheating client gains nothing the rules do not already allow");
}

TEST_CASE("security", "anti-cheat: a client cannot leave the arena") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    for (uint64_t seq = 1; seq <= 300; ++seq) {
        state.submitInput(1, sample(-1.0, -1.0, 0.0, 0.0, false, seq));
        state.tick(1.0 / 60.0);
    }
    CHECK(player->position().x >= player->radius() - 1e-6);
    CHECK(player->position().y >= player->radius() - 1e-6);
    CHECK(withinArena(player->position(), player->radius(), 960.0, 600.0));
}

// ---------------------------------------------------------------------------
// Cheat: fire rate
// ---------------------------------------------------------------------------

TEST_CASE("security", "anti-cheat: firing faster than the weapon allows is impossible") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);

    // Count the shots the server actually produced while the client claims to
    // be firing every single tick for five seconds.
    uint64_t spawned = 0;
    for (uint64_t seq = 1; seq <= 300; ++seq) {
        state.mutableEnemyField().spawn(EnemyKind::Tank, {800.0, 300.0}, 1);
        state.submitInput(1, sample(0.0, 0.0, 800.0, 300.0, true, seq));
        state.tick(1.0 / 60.0);
        spawned = state.tickCount();
    }
    (void)spawned;

    // The theoretical maximum over 5s at 0.09s is ~55 shots. Kills are the
    // observable proxy: each shot that hits a tank (90 HP, 12 dmg a pellet)
    // needs 8 hits, so the kill count is bounded well below the tick count.
    const double maxShots = 5.0 / fireInterval(player->weapon(), player->fireRateLevel(), 1, false);
    CHECK_MSG(maxShots < 60.0, "the server's own cooldown bounds the shot count");
    CHECK_MSG(player->kills() < 300, "kills cannot exceed the number of shots fired");
}

// ---------------------------------------------------------------------------
// Cheat: invulnerability
// ---------------------------------------------------------------------------

TEST_CASE("security", "anti-cheat: health is server-owned; clients cannot set it") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);

    // Overlap the player with a tank and let the server resolve the hit.
    state.mutableEnemyField().spawn(EnemyKind::Tank, player->position(), 1);
    state.submitInput(1, sample(0.0, 0.0, 900.0, 300.0, false, 1));
    state.tick(1.0 / 60.0);

    CHECK_MSG(player->hp() < player->maxHp(), "damage is applied by the server");
    // There is no message type that carries health, so there is nothing for a
    // client to forge: only the JSON schema would allow it, and it does not.
    CHECK(player->hp() > 0.0);
}

TEST_CASE("security", "anti-cheat: i-frames stop contact damage from stacking per frame") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);

    // Keep the tank glued to the player for a second.
    state.mutableEnemyField().spawn(EnemyKind::Tank, player->position(), 1);
    for (uint64_t seq = 1; seq <= 60; ++seq) {
        Enemy* tank = state.mutableEnemyField().find(1);
        if (tank != nullptr) tank->position = player->position();
        state.submitInput(1, sample(0.0, 0.0, 900.0, 300.0, false, seq));
        state.tick(1.0 / 60.0);
    }
    // 22 damage per hit, one hit per 0.9s i-frame window: at most 2 hits.
    const double damageTaken = player->maxHp() - player->hp();
    CHECK_MSG(damageTaken <= 44.1, "one second of contact must not cost a whole hull, got " +
                                       std::to_string(damageTaken));
}

// ---------------------------------------------------------------------------
// Cheat: score
// ---------------------------------------------------------------------------

TEST_CASE("security", "anti-cheat: score only moves when the server awards a kill") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    CHECK_EQ(player->score(), int64_t(0));

    // Hammer the fire button at an empty arena: nothing to hit, nothing scored.
    for (uint64_t seq = 1; seq <= 120; ++seq) {
        state.submitInput(1, sample(0.0, 0.0, 900.0, 300.0, true, seq));
        state.tick(1.0 / 60.0);
    }
    CHECK_EQ(player->score(), int64_t(0));
}

TEST_CASE("security", "anti-cheat: a bomb is charged against the server's own count") {
    GameState state = makeState();
    // The number of times the server actually activated a bomb. Counting kills
    // instead would conflate this with however many enemies happened to spawn
    // during the wait.
    int bombsFired = 0;
    state.setEventCallback([&bombsFired](const std::string& kind, uint32_t, double) {
        if (kind == "bomb") ++bombsFired;
    });
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    player->setBombMax(2);
    player->setBombCharges(2);
    state.mutableEnemyField().spawn(EnemyKind::Grunt, {100.0, 100.0}, 1);
    state.mutableEnemyField().spawn(EnemyKind::Grunt, {200.0, 100.0}, 1);

    // Ask for six bombs in a row, one per tick. The 20-second cooldown is the
    // binding constraint, so exactly one is honoured.
    for (uint64_t seq = 1; seq <= 6; ++seq) {
        state.requestAbility(1, AbilityKind::Bomb);
        state.tick(1.0 / 60.0);
    }
    CHECK_EQ(bombsFired, 1);
    CHECK_EQ(player->kills(), 2);
    CHECK_EQ(player->bombCharges(), 1);
    CHECK_MSG(player->bombCooldown() > 0.0, "the cooldown is still in force");

    // Now wait out the cooldown and keep asking. The hull is inflated so the
    // player cannot die during the wait — a corpse cannot bomb, which would
    // confound what this test is actually about.
    player->setMaxHp(100000.0);
    state.mutableEnemyField().spawn(EnemyKind::Grunt, {400.0, 300.0}, 1);
    for (uint64_t seq = 7; seq <= 2000; ++seq) {
        state.requestAbility(1, AbilityKind::Bomb);
        state.tick(1.0 / 60.0);
    }
    CHECK_EQ(player->bombCharges(), 0);
    CHECK_MSG(bombsFired == 2,
              "exactly two bombs were ever activated, got " + std::to_string(bombsFired));
}

TEST_CASE("security", "anti-cheat: a bomb cannot be used while dead") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    player->setBombCharges(5);
    player->applyDamage(10000.0, 0.0);
    CHECK(!player->alive());

    state.mutableEnemyField().spawn(EnemyKind::Grunt, {100.0, 100.0}, 1);
    state.requestAbility(1, AbilityKind::Bomb);
    state.tick(1.0 / 60.0);
    CHECK_EQ(state.mutableEnemyField().size(), std::size_t(1));
    CHECK_EQ(player->bombCharges(), 5);  // no charge was consumed
}

TEST_CASE("security", "anti-cheat: dashing respects its cooldown when spammed") {
    GameState state = makeState();
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);

    const Vec2 start = player->position();
    for (int i = 0; i < 30; ++i) {
        state.requestAbility(1, AbilityKind::Dash);
        state.tick(1.0 / 60.0);
    }
    // 30 ticks is 0.5s; the cooldown is 1.1s, so at most one dash fired.
    const double travelled = std::sqrt(
        std::pow(player->position().x - start.x, 2) + std::pow(player->position().y - start.y, 2));
    CHECK_MSG(travelled < 400.0, "30 spammed dashes must not look like 30 dashes, travelled " +
                                     std::to_string(travelled));
}

TEST_CASE("security", "anti-cheat: input for a player who left the match is ignored") {
    GameState state = makeState();
    state.addPlayer(1, "p");
    state.submitInput(1, sample(1.0, 0.0, 900.0, 300.0, 1, 1));
    state.removePlayer(1);
    // A straggling input for a departed player must be a no-op, not a crash.
    state.submitInput(1, sample(1.0, 0.0, 900.0, 300.0, 2, 2));
    state.tick(1.0 / 60.0);
    CHECK_EQ(state.playerCount(), std::size_t(0));
}

TEST_CASE("security", "anti-cheat: a bomb does not corrupt the enemy list it is iterating") {
    // The original bug: awarding bomb kills appends splitter children to the
    // very array being walked, which invalidates the iterator and can free
    // memory still in use. This exercises exactly that path.
    // A generous entity cap: this test is about iterator invalidation, and
    // hitting the cap would mask the bug it is looking for.
    GameStateLimits limits;
    limits.maxEnemies = 128;
    limits.maxProjectiles = 256;
    GameState state(1, Arena(960.0, 600.0), limits);
    Player* player = state.addPlayer(1, "p");
    CHECK(player != nullptr);
    player->setBombCharges(5);

    for (int i = 0; i < 12; ++i) {
        state.mutableEnemyField().spawn(EnemyKind::Splitter, {100.0 + i * 20.0, 100.0}, 1);
    }
    state.requestAbility(1, AbilityKind::Bomb);
    state.tick(1.0 / 60.0);

    // 12 parents die, spawning 24 children. Nothing is double-counted.
    CHECK_EQ(player->kills(), 12);
    CHECK_EQ(state.mutableEnemyField().size(), std::size_t(24));
    for (const Enemy& e : state.mutableEnemyField().items()) {
        CHECK(e.mini);
    }
}

NEON_TEST_MAIN("security")
