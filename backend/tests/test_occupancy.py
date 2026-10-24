import numpy as np
import pytest

from rover_vision.occupancy import DROP, FREE, OBSTACLE, UNKNOWN, GridSpec, RoverSpec, build_grid, corridors
from tests.scenes import camera, render_depth

SPEC = GridSpec()
ROVER = RoverSpec()


def grid_from(cam, depth):
    points, _ = cam.unproject_depth(depth)
    return build_grid(SPEC, ROVER, points)


def lane(lanes, bearing):
    return min(lanes, key=lambda c: abs(c.bearing_deg - bearing))


def test_flat_ground_is_free_and_every_corridor_clear():
    cam = camera(w=320, h=240)
    grid = grid_from(cam, render_depth(cam))
    assert (grid.codes == FREE).sum() > 50 and not (grid.codes == OBSTACLE).any()
    lanes = corridors(grid, ROVER)
    assert all(c.blocked_by is None for c in lanes)
    assert lane(lanes, 0).observed_m > 2.0


def test_wall_ahead_blocks_straight_with_correct_clearance_but_not_the_sides():
    cam = camera(w=320, h=240)
    grid = grid_from(cam, render_depth(cam, walls=[(-0.3, 0.3, 1.5, 0.5)]))
    lanes = corridors(grid, ROVER)
    ahead = lane(lanes, 0)
    assert ahead.blocked_by == "obstacle"
    assert ahead.clearance_m == pytest.approx(1.5, abs=0.15)
    assert lane(lanes, -30).blocked_by is None and lane(lanes, 30).blocked_by is None


def test_low_bump_is_climbable_and_overhead_is_ignored():
    rover = RoverSpec(max_step_m=0.08, clearance_height_m=0.6)
    points = np.array([[0.0, 0.05, 1.0]] * 10 + [[0.0, 1.2, 1.5]] * 10 + [[0.0, 0.0, 0.5]])
    grid = build_grid(SPEC, rover, points)
    assert not (grid.codes == OBSTACLE).any()


def test_hole_is_a_drop():
    cam = camera(w=320, h=240)
    grid = grid_from(cam, render_depth(cam, holes=[(-0.4, 0.4, 1.0, 1.6, 0.3)]))
    assert (grid.codes == DROP).any()
    assert lane(corridors(grid, ROVER), 0).blocked_by == "drop"


def test_legend():
    grid = build_grid(SPEC, ROVER, None)
    assert grid.legend() == {0: "unknown", 1: "free", 2: "obstacle", 3: "drop"}


def test_no_data_is_unknown_and_not_blocking():
    grid = build_grid(SPEC, ROVER, None)
    assert (grid.codes == UNKNOWN).all()
    lanes = corridors(grid, ROVER)
    assert all(c.blocked_by is None and c.observed_m == 0 for c in lanes)
