#include "game/Weapon.hpp"

#include <algorithm>
#include <cmath>

namespace neon::game {

namespace {

// Mirrors WEAPON_STATS in src/game/weapons.ts. Colours are 0xRRGGBB.
constexpr WeaponStats kBlaster{"PULSE BLASTER", "BLASTER", 12.0, 1.0, 4.0, 1.1, 0x7df9ff, 0.0, 1, 0.03, false};
constexpr WeaponStats kSpread{"TRI-SPREAD CANNON", "SPREAD", 12.0, 1.0, 4.0, 1.1, 0xf472b6, 0.2, 3, 0.02,
                              false};
constexpr WeaponStats kHoming{"SEEKER MISSILES", "HOMING", 12.0, 0.85, 5.0, 1.6, 0xffd166, 0.0, 1, 0.25, true};

constexpr double kMuzzleOffset = 18.0;

/**
 * Cheap deterministic PRNG for muzzle jitter.
 *
 * Function-local static: single-threaded by construction, because only the
 * game thread builds shot patterns. A client cannot influence it, and the
 * spread it produces is within a fraction of a degree either way.
 */
uint32_t jitterSeed_ = 0x9e3779b9u;

}  // namespace

const WeaponStats& weaponStats(WeaponType type) {
    switch (type) {
        case WeaponType::Spread: return kSpread;
        case WeaponType::Homing: return kHoming;
        case WeaponType::Blaster:
        default: return kBlaster;
    }
}

const char* weaponName(WeaponType type) {
    switch (type) {
        case WeaponType::Spread: return "spread";
        case WeaponType::Homing: return "homing";
        case WeaponType::Blaster:
        default: return "blaster";
    }
}

double pelletDamage(WeaponType weapon, int damageLevel) {
    return std::round(weaponStats(weapon).damage * (1.0 + (damageLevel - 1) * 0.3));
}

double bulletSpeed(int bulletSpeedLevel) {
    return 780.0 * (1.0 + (bulletSpeedLevel - 1) * 0.3);
}

double fireInterval(WeaponType weapon, int fireRateLevel, int powerLevel, bool rapid) {
    (void)weapon;
    // More power-up streams cycle the weapon slightly faster.
    double base = powerLevel >= 3 ? 0.075 : 0.09;
    base /= 1.0 + (fireRateLevel - 1) * 0.25;
    if (rapid) base *= 0.45;
    return base;
}

void buildShotPattern(WeaponType weapon, int fireRateLevel, int damageLevel, int bulletSpeedLevel,
                      int powerLevel, const Vec2& origin, double angle, std::vector<Shot>& out) {
    (void)fireRateLevel;  // affects the interval, not the pattern
    out.clear();

    const WeaponStats& stats = weaponStats(weapon);
    const double damage = pelletDamage(weapon, damageLevel);
    const double speed = bulletSpeed(bulletSpeedLevel) * stats.speedMult;
    const int streams = powerLevel >= 3 ? 3 : (powerLevel >= 2 ? 2 : 1);
    // Multi-pellet weapons widen the gap between stacked streams so the cone
    // stays readable instead of collapsing into one blob.
    const double streamSpread = stats.pellets > 1 ? 0.3 : 0.14;
    // A cone spreads its damage, so each pellet carries less than a focused shot.
    const double perPellet = std::round(damage * (stats.pellets > 1 ? 0.85 : 1.0));

    out.reserve(static_cast<std::size_t>(streams * stats.pellets));

    for (int i = 0; i < streams; ++i) {
        const double stream = angle + (streams == 1 ? 0.0 : (i - (streams - 1) / 2.0) * streamSpread);
        for (int j = 0; j < stats.pellets; ++j) {
            const double offset =
                stats.pellets == 1 ? 0.0 : (j - (stats.pellets - 1) / 2.0) * stats.pelletSpread;
            // Deterministic jitter from a cheap LCG: Math.random() equivalents
            // would need a seeded PRNG on both sides, and the deviation is
            // sub-pixel on the client anyway.
            const double jitter = (jitterSeed_ = jitterSeed_ * 1103515245u + 12345u,
                                   ((jitterSeed_ >> 16) & 0x7fff) / 32767.0 * 2.0 - 1.0) *
                                  stats.jitter;
            const double a = stream + offset + jitter;
            const double cosA = std::cos(a);
            const double sinA = std::sin(a);

            Shot shot;
            shot.position = {origin.x + cosA * kMuzzleOffset, origin.y + sinA * kMuzzleOffset};
            shot.velocity = {cosA * speed, sinA * speed};
            shot.radius = stats.radius;
            shot.life = stats.life;
            shot.damage = perPellet;
            shot.color = stats.color;
            shot.homing = stats.homing;
            out.push_back(shot);
        }
    }
}

}  // namespace neon::game
