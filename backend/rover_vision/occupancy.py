"""Top-down map of where the rover can and can't drive.

A grid over the ground in front of the rover (rover frame, see
``spatial.py``), filled from depth. Each cell gets one code:

=====  ==========  ===================================================
code   kind        meaning
=====  ==========  ===================================================
0      unknown     not observed (no depth there)
1      free        ground seen at ground level
2      obstacle    something sticks up higher than the rover can climb
3      drop        ground falls away (ditch, hole, edge)
=====  ==========  ===================================================

Depth finds obstacles and drops geometrically, so it catches anything solid.
It can't see water (LiDAR returns little or nothing from it).

**Corridors** answer where *not* to go: for each steering bearing, how far
the rover, as a strip ``rover_width_m`` wide, can drive before hitting a
blocked cell.
"""

import math
from dataclasses import dataclass

import numpy as np

UNKNOWN, FREE, OBSTACLE, DROP = 0, 1, 2, 3
KINDS = ("unknown", "free", "obstacle", "drop")


@dataclass(frozen=True)
class RoverSpec:
    """Physical limits that decide what counts as blocked."""

    width_m: float = 0.45
    max_step_m: float = 0.08  # taller than this blocks
    max_dip_m: float = 0.10  # deeper than this is a drop
    clearance_height_m: float = 0.60  # ignore things higher than this (branches overhead)
    min_points_per_cell: int = 3  # depth points needed before a cell counts as obstacle or drop


@dataclass(frozen=True)
class GridSpec:
    resolution_m: float = 0.10
    x_min_m: float = -2.0
    x_max_m: float = 2.0
    z_max_m: float = 5.0  # the iPhone's LiDAR reaches about 5 m

    @property
    def shape(self) -> tuple[int, int]:
        """(rows along z from near to far, columns along x from left to right)."""
        return (
            round(self.z_max_m / self.resolution_m),
            round((self.x_max_m - self.x_min_m) / self.resolution_m),
        )

    def cell_of(self, x: np.ndarray, z: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Rover-frame x, z → (row, col, inside-grid mask)."""
        rows = np.floor(z / self.resolution_m).astype(int)
        cols = np.floor((x - self.x_min_m) / self.resolution_m).astype(int)
        n_rows, n_cols = self.shape
        inside = np.isfinite(x) & np.isfinite(z) & (rows >= 0) & (rows < n_rows) & (cols >= 0) & (cols < n_cols)
        return rows, cols, inside


@dataclass
class OccupancyGrid:
    spec: GridSpec
    codes: np.ndarray  # uint8, spec.shape

    def kind(self, code: int) -> str:
        return KINDS[code]

    def legend(self) -> dict[int, str]:
        return dict(enumerate(KINDS))

    def is_blocking(self, codes: np.ndarray) -> np.ndarray:
        return (codes == OBSTACLE) | (codes == DROP)


def build_grid(spec: GridSpec, rover: RoverSpec, depth_points: np.ndarray | None = None) -> OccupancyGrid:
    """``depth_points``: (N, 3) rover-frame points from depth."""
    n_rows, n_cols = spec.shape
    codes = np.zeros((n_rows, n_cols), dtype=np.uint8)

    if depth_points is not None and len(depth_points):
        x, y, z = depth_points[:, 0], depth_points[:, 1], depth_points[:, 2]
        rows, cols, inside = spec.cell_of(x, z)
        rows, cols, y = rows[inside], cols[inside], y[inside]
        flat = rows * n_cols + cols
        size = n_rows * n_cols

        def count(mask: np.ndarray) -> np.ndarray:
            return np.bincount(flat[mask], minlength=size).reshape(n_rows, n_cols)

        ground = count(np.abs(y) <= rover.max_step_m)
        tall = count((y > rover.max_step_m) & (y < rover.clearance_height_m))
        dip = count(y < -rover.max_dip_m)
        codes[ground > 0] = FREE
        codes[dip >= rover.min_points_per_cell] = DROP
        codes[tall >= rover.min_points_per_cell] = OBSTACLE

    return OccupancyGrid(spec, codes)


@dataclass(frozen=True)
class Corridor:
    bearing_deg: float
    clearance_m: float  # how far the rover can drive this way before something blocks it
    blocked_by: str | None  # what stops it; None if clear to the edge of the map
    observed_m: float  # how far ahead this way has actually been seen (free or blocked)

    def to_dict(self) -> dict:
        return {
            "bearing_deg": round(self.bearing_deg, 1),
            "clearance_m": round(self.clearance_m, 2),
            "blocked_by": self.blocked_by,
            "observed_m": round(self.observed_m, 2),
        }


def corridors(
    grid: OccupancyGrid,
    rover: RoverSpec,
    bearings_deg: np.ndarray = np.arange(-45.0, 45.1, 7.5),
    step_m: float = 0.05,
) -> list[Corridor]:
    """March a rover-wide strip out along each bearing and stop at the first
    blocking cell. Unknown cells don't block (beyond LiDAR range everything
    is unknown), but ``observed_m`` says how far the view actually reaches."""
    spec = grid.spec
    half = rover.width_m / 2
    lateral = np.arange(-half, half + 1e-9, spec.resolution_m / 2)
    # Far enough to leave the grid along any bearing; samples outside it are dropped below.
    max_range = math.hypot(max(abs(spec.x_min_m), spec.x_max_m), spec.z_max_m)
    distances = np.arange(step_m, max_range + 1e-9, step_m)

    result = []
    for bearing in bearings_deg:
        b = math.radians(bearing)
        forward = np.array([math.sin(b), math.cos(b)])  # (x, z)
        side = np.array([math.cos(b), -math.sin(b)])
        # (distances, lateral offsets) sample points across the strip
        xs = distances[:, None] * forward[0] + lateral[None, :] * side[0]
        zs = distances[:, None] * forward[1] + lateral[None, :] * side[1]
        rows, cols, inside = spec.cell_of(xs, zs)
        codes = np.where(inside, grid.codes[np.clip(rows, 0, spec.shape[0] - 1), np.clip(cols, 0, spec.shape[1] - 1)], UNKNOWN)

        in_map = inside.all(axis=1)
        blocked_rows = np.flatnonzero(grid.is_blocking(codes).any(axis=1) & in_map)
        observed_rows = np.flatnonzero((codes != UNKNOWN).any(axis=1) & in_map)
        last_in_map = distances[in_map][-1] if in_map.any() else 0.0

        if blocked_rows.size:
            i = blocked_rows[0]
            row_codes = codes[i][grid.is_blocking(codes[i])]
            values, counts = np.unique(row_codes, return_counts=True)
            clearance = max(0.0, distances[i] - step_m)
            blocked_by = grid.kind(int(values[counts.argmax()]))
        else:
            clearance, blocked_by = float(last_in_map), None
        observed = float(distances[observed_rows[-1]]) if observed_rows.size else 0.0
        result.append(Corridor(float(bearing), float(clearance), blocked_by, min(observed, float(last_in_map))))
    return result
