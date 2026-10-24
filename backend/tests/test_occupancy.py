import numpy as np
import pytest

from rover_vision.occupancy import DROP, FREE, HAZARD_BASE, OBSTACLE, UNKNOWN, GridSpec, RoverSpec, build_grid, corridors
from rover_vision.tasks import HAZARDS
from tests.scenes import camera, render_depth

SPEC = GridSpec()
ROVER = RoverSpec()


def grid_from(cam, depth):
    points, _ = cam.unproject_depth(depth)
    return build_grid(SPEC, ROVER, HAZARDS.names, points)


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
    grid = build_grid(SPEC, rover, HAZARDS.names, points)
    assert not (grid.codes == OBSTACLE).any()


def test_hole_is_a_drop():
    cam = camera(w=320, h=240)
    grid = grid_from(cam, render_depth(cam, holes=[(-0.4, 0.4, 1.0, 1.6, 0.3)]))
    assert (grid.codes == DROP).any()
    assert lane(corridors(grid, ROVER), 0).blocked_by == "drop"


def test_hazard_points_mark_cells_but_never_override_obstacles():
    water = np.array([[x, 0.0, z] for x in np.arange(-0.5, 0.5, 0.05) for z in np.arange(2.0, 2.5, 0.05)])
    rock = np.array([[0.0, 0.3, 2.2]] * 5)  # an obstacle point inside the water patch
    grid = build_grid(SPEC, ROVER, HAZARDS.names, rock, [(HAZARDS.class_id("water"), water)])
    water_code = HAZARD_BASE + HAZARDS.class_id("water")
    assert (grid.codes == water_code).sum() > 10
    rows, cols, _ = SPEC.cell_of(np.array([0.0]), np.array([2.2]))
    assert grid.codes[rows[0], cols[0]] == OBSTACLE
    assert grid.kind(water_code) == "water" and grid.legend()[water_code] == "water"
    assert lane(corridors(grid, ROVER), 0).blocked_by in {"water", "obstacle"}


def test_no_data_is_unknown_and_not_blocking():
    grid = build_grid(SPEC, ROVER, HAZARDS.names, None)
    assert (grid.codes == UNKNOWN).all()
    lanes = corridors(grid, ROVER)
    assert all(c.blocked_by is None and c.observed_m == 0 for c in lanes)
