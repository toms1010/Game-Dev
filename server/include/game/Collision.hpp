// Neon Vanguard — collision primitives and broad phase.
//
// Mirrors `src/game/physics.ts`. The spatial hash is a uniform grid keyed by
// `col + row * cols`; buckets are stored in a flat vector of indices rather
// than a map of vectors, which removes a pointer chase and a heap allocation
// per cell from the hot path.

#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "game/Vec.hpp"

namespace neon::game {

/**
 * Swept circle-vs-segment test.
 *
 * Projectiles move several body radii per tick, so a discrete overlap test
 * would let fast bullets tunnel straight through enemies. Colliding against
 * the whole swept segment is what makes hits reliable at 60 Hz.
 */
bool segmentIntersectsCircle(const Vec2& a, const Vec2& b, const Vec2& centre, double radius);

inline bool circlesOverlap(const Vec2& a, double ra, const Vec2& b, double rb) {
    const Vec2 d = b - a;
    const double r = ra + rb;
    return lengthSq(d) < r * r;
}

/**
 * Uniform spatial hash over a fixed arena.
 *
 * `rebuild()` is called once per tick: clearing and refilling is measurably
 * cheaper than incremental insert/remove at these entity counts, and it
 * removes any chance of the structure drifting out of sync with the world.
 */
class SpatialHash {
public:
    SpatialHash() = default;

    void configure(double width, double height, double cellSize);

    /// Re-bases the grid on a new arena, discarding every bucket. Callers must
    /// re-insert on the next tick; the game loop rebuilds wholesale anyway.
    void resize(double width, double height) { configure(width, height, cellSize_); }

    void clear();
    void insert(int id, const Vec2& pos, double radius);

    /// Appends candidate ids overlapping the query circle. May contain
    /// duplicates for entities spanning several cells; callers break on the
    /// first hit, so the extra narrow-phase tests are wasted but harmless.
    void query(const Vec2& centre, double radius, std::vector<int>& out) const;

    int cellCount() const { return cols_ * rows_; }
    int occupiedCells() const { return occupied_; }
    double cellSize() const { return cellSize_; }
    int cols() const { return cols_; }
    int rows() const { return rows_; }

private:
    int indexFor(int col, int row) const { return row * cols_ + col; }

    double cellSize_ = 64.0;
    int cols_ = 1;
    int rows_ = 1;
    int occupied_ = 0;

    // Buckets are an intrusive linked list over one flat vector: `heads_[cell]`
    // indexes `entries_`, and each entry links to the next entry in the same
    // cell. One vector instead of a map of vectors means one allocation and
    // no pointer chase per cell.
    std::vector<int> heads_;
    std::vector<int> next_;
    std::vector<int> ids_;
};

}  // namespace neon::game
