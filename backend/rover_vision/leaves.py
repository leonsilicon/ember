"""Adapter from the OWL-ViT leaf detector (``leaf_detector.py``) to the
shared :class:`Detection` records used by navigation and rendering."""

import numpy as np

from rover_vision import leaf_detector
from rover_vision.detection import Detection
from rover_vision.tasks import Role

TASK_NAME = "leaves"


class LeafDetector:
    """Callable wrapper: ``frame -> [Detection]`` above ``threshold``.

    OWL-ViT takes ~1.5 s per frame on an M-series GPU (2x2 tiles), so the
    navigation loop runs it in the background and reuses the latest result.
    """

    def __init__(self, threshold: float = 0.05, tile_grid: int = 2, max_detections: int = 20):
        self.threshold = threshold
        self.tile_grid = tile_grid
        self.max_detections = max_detections
        self._model = leaf_detector.load_detector()

    @property
    def device(self) -> str:
        return self._model[3]

    def __call__(self, frame: np.ndarray) -> list[Detection]:
        raw = leaf_detector.detect(frame, self._model, self.tile_grid)
        return to_detections(raw, self.threshold, frame.shape, self.max_detections)


def query_label(label_id: int) -> str:
    labels, queries = leaf_detector.QUERY_LABELS, leaf_detector.TEXT_QUERIES
    return labels[label_id] if label_id < len(labels) else queries[label_id]


def to_detections(raw: dict, threshold: float, frame_shape: tuple, limit: int = 20) -> list[Detection]:
    """``{"scores", "labels", "boxes"}`` tensors → detections, strongest first.
    The key point is the box centre (OWL-ViT gives boxes, not masks)."""
    h, w = frame_shape[:2]
    scores = raw["scores"].tolist()
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    detections = []
    for i in order:
        if scores[i] < threshold or len(detections) >= limit:
            break
        x1, y1, x2, y2 = (int(round(v)) for v in raw["boxes"][i].tolist())
        x1, x2 = max(0, min(x1, w - 1)), max(0, min(x2, w - 1))
        y1, y2 = max(0, min(y1, h - 1)), max(0, min(y2, h - 1))
        detections.append(
            Detection(
                task=TASK_NAME,
                label=query_label(int(raw["labels"][i])),
                role=Role.TARGET,
                confidence=float(scores[i]),
                box_xyxy=(x1, y1, x2, y2),
                point_px=((x1 + x2) // 2, (y1 + y2) // 2),
                polygon_px=None,
            )
        )
    return detections
