// Neon Vanguard — authoritative movement integration.
//
// This is a line-for-line mirror of `integrateMovement()` in
// `src/game/physics.ts`. The two must stay identical: the client replays this
// same function during reconciliation, and any divergence would show up as
// constant, unfixable positional error for the player.
//
// The test suite asserts they agree to within a tenth of a world unit.

#pragma once

#include "game/Vec.hpp"

namespace neon::game {

/// Tuning constants shared by the client and server. Do not change one side only.
struct MovementTuning {
    double acceleration = 3400.0;
    double frictionBase = 0.0009;
    double maxSpeed = 420.0;
    double dashSpeed = 1400.0;
};

/**
 * Integrates one body for a single fixed step.
 *
 * `dt` must be the fixed simulation step. Input is clamped to the unit
 * circle, so a client cannot gain speed by sending a long vector.
 */
void integrateMovement(Vec2& pos, Vec2& vel, double radius, double inputX, double inputY,
                       double dt, double arenaW, double arenaH, double maxSpeed,
                       const MovementTuning& tuning = {});

/** True when a proposed position is inside the arena for a body of `radius`. */
bool withinArena(const Vec2& pos, double radius, double arenaW, double arenaH);

}  // namespace neon::game
