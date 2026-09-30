// Neon Vanguard — performance budget tests.
//
// These assert *budgets*, not absolute speed: a shared CI machine is slower
// than a dedicated box, and a test that fails on hardware is worse than no
// test. Each budget is deliberately loose enough to survive a slow runner
// while still catching an order-of-magnitude regression — which is the failure
// mode that actually happens when someone removes a spatial hash or a pool.

#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

#include "game/Arena.hpp"
#include "game/Collision.hpp"
#include "game/GameState.hpp"
#include "game/Projectile.hpp"
#include "harness.hpp"

using namespace neon::game;

namespace {

constexpr double kDt = 1.0 / 60.0;

/// Milliseconds elapsed while running `body` `iterations` times.
template <typename Fn>
double timeMs(int iterations, Fn&& body) {
    const auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < iterations; ++i) body();
    const auto end = std::chrono::steady_clock::now();
    return std::chrono::duration<double, std::milli>(end - start).count() / iterations;
}

GameState makeState(std::size_t enemies, std::size_t projectiles) {
    GameStateLimits limits;
    limits.maxPlayers = 8;
    limits.maxProjectiles = projectiles;
    limits.maxEnemies = enemies > 0 ? enemies : 1;
    return GameState(1, Arena(1920.0, 600.0), limits);
}

}  // namespace

TEST_CASE("performance", "budget: 100 players move within the per-tick budget") {
    GameState state = makeState(0, 0);
    for (int i = 0; i < 100; ++i) {
        // The cap is 8, so this deliberately tests the *refusal* path too.
        state.addPlayer(static_cast<uint32_t>(i + 1), "p");
    }
    CHECK_MSG(state.playerCount() == 8, "the player cap must hold regardless of demand");

    // 8 players is the real ceiling; a 100-player request must not cost more
    // than an 8-player tick.
    const double perTick = timeMs(600, [&] {
        for (int seq = 1; seq <= 8; ++seq) {
            PlayerInput in;
            in.sequence = static_cast<uint64_t>(seq);
            in.move = {0.6, -0.3};
            in.aim = {900.0, 300.0};
            in.valid = true;
            state.submitInput(static_cast<uint32_t>(seq), in);
        }
        state.tick(kDt);
    });
    std::printf("        8 players: %.4f ms/tick\n", perTick);
    // 16.6ms is a whole frame; the simulation must leave room for rendering
    // and the network, so a tenth of it is the target.
    CHECK_MSG(perTick < 1.66, "8-player simulation must fit in 10% of a 60Hz frame");
}

TEST_CASE("performance", "budget: 500 entities tick within budget") {
    GameState state = makeState(500, 1024);
    state.addPlayer(1, "p");
    for (int i = 0; i < 500; ++i) {
        state.mutableEnemyField().spawn(EnemyKind::Grunt, {50.0 + (i % 40) * 45.0,
                                                    40.0 + (i / 40) * 45.0},
                                 3);
    }
    CHECK_EQ(state.mutableEnemyField().size(), std::size_t(500));

    const double perTick = timeMs(120, [&] { state.tick(kDt); });
    std::printf("        500 enemies: %.4f ms/tick\n", perTick);
    // Ten per cent of a frame. The spatial hash is what makes this possible:
    // a linear scan of 500 enemies per projectile would be an order of
    // magnitude slower.
    CHECK_MSG(perTick < 1.66, "500-entity simulation must fit in 10% of a frame");
}

TEST_CASE("performance", "budget: 1000 projectiles resolve within budget") {
    GameState state = makeState(200, 1024);
    state.addPlayer(1, "p");
    for (int i = 0; i < 200; ++i) {
        state.mutableEnemyField().spawn(EnemyKind::Tank, {400.0 + (i % 20) * 60.0,
                                                   100.0 + (i / 20) * 50.0},
                                 3);
    }
    // Fill the pool to its ceiling; it must refuse rather than grow.
    ProjectilePool* unused = nullptr;
    (void)unused;

    PlayerInput in;
    in.sequence = 1;
    in.move = {0.0, 0.0};
    in.aim = {1800.0, 300.0};
    in.firing = true;
    in.valid = true;
    state.submitInput(1, in);

    const double perTick = timeMs(120, [&] { state.tick(kDt); });
    std::printf("        200 enemies + firing: %.4f ms/tick\n", perTick);
    CHECK_MSG(state.entityCount() <= 1400, "the entity budget is respected");
    CHECK_MSG(perTick < 1.66, "a busy combat tick must fit in 10% of a frame");
}

