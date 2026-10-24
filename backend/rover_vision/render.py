"""Drawing detections onto BGR frames."""

from collections import Counter
from collections.abc import Sequence

import cv2
import numpy as np

from rover_vision.detection import Detection
from rover_vision.tasks import Role

# BGR
ROLE_COLORS = {
    Role.TARGET: (0, 140, 255),  # orange: pick up
    Role.AVOID: (80, 200, 80),  # green: leave alone
    Role.HAZARD: (40, 40, 230),  # red: don't drive into
}
# Grasp point, plain centroid, ground contact.
ROLE_MARKERS = {
    Role.TARGET: cv2.MARKER_CROSS,
    Role.AVOID: cv2.MARKER_DIAMOND,
    Role.HAZARD: cv2.MARKER_TRIANGLE_DOWN,
}
FONT = cv2.FONT_HERSHEY_SIMPLEX


def draw_detections(frame: np.ndarray, detections: Sequence[Detection], mask_alpha: float = 0.35) -> np.ndarray:
    """Returns a new frame with translucent masks, boxes, labels and key
    points (see ``ROLE_MARKERS``)."""
    overlay = frame.copy()
    for det in detections:
        if det.polygon_px is not None:
            cv2.fillPoly(overlay, [det.polygon_px.astype(np.int32)], ROLE_COLORS[det.role])
    out = cv2.addWeighted(overlay, mask_alpha, frame, 1 - mask_alpha, 0)

    for det in detections:
        color = ROLE_COLORS[det.role]
        x1, y1, x2, y2 = det.box_xyxy
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        _draw_label(out, f"{det.label} {det.confidence:.2f}", (x1, y1), color)
        cv2.drawMarker(out, det.point_px, (255, 255, 255), ROLE_MARKERS[det.role], 18, 2)
    return out


def _draw_label(img: np.ndarray, text: str, corner: tuple[int, int], color: tuple[int, int, int]):
    (tw, th), baseline = cv2.getTextSize(text, FONT, 0.5, 1)
    x, y = corner
    y = max(y, th + baseline + 2)  # keep labels on-screen for boxes touching the top edge
    cv2.rectangle(img, (x, y - th - baseline - 2), (x + tw + 4, y), color, -1)
    cv2.putText(img, text, (x + 2, y - baseline), FONT, 0.5, (0, 0, 0), 1, cv2.LINE_AA)


def draw_hud(frame: np.ndarray, fps: float | None, detections: Sequence[Detection]) -> np.ndarray:
    """Status line along the bottom edge, clear of box labels at the top."""
    counts = Counter(d.role for d in detections)
    parts = [f"{fps:.1f} FPS"] if fps else []
    parts += [f"{role.value}: {counts[role]}" for role in Role if counts[role]]
    if not parts:
        return frame
    text = "  ".join(parts)
    origin = (10, frame.shape[0] - 12)
    cv2.putText(frame, text, origin, FONT, 0.65, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(frame, text, origin, FONT, 0.65, (255, 255, 255), 1, cv2.LINE_AA)
    return frame
