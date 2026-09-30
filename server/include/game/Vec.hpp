// Neon Vanguard — 2D vector math.
//
// Header-only and allocation free; every function is inline and operates on
// plain doubles. Vectorised over the whole simulation, these must stay
// branch-light.

#pragma once

#include <cmath>

namespace neon::game {

struct Vec2 {
    double x = 0.0;
    double y = 0.0;

    constexpr Vec2() = default;
    constexpr Vec2(double x_, double y_) : x(x_), y(y_) {}

    Vec2& operator+=(const Vec2& o) { x += o.x; y += o.y; return *this; }
    Vec2& operator-=(const Vec2& o) { x -= o.x; y -= o.y; return *this; }
    Vec2& operator*=(double s) { x *= s; y *= s; return *this; }
};

inline constexpr Vec2 operator+(Vec2 a, const Vec2& b) { return {a.x + b.x, a.y + b.y}; }
inline constexpr Vec2 operator-(Vec2 a, const Vec2& b) { return {a.x - b.x, a.y - b.y}; }
inline constexpr Vec2 operator*(Vec2 a, double s) { return {a.x * s, a.y * s}; }
inline constexpr Vec2 operator*(double s, Vec2 a) { return {a.x * s, a.y * s}; }
inline constexpr Vec2 operator-(Vec2 a) { return {-a.x, -a.y}; }

inline double dot(const Vec2& a, const Vec2& b) { return a.x * b.x + a.y * b.y; }
inline double lengthSq(const Vec2& a) { return a.x * a.x + a.y * a.y; }
inline double length(const Vec2& a) { return std::sqrt(a.x * a.x + a.y * a.y); }

/// Normalises, returning `fallback` for a zero-length vector.
inline Vec2 normalized(const Vec2& a, Vec2 fallback = {1.0, 0.0}) {
    const double len = length(a);
    if (len < 1e-9) return fallback;
    return {a.x / len, a.y / len};
}

/// Clamps magnitude to at most `max` without changing direction.
inline Vec2 clampLength(const Vec2& a, double max) {
    const double lenSq = lengthSq(a);
    if (lenSq <= max * max || lenSq < 1e-18) return a;
    const double scale = max / std::sqrt(lenSq);
    return {a.x * scale, a.y * scale};
}

inline bool isFinite(const Vec2& a) { return std::isfinite(a.x) && std::isfinite(a.y); }

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

}  // namespace neon::game
