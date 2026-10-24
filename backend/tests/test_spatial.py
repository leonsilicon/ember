import math

import numpy as np
import pytest

from rover_vision.spatial import (
    Intrinsics,
    Mount,
    RoverCamera,
    bearing_deg,
    estimate_camera_height,
    up_from_arkit_pose,
    up_from_mount,
)
from tests.scenes import camera, render_depth


def column_major(m: np.ndarray) -> list[float]:
    return m.T.reshape(-1).tolist()


def test_up_from_mount_level_pitched_and_rolled():
    assert np.allclose(up_from_mount(Mount(0, 0)), [0, -1, 0])
    assert np.allclose(up_from_mount(Mount(90, 0)), [0, 0, -1])  # looking straight down
    assert np.allclose(up_from_mount(Mount(0, 90)), [-1, 0, 0])  # rolled clockwise 90°


def test_up_from_arkit_pose_matches_mount_for_the_same_tilt():
    assert np.allclose(up_from_arkit_pose(column_major(np.eye(4))), [0, -1, 0])
    p = math.radians(25)  # camera pitched down: rotate about ARKit x by -25°
    rx = np.array([[1, 0, 0, 0], [0, math.cos(-p), -math.sin(-p), 0], [0, math.sin(-p), math.cos(-p), 0], [0, 0, 0, 1]])
    assert np.allclose(up_from_arkit_pose(column_major(rx)), up_from_mount(Mount(25, 0)))


@pytest.mark.parametrize("pitch,roll", [(0, 0), (30, 0), (20, 15), (10, 90), (90, 0)])
def test_basis_is_orthonormal_with_up_first_and_level_forward(pitch, roll):
    cam = RoverCamera(Intrinsics.from_hfov(100, 80, 60), up_from_mount(Mount(pitch, roll)), 0.3)
    b = cam.basis
    assert np.allclose(b @ b.T, np.eye(3), atol=1e-9)
    assert np.allclose(b[1], cam.up)
    assert cam.pitch_deg == pytest.approx(pitch, abs=1e-6)


def test_rolled_camera_right_axis_points_to_rover_right():
    # Phone on its side, rolled 90° clockwise: image "up" (-v) is the rover's
    # right, so a point at the image top must come out at positive x.
    cam = RoverCamera(Intrinsics.from_hfov(100, 100, 60), up_from_mount(Mount(10, 90)), 0.3)
    top, bottom = cam.pixels_to_ground(np.array([[80, 2], [80, 98]]))
    assert top[0] > 0 > bottom[0]


def test_pixels_to_ground_centre_ray_and_horizon():
    cam = camera(pitch_deg=20, height_m=0.4)
    k = cam.intrinsics
    centre, above = cam.pixels_to_ground(np.array([[k.cx, k.cy], [k.cx, 0]]))
    assert centre[2] == pytest.approx(0.4 / math.tan(math.radians(20)), rel=1e-6)
    assert centre[0] == pytest.approx(0) and centre[1] == pytest.approx(0)
    assert np.isnan(above).all()  # top row of a 70°-wide view pitched 20° looks above the horizon


def test_unprojected_ground_depth_lands_on_the_ground():
    cam = camera()
    points, pixels = cam.unproject_depth(render_depth(cam))
    assert len(points) > 1000 and pixels.shape == (len(points), 2)
    assert np.abs(points[:, 1]).max() < 1e-4


def test_unproject_skips_invalid_and_low_confidence():
    cam = camera(w=4, h=3)
    depth = np.ones((3, 4), np.float32)
    depth[0, 0] = 0
    depth[0, 1] = np.nan
    conf = np.full((3, 4), 2, np.uint8)
    conf[2, 3] = 0
    points, _ = cam.unproject_depth(depth, conf)
    assert len(points) == 12 - 3


def test_estimate_camera_height_from_ground_and_clutter():
    cam = camera(height_m=0.37)
    relative = RoverCamera(cam.intrinsics, cam.up, 0.0)
    points, _ = relative.unproject_depth(render_depth(cam, walls=[(-0.2, 0.3, 1.2, 0.4)]))
    assert estimate_camera_height(points) == pytest.approx(0.37, abs=0.02)
    assert estimate_camera_height(points[:50]) is None


def test_bearing_sign_and_no_negative_zero():
    assert bearing_deg(1, 1) == pytest.approx(45)
    assert bearing_deg(-1, 1) == pytest.approx(-45)
    assert str(bearing_deg(-0.0, 1)) == "0.0"
