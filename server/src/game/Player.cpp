#include "game/Player.hpp"

#include <algorithm>
#include <cmath>

namespace neon::game {

void Player::heal(double amount) {
    hp_ = std::min(maxHp_, hp_ + amount);
}

bool Player::applyDamage(double amount, double nowSeconds) {
    if (amount <= 0.0) return false;
    if (hp_ <= 0.0) return false;                 // already dead
    if (nowSeconds < iframeUntil_) return false;  // invulnerable
    if (nowSeconds < dashUntil_) return false;    // dashing
    if (nowSeconds < shieldTime_) return false;   // shielded

    hp_ -= amount;
    iframeUntil_ = nowSeconds + kIFrameSeconds;
    if (hp_ <= 0.0) {
        hp_ = 0.0;
        ++deaths_;
    }
    return true;
}

void Player::applyUpgrade(UpgradeId id) {
    switch (id) {
        case UpgradeId::FireRate: ++fireRateLevel_; break;
        case UpgradeId::Damage: ++damageLevel_; break;
        case UpgradeId::BulletSpeed: ++bulletSpeedLevel_; break;
        case UpgradeId::SpreadWeapon: weapon_ = WeaponType::Spread; break;
        case UpgradeId::HomingWeapon: weapon_ = WeaponType::Homing; break;
        case UpgradeId::PlasmaBeam:
            weapon_ = WeaponType::Blaster;
            damageLevel_ += 2;
            ++fireRateLevel_;
            break;
        case UpgradeId::Count: break;
    }
}

bool Player::dash(double nowSeconds) {
    if (hp_ <= 0.0) return false;
    if (nowSeconds < dashCooldown_) return false;
    dashCooldown_ = nowSeconds + kDashCooldownSeconds;
    dashUntil_ = nowSeconds + kDashSeconds;

    // Dash along current heading, or along the facing if nearly stationary.
    double dx = std::cos(angle_);
    double dy = std::sin(angle_);
    if (lengthSq(velocity_) > 1600.0) {
        const Vec2 dir = normalized(velocity_, {dx, dy});
        dx = dir.x;
        dy = dir.y;
    }
    velocity_ = {dx * 1400.0, dy * 1400.0};
    return true;
}

bool Player::bomb(double nowSeconds) {
    if (hp_ <= 0.0) return false;
    if (bombCharges_ < 1) return false;
    if (nowSeconds < bombCooldown_) return false;
    --bombCharges_;
    bombCooldown_ = nowSeconds + kBombCooldownSeconds;
    return true;
}

void Player::grantPower(double seconds, double nowSeconds) {
    powerTime_ = nowSeconds + seconds;
    if (powerLevel_ < 3) ++powerLevel_;
}

void Player::respawn(const Vec2& spawn, double nowSeconds) {
    position_ = spawn;
    velocity_ = {0.0, 0.0};
    hp_ = maxHp_;
    iframeUntil_ = nowSeconds + 1.5;  // brief spawn protection
    dashUntil_ = 0.0;
    dashCooldown_ = 0.0;
    shieldTime_ = 0.0;
    rapidTime_ = 0.0;
    powerTime_ = 0.0;
    powerLevel_ = 1;
    fireCooldown_ = 0.0;
    bombCharges_ = bombMax_;
    bombCooldown_ = 0.0;
}

uint32_t Player::flags(double nowSeconds) const {
    uint32_t f = 0;
    if (hp_ <= 0.0) f |= kFlagDead;
    if (nowSeconds < dashUntil_) f |= kFlagDashing;
    if (input_.firing) f |= kFlagFiring;
    return f;
}

}  // namespace neon::game
