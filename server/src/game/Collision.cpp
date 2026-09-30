#include "game/Collision.hpp"

#include <algorithm>
#include <cmath>

namespace neon::game {

bool segmentIntersectsCircle(const Vec2& a, const Vec2& b, const Vec2& centre, double radius) {
    const double abx = b.x - a.x;
    const double aby = b.y - a.y;
    const double acx = centre.x - a.x;
    const double acy = centre.y - a.y;
    const double abLenSq = abx * abx + aby * aby;
    if (abLenSq < 1e-12) {
        const double dx = centre.x - a.x;
        const double dy = centre.y - a.y;
        return dx * dx + dy * dy < radius * radius;
    }
    double t = (acx * abx + acy * aby) / abLenSq;
    t = clampd(t, 0.0, 1.0);
    const double px = a.x + t * abx;
    const double py = a.y + t * aby;
    const double dx = centre.x - px;
    const double dy = centre.y - py;
    return dx * dx + dy * dy < radius * radius;
}

void SpatialHash::configure(double width, double height, double cellSize) {
    cellSize_ = cellSize > 16.0 ? cellSize : 16.0;
    cols_ = std::max(1, static_cast<int>(std::ceil(width / cellSize_)));
    rows_ = std::max(1, static_cast<int>(std::ceil(height / cellSize_)));

    const std::size_t cells = static_cast<std::size_t>(cols_) * static_cast<std::size_t>(rows_);
    heads_.assign(cells, -1);
    next_.clear();
    ids_.clear();
    occupied_ = 0;

    // Reserving up front keeps `insert` free of allocation in the steady state.
    next_.reserve(cells);
    ids_.reserve(cells);
}

void SpatialHash::clear() {
    if (!heads_.empty()) {
        std::fill(heads_.begin(), heads_.end(), -1);
    }
    next_.clear();
    ids_.clear();
    occupied_ = 0;
}

void SpatialHash::insert(int id, const Vec2& pos, double radius) {
    int minCol = static_cast<int>(std::floor((pos.x - radius) / cellSize_));
    int maxCol = static_cast<int>(std::floor((pos.x + radius) / cellSize_));
    int minRow = static_cast<int>(std::floor((pos.y - radius) / cellSize_));
    int maxRow = static_cast<int>(std::floor((pos.y + radius) / cellSize_));
    minCol = std::max(0, minCol);
    minRow = std::max(0, minRow);
    maxCol = std::min(cols_ - 1, maxCol);
    maxRow = std::min(rows_ - 1, maxRow);

    for (int row = minRow; row <= maxRow; ++row) {
        for (int col = minCol; col <= maxCol; ++col) {
            const int cell = indexFor(col, row);
            if (heads_[cell] == -1) ++occupied_;
            const int slot = static_cast<int>(next_.size());
            next_.push_back(heads_[cell]);
            ids_.push_back(id);
            heads_[cell] = slot;
        }
    }
}

void SpatialHash::query(const Vec2& centre, double radius, std::vector<int>& out) const {
    out.clear();
    int minCol = static_cast<int>(std::floor((centre.x - radius) / cellSize_));
    int maxCol = static_cast<int>(std::floor((centre.x + radius) / cellSize_));
    int minRow = static_cast<int>(std::floor((centre.y - radius) / cellSize_));
    int maxRow = static_cast<int>(std::floor((centre.y + radius) / cellSize_));
    minCol = std::max(0, minCol);
    minRow = std::max(0, minRow);
    maxCol = std::min(cols_ - 1, maxCol);
    maxRow = std::min(rows_ - 1, maxRow);

    for (int row = minRow; row <= maxRow; ++row) {
        for (int col = minCol; col <= maxCol; ++col) {
            const int cell = indexFor(col, row);
            for (int slot = heads_[cell]; slot != -1;
                 slot = next_[static_cast<std::size_t>(slot)]) {
                out.push_back(ids_[static_cast<std::size_t>(slot)]);
            }
        }
    }
}

}  // namespace neon::game
