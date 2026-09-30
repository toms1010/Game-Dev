// Neon Vanguard — authoritative match simulation.
//
// This is the server's single source of truth. It runs on one thread at a
// fixed rate and never blocks: no I/O, no allocation in the steady state, no
// locks. Networking hands it validated intent; the database is told about
// results asynchronously.
//
// What this class will not do is trust a client. Positions, damage, deaths,
// kills and score are all computed here from the rules; a client that sends a
// "I killed player 3" message is simply not a message this class accepts.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "game/Arena.hpp"
#include "game/Collision.hpp"
#include "game/Enemy.hpp"
#include "game/Movement.hpp"
#include "game/Player.hpp"
#include "game/Projectile.hpp"
#include "game/Vec.hpp"
#include "game/Weapon.hpp"

namespace neon::game {

/// Difficulty progression, identical to the offline campaign.
struct Progression {
    static constexpr int kWavesPerLevel = 5;
    static int levelForWave(int wave) { return (wave - 1) / kWavesPerLevel + 1; }
    static bool isBossLevel(int level) { return level == 5 || level == 10; }
    static bool isBossWave(int wave, int level) {
        return isBossLevel(level) && (wave - 1) % kWavesPerLevel == 0;
    }
    /// Enemies the given wave will send, roster included.
    static int rosterSize(int wave, int level) { return static_cast<int>(8 + wave * 4 + level * 3); }
};

enum class AbilityKind { Dash, Bomb };

/// Snapshot of a match outcome, handed to the persistence layer.
struct RunResult {
    uint32_t playerId = 0;
    std::string playerName;
    int64_t score = 0;
    int kills = 0;
    int deaths = 0;
    int wavesCleared = 0;
    double seconds = 0.0;
    bool survived = false;
};

struct GameStateLimits {
    std::size_t maxPlayers = 8;
    std::size_t maxProjectiles = 1024;
    std::size_t maxEnemies = 256;
    /** Seconds after death before a player respawns. */
    double respawnDelay = 3.0;
};

/**
 * The world. One instance per live match.
 */
class GameState {
public:
    using EventCallback = std::function<void(const std::string& kind, uint32_t id, double value)>;

    GameState(uint32_t matchId, Arena arena, GameStateLimits limits);

    // --- roster ---
    Player* addPlayer(uint32_t id, const std::string& name);
    void removePlayer(uint32_t id);
    Player* findPlayer(uint32_t id);
    const Player* findPlayer(uint32_t id) const;
    std::size_t playerCount() const { return players_.size(); }
    const std::vector<std::unique_ptr<Player>>& players() const { return players_; }

    // --- intent in ---
    /// Queues a validated input sample. Sequence numbers must be monotonic;
    /// stale or replayed samples are discarded by the caller.
    void submitInput(uint32_t playerId, const PlayerInput& input);
    /// Queues a validated ability request.
    void requestAbility(uint32_t playerId, AbilityKind kind);

    /**
     * Applies damage to a player and schedules the respawn.
     *
     * The single entry point for anything that can hurt a player (enemy
     * contact, enemy fire, and future hazards). Keeping it in one place is
     * what guarantees a death is always followed by a respawn — the bug that
     * duplicated this logic across two call sites is exactly the kind that
     * strands a corpse forever when a third source is added.
     */
    void damagePlayer(uint32_t playerId, double amount);

    // --- simulation ---
    /// Advances exactly one fixed step.
    void tick(double dt);

    uint64_t tickCount() const { return tick_; }
    double time() const { return time_; }
    uint32_t matchId() const { return matchId_; }
    const Arena& arena() const { return arena_; }
    int wave() const { return wave_; }
    int level() const { return level_; }
    int enemiesRemaining() const;
    /// Read-only access, for snapshot serialisation on the game thread.
    const EnemyField& enemyField() const { return enemies_; }
    /// Mutable access, for the simulation and the test suite.
    EnemyField& mutableEnemyField() { return enemies_; }
    std::size_t entityCount() const { return players_.size() + enemies_.size() + projectiles_.size(); }

    void setEventCallback(EventCallback cb) { onEvent_ = std::move(cb); }
    void setResultCallback(std::function<void(const RunResult&)> cb) { onResult_ = std::move(cb); }

    /// Ends the match, emitting a final result per player.
    void finish();

    bool finished() const { return finished_; }

private:
    void advancePlayers(double dt);
    /// Books a death: emits the event and arms the respawn timer.
    void handleDeath(Player& player);
    void advanceProjectiles(double dt);
    void advanceEnemies(double dt);
    void resolveProjectiles();
    void resolveContacts();
    void advanceProgression(double dt);
    void spawnWaveEnemy();
    void awardKill(Player& shooter, Enemy& enemy);
    void emit(const std::string& kind, uint32_t id, double value);

    uint32_t matchId_;
    Arena arena_;
    GameStateLimits limits_;

    std::vector<std::unique_ptr<Player>> players_;
    /// Pending input per player, applied on the next tick.
    std::unordered_map<uint32_t, PlayerInput> pendingInputs_;
    std::unordered_map<uint32_t, bool> pendingDash_;
    std::unordered_map<uint32_t, bool> pendingBomb_;

    EnemyField enemies_;
    ProjectilePool projectiles_;
    SpatialHash grid_;
    /// Reused between ticks so the hot path does not allocate.
    std::vector<int> queryScratch_;
    std::vector<Shot> shotScratch_;

    double time_ = 0.0;
    uint64_t tick_ = 0;
    int wave_ = 1;
    int level_ = 1;
    int enemiesRemainingInWave_ = 0;
    double spawnTimer_ = 0.6;
    bool spawningFinished_ = false;
    bool finished_ = false;
    /// Per-player respawn timers, keyed by player id.
    std::unordered_map<uint32_t, double> respawnAt_;

    EventCallback onEvent_;
    std::function<void(const RunResult&)> onResult_;
};

}  // namespace neon::game
