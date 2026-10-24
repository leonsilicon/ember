import base64

import numpy as np
import pytest

from rover_vision.detection import Detection
from rover_vision.perception import FrameInput, Perception, rotate_points_back, upright_turns
from rover_vision.spatial import Mount, up_from_mount
from rover_vision.tasks import HAZARDS, Role
from tests.scenes import camera, render_depth

W, H = 320, 240


def leaf_at(u, v, half=6, score=0.2):
    return Detection("leaves", "dry leaf", Role.TARGET, score, (u - half, v - half, u + half, v + half), (u, v), None)


@pytest.mark.parametrize("turns", [0, 1, 2, 3])
def test_rotate_points_back_inverts_rot90(turns):
    image = np.arange(5 * 7).reshape(5, 7)  # h=5, w=7
    rotated = np.rot90(image, turns)
    pts_rot = np.array([[0, 0], [rotated.shape[1] - 1, 1], [2, rotated.shape[0] - 1]])
    back = rotate_points_back(pts_rot, turns, (7, 5)).astype(int)
    for (ur, vr), (u, v) in zip(pts_rot, back):
        assert rotated[vr, ur] == image[v, u]


def test_upright_turns_from_roll():
    assert upright_turns(up_from_mount(Mount(10, 0))) == 0
    rolled = up_from_mount(Mount(10, 90))  # world up is towards the image's left edge
    turns = upright_turns(rolled)
    image = np.zeros((4, 6))
    image[:, 0] = 1  # left edge = up
    assert np.rot90(image, turns)[0].all()  # becomes the top row


class FakeHazards:
    def __init__(self, detections):
        self.detections = detections

    def __call__(self, image):
        return self.detections


def perceive(leaves, depth=True, hazards=(), height=None):
    cam = camera(pitch_deg=20, height_m=0.4, w=W, h=H)
    d = render_depth(cam, walls=[(0.6, 1.4, 1.2, 0.5)]) if depth else None
    p = Perception(FakeHazards(list(hazards)), None, mount=Mount(20, 0, camera_height_m=height))
    return p.perceive(FrameInput(np.zeros((H, W, 3), np.uint8), cam.intrinsics, depth_m=d, leaves=leaves)), cam


def test_leaf_positions_from_depth_and_from_ground_plane_agree():
    leaf = leaf_at(160, 200)
    with_depth, cam = perceive([leaf], depth=True)
    without, _ = perceive([leaf], depth=False, height=0.4)
    a, b = with_depth.leaves[0].position, without.leaves[0].position
    assert a.source == "depth" and b.source == "ground_plane"
    assert with_depth.height_source == "depth_fit" and with_depth.camera.height_m == pytest.approx(0.4, abs=0.02)
    assert a.distance_m == pytest.approx(b.distance_m, rel=0.05)
    expected = cam.pixels_to_ground(np.array([[160, 200]]))[0]
    assert b.z_m == pytest.approx(expected[2], rel=1e-6)


def test_leaf_behind_wall_is_unreachable_and_clear_leaf_is_suggested():
    behind = leaf_at(270, 120)  # right side, beyond the wall at z=1.2
    clear = leaf_at(100, 190)
    result, _ = perceive([behind, clear])
    by_box = {l.detection.box_xyxy: l for l in result.leaves}
    assert by_box[clear.box_xyxy].reachable
    blocked = by_box[behind.box_xyxy]
    assert blocked.position.x_m > 0
    if blocked.position.distance_m > 1.4:
        assert not blocked.reachable and blocked.blocked_by == "obstacle"
    assert result.suggestion.action == "drive_to_leaf"
    assert result.leaves[result.suggestion.leaf_index].detection is clear


def test_leaf_inside_water_is_not_reachable_and_water_blocks():
    water_poly = np.array([[40, 239], [280, 239], [280, 170], [40, 170]], dtype=np.float32)
    water = Detection("hazards", "water", Role.HAZARD, 0.8, (40, 170, 280, 239), (160, 239), water_poly)
    result, _ = perceive([leaf_at(160, 200)], hazards=[water])
    assert result.leaves[0].reachable is False and result.leaves[0].blocked_by == "in hazard"
    assert result.hazards[0].contact is not None and result.hazards[0].contact.source in {"depth", "ground_plane"}
    ahead = min(result.corridors, key=lambda c: abs(c.bearing_deg))
    assert ahead.blocked_by == "water"


def test_json_contract():
    result, _ = perceive([leaf_at(160, 200)])
    d = result.to_dict()
    assert d["schema"] == "rover-perception/1"
    assert set(d) >= {"image", "camera", "leaves", "hazards", "corridors", "grid", "suggestion", "timing_ms"}
    leaf = d["leaves"][0]
    assert set(leaf["position"]) == {"x_m", "y_m", "z_m", "distance_m", "bearing_deg", "source"}
    g = d["grid"]
    codes = np.frombuffer(base64.b64decode(g["codes_b64"]), np.uint8).reshape(g["rows"], g["cols"])
    assert codes.max() <= 3 + len(HAZARDS.names)
    assert "grid" not in result.to_dict(include_grid=False)


def test_no_leaves_explores_and_all_blocked_stops():
    result, _ = perceive([])
    assert result.suggestion.action == "explore"
    cam = camera(pitch_deg=20, height_m=0.4, w=W, h=H)
    wall = render_depth(cam, walls=[(-3, 3, 0.5, 1.0)])
    p = Perception(None, None, mount=Mount(20, 0))
    blocked = p.perceive(FrameInput(np.zeros((H, W, 3), np.uint8), cam.intrinsics, depth_m=wall, leaves=[]))
    assert blocked.suggestion.action == "stop"
