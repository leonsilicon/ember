"""Model output → plain detection records.

This is the shape the iPhone app produces too. The app then samples LiDAR
depth at ``point_px`` to get the (X, Y, Z) it sends to the Pi:

- targets: ``point_px`` is the mask centroid, where the gripper aims.
- hazards: ``point_px`` is the mask's lowest point, where the obstacle meets
  the ground closest to the rover.
"""

from dataclasses import dataclass

import numpy as np

from rover_vision.geometry import Point, polygon_centroid, polygon_contact_point
from rover_vision.tasks import Role, TaskSpec


@dataclass(frozen=True)
class Detection:
    task: str
    label: str
    role: Role
    confidence: float
    box_xyxy: tuple[int, int, int, int]
    point_px: Point
    polygon_px: np.ndarray | None  # (N, 2) in frame pixels

    def to_dict(self, include_polygon: bool = False) -> dict:
        d = {
            "task": self.task,
            "label": self.label,
            "role": self.role.value,
            "confidence": round(self.confidence, 3),
            "box_xyxy": list(self.box_xyxy),
            "point_px": list(self.point_px),
        }
        if include_polygon and self.polygon_px is not None:
            d["polygon_px"] = self.polygon_px.round().astype(int).tolist()
        return d


def key_point(role: Role, polygon: np.ndarray | None, box: tuple[int, int, int, int]) -> Point:
    x1, y1, x2, y2 = box
    if role is Role.HAZARD:
        return polygon_contact_point(polygon) or ((x1 + x2) // 2, y2)
    return polygon_centroid(polygon) or ((x1 + x2) // 2, (y1 + y2) // 2)


def detections_from_result(result, task: TaskSpec) -> list[Detection]:
    """Convert one Ultralytics ``Results`` object into detections.

    Uses ``masks.xy``, which Ultralytics has already mapped back to
    original-frame pixels (undoing the letterbox), rather than the raw
    model-resolution mask tensor.
    """
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return []
    polygons = result.masks.xy if result.masks is not None else [None] * len(boxes)

    detections = []
    for box, cls, conf, polygon in zip(
        boxes.xyxy.cpu().numpy(), boxes.cls.cpu().numpy(), boxes.conf.cpu().numpy(), polygons
    ):
        label = result.names[int(cls)]
        role = task.role_of(label)
        polygon = polygon if polygon is not None and len(polygon) >= 3 else None
        box_int = tuple(int(round(v)) for v in box)
        detections.append(
            Detection(
                task=task.name,
                label=label,
                role=role,
                confidence=float(conf),
                box_xyxy=box_int,
                point_px=key_point(role, polygon, box_int),
                polygon_px=polygon,
            )
        )
    return detections
