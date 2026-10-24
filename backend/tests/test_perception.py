import base64

import numpy as np
import pytest

from rover_vision.detection import Detection
from rover_vision.perception import FrameInput, Perception, rotate_points_back, upright_turns
from rover_vision.spatial import Mount, up_from_mount
from tests.scenes import camera, render_depth

W, H = 320, 240


def leaf_at(u, v, half=6, score=0.2):
    return Detection.from_box("dry leaf", score, (u - half, v - half, u + half, v + half))


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


def perceive(leaves, depth=True, height=None, walls=((0.6, 1.4, 1.2, 0.5),), pitch=20):
    cam = camera(pitch_deg=pitch, height_m=0.4, w=W, h=H)
    d = render_depth(cam, walls=list(walls)) if depth else None
    p = Perception(None, mount=Mount(pitch, 0, camera_height_m=height))
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
    blocked = by_box.get(behind.box_xyxy)
    if blocked is not None and blocked.position.distance_m > 1.4:
        assert not blocked.reachable and blocked.blocked_by == "obstacle"
    assert result.suggestion.action == "drive_to_leaf"
    assert result.leaves[result.suggestion.leaf_index].detection == clear


def test_depth_rejects_a_leaf_up_on_a_wall():
    # A wall 1.2 m ahead, 1 m tall: a box high on it is ~0.6 m off the ground.
    on_wall = leaf_at(160, 60)
    on_ground = leaf_at(160, 225)
    result, _ = perceive([on_wall, on_ground], walls=((-2, 2, 1.2, 1.0),), pitch=5)
    assert [(r.detection, r.reason) for r in result.rejected] == [(on_wall, "off_ground")]
    assert result.rejected[0].position.y_m == pytest.approx(0.6, abs=0.05)
    assert [l.detection for l in result.leaves] == [on_ground]


def test_depth_rejects_boxes_too_big_for_a_leaf_pile():
    # Full-width box around the image centre, ~1.1 m out on open ground: ~1.6 m across.
    huge = Detection.from_box("leaf pile", 0.2, (0, 100, 319, 140))
    pile = Detection.from_box("leaf pile", 0.2, (100, 100, 220, 140))  # ~0.6 m: a real pile
    result, _ = perceive([huge, pile], walls=())
    assert [(r.detection, r.reason) for r in result.rejected] == [(huge, "too_big")]
    assert [l.detection for l in result.leaves] == [pile]


def test_json_contract():
    result, _ = perceive([leaf_at(160, 200)])
    d = result.to_dict()
    assert d["schema"] == "rover-perception/2"
    assert set(d) >= {"image", "camera", "leaves", "rejected", "corridors", "grid", "suggestion", "timing_ms"}
    leaf = d["leaves"][0]
    assert set(leaf["position"]) == {"x_m", "y_m", "z_m", "distance_m", "bearing_deg", "source"}
    assert 0.02 < leaf["size_m"] < 0.3
    g = d["grid"]
    codes = np.frombuffer(base64.b64decode(g["codes_b64"]), np.uint8).reshape(g["rows"], g["cols"])
    assert codes.max() <= 3
    assert "grid" not in result.to_dict(include_grid=False)


def test_no_leaves_explores_and_all_blocked_stops():
    result, _ = perceive([])
    assert result.suggestion.action == "explore"
    blocked, _ = perceive([], walls=((-3, 3, 0.5, 1.0),))
    assert blocked.suggestion.action == "stop"
