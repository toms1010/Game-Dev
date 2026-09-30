#include "game/Movement.hpp"

#include <cmath>

namespace neon::game {

void integrateMovement(Vec2& pos, Vec2& vel, double radius, double inputX, double inputY, double dt,
                       double arenaW, double arenaH, double maxSpeed, const MovementTuning& tuning) {
    // Input is clamped to the unit circle so a client cannot send a long
    // vector and gain speed. This is the server's version of the client's
    // `if (m > 1) normalise` step and the two must match exactly.
    Vec2 input{inputX, inputY};
    const double m = std::sqrt(input.x * input.x + input.y * input.y);
    if (m > 1.0) {
        input.x /= m;
        input.y /= m;
    }

    vel.x += input.x * tuning.acceleration * dt;
    vel.y += input.y * tuning.acceleration * dt;

    const double friction = std::pow(tuning.frictionBase, dt);
    vel.x *= friction;
    vel.y *= friction;

    const double speed = std::sqrt(vel.x * vel.x + vel.y * vel.y);
    if (speed > maxSpeed && speed > 1e-9) {
        const double scale = maxSpeed / speed;
        vel.x *= scale;
        vel.y *= scale;
    }

    pos.x += vel.x * dt;
    pos.y += vel.y * dt;

    // Clamp to the arena and cancel the velocity component into the wall so
    // the ship slides along the boundary instead of sticking to it.
    const double nx = clampd(pos.x, radius, arenaW - radius);
    const double ny = clampd(pos.y, radius, arenaH - radius);
    if (nx != pos.x) vel.x = 0.0;
    if (ny != pos.y) vel.y = 0.0;
    pos.x = nx;
    pos.y = ny;
}

bool withinArena(const Vec2& pos, double radius, double arenaW, double arenaH) {
    return pos.x >= radius && pos.x <= arenaW - radius && pos.y >= radius && pos.y <= arenaH - radius;
}

}  // namespace neon::game
