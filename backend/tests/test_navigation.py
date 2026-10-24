import numpy as np
import pytest
import torch

from rover_vision.detection import Detection
from rover_vision.leaves import to_detections
from rover_vision.navigation import NavConfig, decide, draw_navigation, evaluate_sectors, pixel_to_angle
from rover_vision.tasks import Role

W, H = 700, 400
SHAPE = (H, W, 3)
CFG = NavConfig(sectors=7, hfov_deg=70)


def hazard(label, box, polygon=None):
    x1, y1, x2, y2 = box
    return Detection("hazards", label, Role.HAZARD, 0.9, box, (x1, y2), polygon)


def leaf(x, y, conf=0.5, half=10):
    return Detection("leaves", "dry leaf", Role.TARGET, conf, (x - half, y - half, x + half, y + half), (x, y), None)


def test_pixel_to_angle_centre_edges_and_sign():
    assert pixel_to_angle(W / 2, W, 70) == pytest.approx(0)
    assert pixel_to_angle(W, W, 70) == pytest.approx(35)
    assert pixel_to_angle(0, W, 70) == pytest.approx(-35)


def test_hazard_in_near_band_blocks_only_its_sector():
    water = hazard("water", (0, 250, 99, 399))  # covers sector 0's near band
    sectors = evaluate_sectors(SHAPE, [water], cfg=CFG)
    assert sectors[0].blocked_by == "water"
    assert not any(s.blocked for s in sectors[1:])


def test_far_hazard_does_not_block():
    rock = hazard("rock", (300, 10, 399, 120))  # above the near band: still far away
    assert not any(s.blocked for s in evaluate_sectors(SHAPE, [rock], cfg=CFG))


def test_polygon_hazard_uses_its_shape():
    tri = np.array([[300, 399], [399, 399], [399, 300]], dtype=np.float32)
    sectors = evaluate_sectors(SHAPE, [hazard("rock", (300, 300, 399, 399), tri)], cfg=CFG)
    assert 0 < sectors[3].hazard_frac < 0.5


def test_depth_blocks_close_sectors_and_ignores_missing_readings():
    depth = np.full((H, W), 3.0, np.float32)
    depth[:, 600:] = 0.3  # wall close on the right
    depth[:, :100] = 0.0  # no readings on the left
    sectors = evaluate_sectors(SHAPE, [], depth, CFG)
    assert sectors[6].blocked_by.startswith("depth")
    assert sectors[0].clearance_m is None and not sectors[0].blocked
    assert sectors[3].clearance_m == pytest.approx(3.0)


def test_drives_to_nearest_reachable_leaf():
    far, near = leaf(350, 220), leaf(500, 350)
    d = decide(SHAPE, [far, near], [], cfg=CFG)
    assert d.action == "drive_to_target" and d.target is near
    assert d.angle_deg == pytest.approx(pixel_to_angle(500, W, 70))


def test_depth_decides_nearest_when_available():
    a, b = leaf(150, 300), leaf(550, 300)
    depth = np.full((H, W), 2.0, np.float32)
    depth[290:311, 540:561] = 0.9
    d = decide(SHAPE, [a, b], [], depth, CFG)
    assert d.target is b and d.to_payload()["distance_cm"] == 90


def test_skips_leaves_in_hazards_or_blocked_sectors():
    water = hazard("water", (0, 250, 199, 399))
    on_water, behind_water, clear = leaf(50, 380), leaf(150, 260), leaf(400, 260)
    d = decide(SHAPE, [on_water, behind_water, clear], [water], cfg=CFG)
    assert d.target is clear


def test_explores_straightest_open_direction_without_leaves():
    rock = hazard("rock", (300, 250, 399, 399))  # blocks the centre sector
    d = decide(SHAPE, [], [rock], cfg=CFG)
    assert d.action == "explore" and d.target is None
    assert abs(d.angle_deg) == pytest.approx(abs(evaluate_sectors(SHAPE, [], cfg=CFG)[2].angle_deg))


def test_stops_when_everything_is_blocked():
    wall = hazard("structure", (0, 200, W - 1, H - 1))
    d = decide(SHAPE, [leaf(350, 300)], [wall], cfg=CFG)
    assert d.action == "stop" and d.angle_deg is None
    payload = d.to_payload()
    assert len(payload["blocked"]) == 7 and "target" not in payload


def test_overlay_renders_without_mutating_input():
    frame = np.zeros(SHAPE, np.uint8)
    out = draw_navigation(frame, decide(SHAPE, [leaf(350, 300)], [hazard("rock", (0, 250, 99, 399))], cfg=CFG), CFG)
    assert frame.sum() == 0 and out.sum() > 0


def test_owlvit_output_to_detections_thresholds_sorts_and_clamps():
    raw = {
        "scores": torch.tensor([0.02, 0.30, 0.10]),
        "labels": torch.tensor([0, 2, 1]),
        "boxes": torch.tensor([[0, 0, 5, 5], [-10, 5, 50, 900], [10, 10, 30, 30]], dtype=torch.float32),
    }
    dets = to_detections(raw, threshold=0.05, frame_shape=SHAPE)
    assert [round(d.confidence, 2) for d in dets] == [0.3, 0.1]
    assert dets[0].box_xyxy == (0, 5, 50, H - 1) and dets[0].role is Role.TARGET
    assert dets[0].label == "dry leaf"
