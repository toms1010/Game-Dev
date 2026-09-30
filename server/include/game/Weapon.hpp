// Neon Vanguard — weapons.
//
// Mirrors `src/game/weapons.ts`. The server owns these numbers: a client
// claiming a different fire rate, projectile count or damage is ignored,
// because damage is only ever computed here from the player's chosen weapon
// and upgrade levels.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "game/Vec.hpp"

namespace neon::game {

enum class WeaponType : uint8_t { Blaster = 0, Spread = 1, Homing = 2 };
enum class UpgradeId : uint8_t {
    FireRate = 0, Damage, BulletSpeed, SpreadWeapon, HomingWeapon, PlasmaBeam, Count
};

struct WeaponStats {
    const char* label;
    const char* tag;
    double damage;
    double speedMult;
    double radius;
    double life;
    uint32_t color;      // 0xRRGGBB
    double pelletSpread; // half-width between pellets, radians
    int pellets;
    double jitter;
    bool homing;
};

const WeaponStats& weaponStats(WeaponType type);
const char* weaponName(WeaponType type);

/// Damage per pellet, after HIGH CALIBER levels.
double pelletDamage(WeaponType weapon, int damageLevel);

/// Muzzle velocity, after VELOCITY DRIVE levels.
double bulletSpeed(int bulletSpeedLevel);

/// Seconds between trigger pulls. The single source of truth for fire rate:
/// the cooldown gate and the weapon itself both call this, so the fire-rate
/// upgrade cannot be silently overwritten.
double fireInterval(WeaponType weapon, int fireRateLevel, int powerLevel, bool rapid);

/// One projectile about to be spawned.
struct Shot {
    Vec2 position;
    Vec2 velocity;
    double radius;
    double life;
    double damage;
    uint32_t color;
    bool homing;
};

/**
 * Produces every projectile for one trigger pull.
 *
 * `out` is cleared then filled. Allocation-free after warm-up: reserve once
 * and the vector reuses its capacity.
 */
void buildShotPattern(WeaponType weapon, int fireRateLevel, int damageLevel, int bulletSpeedLevel,
                      int powerLevel, const Vec2& origin, double angle, std::vector<Shot>& out);

}  // namespace neon::game
