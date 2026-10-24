from types import SimpleNamespace

import numpy as np
import torch

from rover_vision.detection import detections_from_result
from rover_vision.render import draw_detections, draw_hud
from rover_vision.tasks import HAZARDS, Role
from tests.conftest import TOY


class FakeBoxes(SimpleNamespace):
    def __len__(self):
        return len(self.xyxy)


def result_with(names, boxes, classes, confs, polygons):
    """Minimal stand-in for an Ultralytics ``Results`` object."""
    return SimpleNamespace(
        names=dict(enumerate(names)),
        boxes=FakeBoxes(
            xyxy=torch.tensor(boxes, dtype=torch.float32).reshape(-1, 4),
            cls=torch.tensor(classes, dtype=torch.float32),
            conf=torch.tensor(confs, dtype=torch.float32),
        ),
        masks=SimpleNamespace(xy=[np.array(p, dtype=np.float32) for p in polygons]) if polygons else None,
    )


RECT = [[10, 10], [50, 10], [50, 40], [10, 40]]


def test_target_uses_centroid_and_hazard_uses_ground_contact():
    target = detections_from_result(result_with(TOY.names, [[10, 10, 50, 40]], [0], [0.9], [RECT]), TOY)
    hazard = detections_from_result(result_with(HAZARDS.names, [[10, 10, 50, 40]], [1], [0.8], [RECT]), HAZARDS)
    assert target[0].role is Role.TARGET and target[0].point_px == (30, 25)
    assert hazard[0].label == "rock" and hazard[0].point_px == (30, 40)


def test_falls_back_to_box_without_masks():
    dets = detections_from_result(result_with(HAZARDS.names, [[0, 0, 20, 10]], [0], [0.5], None), HAZARDS)
    assert dets[0].polygon_px is None and dets[0].point_px == (10, 10)


def test_no_boxes_means_no_detections():
    assert detections_from_result(result_with(TOY.names, [], [], [], None), TOY) == []


def test_to_dict_is_json_ready_and_render_does_not_mutate_input():
    det = detections_from_result(result_with(TOY.names, [[10, 10, 50, 40]], [2], [0.7], [RECT]), TOY)[0]
    d = det.to_dict(include_polygon=True)
    assert d["role"] == "avoid" and d["polygon_px"][0] == [10, 10]

    frame = np.zeros((60, 60, 3), np.uint8)
    out = draw_hud(draw_detections(frame, [det]), 30.0, [det])
    assert frame.sum() == 0 and out.sum() > 0