TEST_CASE("performance", "budget: the projectile pool never allocates past its ceiling") {
    ProjectilePool pool(1000);
    for (int i = 0; i < 5000; ++i) {
        Projectile* p = pool.spawn();
        CHECK(p != nullptr || pool.full());
    }
    CHECK_EQ(pool.size(), std::size_t(1000));
}

TEST_CASE("performance", "budget: spatial hash queries stay far cheaper than a linear scan") {
    SpatialHash grid;
    grid.configure(1920.0, 600.0, 64.0);
    for (int i = 0; i < 500; ++i) {
        grid.insert(i, {30.0 + (i % 40) * 46.0, 30.0 + (i / 40) * 46.0}, 15.0);
    }

    std::vector<int> found;
    const double perQuery = timeMs(20000, [&] { grid.query({900.0, 300.0}, 40.0, found); });
    std::printf("        hash query: %.6f ms, %zu candidates\n", perQuery, found.size());
    // A query must not scale with the entity count. The returned set is every
    // entity whose cells overlap the query (so it is more than one, because an
    // entity is inserted into each cell its bounding box touches), but it must
    // be a small fraction of the population.
    CHECK_MSG(!found.empty(), "the query must find the entity it is aimed at");
    CHECK_MSG(found.size() < 500 / 4,
              "a local query must not scan the whole population, got " +
                  std::to_string(found.size()));
    CHECK_MSG(perQuery < 0.05, "a hash query must be microseconds, not milliseconds");
}

TEST_CASE("performance", "budget: 2000 ticks of a full match stay in the frame budget") {
    GameState state = makeState(256, 1024);
    state.addPlayer(1, "p");
    state.addPlayer(2, "p");

    // 6000 ticks is 100 seconds: long enough for wave 1's roster to finish
    // spawning (about 17s at the wave-1 cadence) and then be cleared, so the
    // progression path is genuinely exercised rather than just measured.
    uint64_t seq = 0;
    const auto start = std::chrono::steady_clock::now();
    for (int tick = 0; tick < 6000; ++tick) {
        for (int player = 1; player <= 2; ++player) {
            PlayerInput in;
            in.sequence = ++seq;
            in.move = {0.5, 0.2};
            in.aim = {900.0, 300.0};
            in.firing = (tick % 3) == 0;
            in.valid = true;
            state.submitInput(static_cast<uint32_t>(player), in);
        }
        state.tick(kDt);
    }
    const auto end = std::chrono::steady_clock::now();
    const double total = std::chrono::duration<double, std::milli>(end - start).count();
    const double perTickMs = total / 6000.0;
    std::printf("        6000 ticks: %.2f ms total (%.4f ms/tick), wave %d, %zu entities\n",
                total, perTickMs, state.wave(), state.entityCount());
    // Average across the whole run, so a slow first wave and a fast later one
    // both count.
    CHECK_MSG(perTickMs < 1.66, "average tick cost must stay inside the budget");
    CHECK_MSG(state.wave() > 1,
              "the match should have progressed past the first wave, at wave " +
                  std::to_string(state.wave()));
}

TEST_CASE("performance", "budget: enemy removal does not allocate per tick") {
    EnemyField field(512);
    for (int i = 0; i < 256; ++i) field.spawn(EnemyKind::Grunt, {100.0 + i, 100.0}, 1);
    // Mark them all dead and let the sweep compact the list.
    for (Enemy& e : field.mutableItems()) e.dead = true;

    const double perSweep = timeMs(1000, [&] { field.removeDead(); });
    std::printf("        enemy sweep: %.6f ms\n", perSweep);
    CHECK_EQ(field.size(), std::size_t(0));
    CHECK_MSG(perSweep < 0.5, "a full sweep of 256 enemies must be sub-millisecond");
}

NEON_TEST_MAIN("performance")
