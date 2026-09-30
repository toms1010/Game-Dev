// Neon Vanguard — server-side player state.
//
// Everything in here is authoritative. A client may only state intent
// (movement vector, aim point, trigger, abilities); every value below is
// derived by the simulation. `lastInputSeq` is echoed back in every snapshot
// so the client knows which of its samples have been consumed.

#pragma once

#include <cstdint>
#include <string>

#include "game/Arena.hpp"
#include "game/Vec.hpp"
#include "game/Weapon.hpp"

namespace neon::game {

/// Player flag bits, mirrored in `src/network/protocol.ts`.
enum PlayerFlags : uint32_t {
    kFlagFiring = 1u << 0,
    kFlagDashing = 1u << 1,
    kFlagDead = 1u << 2,
};

/// One input sample after validation. Fields are already clamped.
struct PlayerInput {
    uint64_t sequence = 0;
    Vec2 move{0.0, 0.0};
    Vec2 aim{0.0, 0.0};
    bool firing = false;
    bool valid = false;
};

class Player {
public:
    Player() = default;
    Player(uint32_t id, std::string name) : id_(id), name_(std::move(name)) {}

    uint32_t id() const { return id_; }
    const std::string& name() const { return name_; }
    void setName(std::string n) { name_ = std::move(n); }

    // --- transform ---
    const Vec2& position() const { return position_; }
    Vec2& position() { return position_; }
    const Vec2& velocity() const { return velocity_; }
    Vec2& velocity() { return velocity_; }
    double angle() const { return angle_; }
    void setAngle(double a) { angle_ = a; }

    // --- vitals ---
    double hp() const { return hp_; }
    double maxHp() const { return maxHp_; }
    bool alive() const { return hp_ > 0.0; }
    void setMaxHp(double v) { maxHp_ = v; hp_ = v; }
    void heal(double amount);

    /// Applies damage, respecting i-frames, dash and shield. Returns true when
    /// the hit actually landed.
    bool applyDamage(double amount, double nowSeconds);

    // --- combat ---
    WeaponType weapon() const { return weapon_; }
    void setWeapon(WeaponType w) { weapon_ = w; }
    int fireRateLevel() const { return fireRateLevel_; }
    int damageLevel() const { return damageLevel_; }
    int bulletSpeedLevel() const { return bulletSpeedLevel_; }
    void applyUpgrade(UpgradeId id);
    bool canFire(double nowSeconds) const { return fireCooldown_ <= nowSeconds; }
    void onFired(double nowSeconds) { fireCooldown_ = nowSeconds + fireInterval(weapon_, fireRateLevel_, powerLevel_, rapidTime_ > nowSeconds); }
    double fireCooldown() const { return fireCooldown_; }
    void setFireCooldown(double t) { fireCooldown_ = t; }

    // --- abilities (server-enforced cooldowns) ---
    bool dash(double nowSeconds);
    bool bomb(double nowSeconds);
    double dashCooldown() const { return dashCooldown_; }
    double bombCooldown() const { return bombCooldown_; }
    int bombCharges() const { return bombCharges_; }
    void setBombCharges(int n) { bombCharges_ = n; }
    void setBombMax(int n) { bombMax_ = n; }

    // --- timed effects ---
    void grantShield(double seconds, double nowSeconds) { shieldTime_ = nowSeconds + seconds; }
    void grantRapid(double seconds, double nowSeconds) { rapidTime_ = nowSeconds + seconds; }
    double shieldRemaining(double nowSeconds) const { return std::max(0.0, shieldTime_ - nowSeconds); }
    double rapidRemaining(double nowSeconds) const { return std::max(0.0, rapidTime_ - nowSeconds); }

    // --- buffs ---
    int powerLevel() const { return powerLevel_; }
    void grantPower(double seconds, double nowSeconds);

    // --- bookkeeping ---
    void addScore(int64_t amount) { score_ += amount; }
    int64_t score() const { return score_; }
    void addKill() { ++kills_; }
    void addDeath() { ++deaths_; }
    int kills() const { return kills_; }
    int deaths() const { return deaths_; }

    uint64_t lastInputSeq() const { return lastInputSeq_; }
    void setLastInputSeq(uint64_t s) { lastInputSeq_ = s; }
    const PlayerInput& input() const { return input_; }
    void setInput(const PlayerInput& in) { input_ = in; }

    /// Places the player at a spawn point and clears per-life state.
    void respawn(const Vec2& spawn, double nowSeconds);

    /// Radius used for collision and rendering.
    double radius() const { return kPlayerRadius; }

    uint32_t flags(double nowSeconds) const;

private:
    static constexpr double kPlayerRadius = 14.0;
    static constexpr double kIFrameSeconds = 0.9;
    static constexpr double kDashSeconds = 0.18;
    static constexpr double kDashCooldownSeconds = 1.1;
    static constexpr double kBombCooldownSeconds = 20.0;

    uint32_t id_ = 0;
    std::string name_;

    Vec2 position_{480.0, 300.0};
    Vec2 velocity_{0.0, 0.0};
    double angle_ = 0.0;

    double hp_ = 100.0;
    double maxHp_ = 100.0;
    double iframeUntil_ = 0.0;
    double dashUntil_ = 0.0;
    double dashCooldown_ = 0.0;
    double bombCooldown_ = 0.0;
    double shieldTime_ = 0.0;
    double rapidTime_ = 0.0;
    double powerTime_ = 0.0;
    int bombCharges_ = 2;
    int bombMax_ = 2;

    WeaponType weapon_ = WeaponType::Blaster;
    int fireRateLevel_ = 1;
    int damageLevel_ = 1;
    int bulletSpeedLevel_ = 1;
    int powerLevel_ = 1;
    double fireCooldown_ = 0.0;

    int64_t score_ = 0;
    int kills_ = 0;
    int deaths_ = 0;

    uint64_t lastInputSeq_ = 0;
    PlayerInput input_;
};

}  // namespace neon::game
