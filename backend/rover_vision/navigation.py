"""A suggested next move, and drawing perception results.

The suggestion is a convenience; the app is free to plan its own route from
the corridors and grid:

- ``drive_to_leaf``: the nearest reachable leaf, with bearing and distance;
- ``explore``: no reachable leaf, so head the straightest way that's open
  for at least ``min_explore_m``;
- ``stop``: nothing is open far enough.
"""

import math
from dataclasses import dataclass

import cv2
import numpy as np

from rover_vision.occupancy import DROP, FREE, OBSTACLE, Corridor, OccupancyGrid
from rover_vision.render import LEAF_COLOR, REJECTED_COLOR, draw_detections


@dataclass(frozen=True)
class Suggestion:
    action: str  # "drive_to_leaf" | "explore" | "stop"
    bearing_deg: float | None = None
    distance_m: float | None = None
    leaf_index: int | None = None  # into PerceptionResult.leaves

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "bearing_deg": None if self.bearing_deg is None else round(self.bearing_deg, 1),
            "distance_m": None if self.distance_m is None else round(self.distance_m, 2),
            "leaf_index": self.leaf_index,
        }


def suggest(leaves, lanes: list[Corridor], min_explore_m: float = 0.8) -> Suggestion:
    reachable = [(leaf.position.distance_m, -leaf.detection.confidence, i) for i, leaf in enumerate(leaves) if leaf.reachable]
    if reachable:
        _, _, i = min(reachable)
        position = leaves[i].position
        return Suggestion("drive_to_leaf", position.bearing_deg, position.distance_m, i)

    open_lanes = [c for c in lanes if c.clearance_m >= min_explore_m]
    if open_lanes:
        lane = min(open_lanes, key=lambda c: (abs(c.bearing_deg), -c.clearance_m))
        return Suggestion("explore", lane.bearing_deg, lane.clearance_m)
    return Suggestion("stop")


# --- drawing -------------------------------------------------------------------

# BGR
CELL_COLORS = {0: (45, 45, 45), FREE: (70, 150, 70), OBSTACLE: (40, 40, 220), DROP: (160, 40, 160)}


def grid_image(grid: OccupancyGrid, cell_px: int = 5) -> np.ndarray:
    """Top-down map, far side at the top, rover at the bottom centre."""
    rows, cols = grid.codes.shape
    image = np.zeros((rows, cols, 3), np.uint8)
    for code in np.unique(grid.codes):
        image[grid.codes == code] = CELL_COLORS[int(code)]
    image = np.flipud(image)  # row 0 (nearest) to the bottom
    return cv2.resize(image, (cols * cell_px, rows * cell_px), interpolation=cv2.INTER_NEAREST)


def draw_minimap(result, cell_px: int = 5) -> np.ndarray:
    """Grid + corridor fan + leaves + suggested heading, in rover-frame metres."""
    grid = result.grid
    spec = grid.spec
    image = grid_image(grid, cell_px)
    h, w = image.shape[:2]
    scale = cell_px / spec.resolution_m  # px per metre

    def to_px(x: float, z: float) -> tuple[int, int]:
        return int((x - spec.x_min_m) * scale), int(h - z * scale)

    origin = to_px(0.0, 0.0)
    for lane in result.corridors:
        b = math.radians(lane.bearing_deg)
        end = to_px(lane.clearance_m * math.sin(b), lane.clearance_m * math.cos(b))
        cv2.line(image, origin, end, (200, 200, 200) if lane.blocked_by is None else (90, 90, 255), 1, cv2.LINE_AA)
    for leaf in result.leaves:
        color = LEAF_COLOR if leaf.reachable else REJECTED_COLOR
        cv2.circle(image, to_px(leaf.position.x_m, leaf.position.z_m), 4, color, -1, cv2.LINE_AA)
    s = result.suggestion
    if s.bearing_deg is not None:
        reach = min(s.distance_m or 1.5, spec.z_max_m)
        b = math.radians(s.bearing_deg)
        cv2.arrowedLine(image, origin, to_px(reach * math.sin(b), reach * math.cos(b)), (255, 255, 255), 2, cv2.LINE_AA, tipLength=0.15)
    cv2.rectangle(image, (origin[0] - 6, h - 6), (origin[0] + 6, h - 1), (255, 255, 255), -1)  # the rover
    for metres in range(1, int(spec.z_max_m) + 1):  # range rings
        cv2.putText(image, f"{metres}m", (2, int(h - metres * scale) + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (200, 200, 200), 1)
    return image


def draw_perception(frame: np.ndarray, result) -> np.ndarray:
    """Camera view with detections, the suggestion, and the minimap inset."""
    out = draw_detections(frame, [r.detection for r in result.rejected], REJECTED_COLOR)
    out = draw_detections(out, [leaf.detection for leaf in result.leaves])
    h, w = out.shape[:2]

    captions = [
        (leaf.detection, f"{leaf.position.distance_m:.1f}m {leaf.position.bearing_deg:+.0f}deg" + ("" if leaf.reachable else " X"))
        for leaf in result.leaves
    ] + [(r.detection, "x " + r.reason.replace("_", " ")) for r in result.rejected]
    for det, text in captions:
        x, y = det.box_xyxy[0], min(det.box_xyxy[3] + 14, h - 4)
        cv2.putText(out, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(out, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

    minimap = draw_minimap(result)
    mh, mw = minimap.shape[:2]
    if mh < h and mw < w:
        out[h - mh - 8 : h - 8, w - mw - 8 : w - 8] = minimap

    s = result.suggestion
    text = s.action.upper().replace("_", " ")
    if s.bearing_deg is not None:
        text += f"  {s.bearing_deg:+.0f} deg"
    if s.distance_m is not None:
        text += f"  {s.distance_m:.1f} m"
    cv2.putText(out, text, (10, h - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(out, text, (10, h - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    return out
