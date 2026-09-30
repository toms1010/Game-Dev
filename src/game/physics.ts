/**
 * Neon Vanguard — broad-phase and narrow-phase collision.
 *
 * The simulation runs a fixed 60 Hz tick, so broad-phase cost is the single
 * biggest lever on both client frame time and server tick time. Enemies live
 * in a uniform spatial hash; each projectile only tests entities in the cells
 * its swept segment touches.
 */

import type { Enemy } from './entities';

/**
 * Swept test: does the segment a→b pass within `r` of the circle (cx, cy, r)?
 * Projectiles move several times their own radius per tick at high bullet
 * speed, so a discrete overlap test would tunnel straight through enemies.
 */
export function segmentIntersectsCircle(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number, r: number,
): boolean {
  const abx = bx - ax, aby = by - ay;
  const acx = cx - ax, acy = cy - ay;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) return Math.hypot(cx - ax, cy - ay) < r;
  let t = (acx * abx + acy * aby) / abLenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + t * abx, py = ay + t * aby;
  return Math.hypot(cx - px, cy - py) < r;
}

export function circlesOverlap(
  ax: number, ay: number, ar: number,
  bx: number, by: number, br: number,
): boolean {
  const dx = bx - ax, dy = by - ay;
  const rr = ar + br;
  return dx * dx + dy * dy < rr * rr;
}

/**
 * Uniform spatial hash for broad-phase queries.
 *
 * Keyed by a single integer (`col + row * cols`) so buckets are a
 * `Map<number, T[]>` — no per-cell object allocation, no string keys.
 * The grid is cleared and rebuilt once per tick, which is cheaper than
 * incremental insert/remove bookkeeping at these entity counts.
 */
export class SpatialHash<T extends { x: number; y: number; r: number }> {
  private cellSize: number;
  private cols = 0;
  private rows = 0;
  private buckets: Map<number, T[]> = new Map();

  constructor(width: number, height: number, cellSize = 64) {
    this.cellSize = Math.max(16, cellSize);
    this.resize(width, height);
  }

  /**
   * Re-bases the grid on a new arena size. Called when the viewport reshapes
   * the arena; existing buckets are dropped because the game re-inserts every
   * entity at the start of the next tick anyway.
   */
  resize(width: number, height: number): void {
    this.cols = Math.max(1, Math.ceil(width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(height / this.cellSize));
    this.buckets.clear();
  }

  getKey(col: number, row: number): number {
    return col + row * this.cols;
  }

  clear(): void {
    this.buckets.clear();
  }

  /** Inserts an entity into every cell its bounding box intersects. */
  insert(entity: T): void {
    const minCol = Math.max(0, Math.floor((entity.x - entity.r) / this.cellSize));
    const maxCol = Math.min(this.cols - 1, Math.floor((entity.x + entity.r) / this.cellSize));
    const minRow = Math.max(0, Math.floor((entity.y - entity.r) / this.cellSize));
    const maxRow = Math.min(this.rows - 1, Math.floor((entity.y + entity.r) / this.cellSize));
    for (let c = minCol; c <= maxCol; c++) {
      for (let r = minRow; r <= maxRow; r++) {
        const key = this.getKey(c, r);
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(entity);
        else this.buckets.set(key, [entity]);
      }
    }
  }

  /**
   * Collects candidates overlapping the query circle into `out`.
   * May contain duplicates when an entity spans several queried cells —
   * callers break on first hit, so the redundant circle tests are free.
   */
  query(x: number, y: number, radius: number, out: T[]): T[] {
    out.length = 0;
    const minCol = Math.max(0, Math.floor((x - radius) / this.cellSize));
    const maxCol = Math.min(this.cols - 1, Math.floor((x + radius) / this.cellSize));
    const minRow = Math.max(0, Math.floor((y - radius) / this.cellSize));
    const maxRow = Math.min(this.rows - 1, Math.floor((y + radius) / this.cellSize));
    for (let c = minCol; c <= maxCol; c++) {
      for (let r = minRow; r <= maxRow; r++) {
        const bucket = this.buckets.get(this.getKey(c, r));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }

  getCellSize(): number { return this.cellSize; }
  getCols(): number { return this.cols; }
  getRows(): number { return this.rows; }
  getOccupiedBuckets(): Map<number, T[]> { return this.buckets; }
}

/**
 * Narrow phase: the closest enemy to a point, within `maxDist`.
 *
 * Used by the seeker (homing) weapon to pick a lock-on target. Iterates the
 * candidate cells only, so cost scales with local density rather than with
 * the total enemy count.
 */
export function nearestEnemy(
  grid: SpatialHash<Enemy>,
  fromX: number, fromY: number,
  maxDist: number,
  out: Enemy[],
): Enemy | null {
  grid.query(fromX, fromY, maxDist, out);
  let best: Enemy | null = null;
  let bestSq = maxDist * maxDist;
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.dead) continue;
    const dx = e.x - fromX, dy = e.y - fromY;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestSq) { bestSq = dSq; best = e; }
  }
  return best;
}
