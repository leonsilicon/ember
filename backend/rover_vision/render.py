"""Drawing leaf boxes onto BGR frames."""

from collections.abc import Sequence

import cv2
import numpy as np

from rover_vision.detection import Detection

LEAF_COLOR = (0, 140, 255)  # BGR orange
REJECTED_COLOR = (150, 150, 150)  # grey: ruled out by depth (not on the ground, wrong size)
FONT = cv2.FONT_HERSHEY_SIMPLEX


def draw_detections(frame: np.ndarray, detections: Sequence[Detection], color=LEAF_COLOR) -> np.ndarray:
    """Returns a new frame with each box, its label and a cross at its centre."""
    out = frame.copy()
    for det in detections:
        x1, y1, x2, y2 = det.box_xyxy
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        draw_label(out, f"{det.label} {det.confidence:.2f}", (x1, y1), color)
        cv2.drawMarker(out, det.point_px, (255, 255, 255), cv2.MARKER_CROSS, 18, 2)
    return out


def draw_label(img: np.ndarray, text: str, corner: tuple[int, int], color: tuple[int, int, int]):
    (tw, th), baseline = cv2.getTextSize(text, FONT, 0.5, 1)
    x, y = corner
    y = max(y, th + baseline + 2)  # keep labels on-screen for boxes touching the top edge
    cv2.rectangle(img, (x, y - th - baseline - 2), (x + tw + 4, y), color, -1)
    cv2.putText(img, text, (x + 2, y - baseline), FONT, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
