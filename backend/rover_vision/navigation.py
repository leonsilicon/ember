"""Fuse leaf targets and hazards into a driving decision.

The view ahead is split into vertical **sectors**, each a steering
direction. A sector is blocked when either:

- **hazard masks** (water, rocks, logs, ...) cover enough of its *near
  band*, the bottom of the image, which for a forward-facing camera is the
  ground the rover is about to drive over; or
- **depth** (RealSense / LiDAR, when available) shows something closer than
  ``stop_distance_m`` in its *depth band*, the rows where upright
  obstacles appear. Depth catches obstacles the hazard model has never
  seen. The hazard model catches what depth can't: water and drop-offs
  return little or no depth.

The decision then picks the nearest leaf in an open sector
(``drive_to_target``), or else the most open direction closest to
straight ahead (``explore``), or ``stop`` if every sector is blocked.
"""

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from rover_vision.detection import Detection
from rover_vision.tasks import Role


@dataclass(frozen=True)
class NavConfig:
    sectors: int = 7
    hfov_deg: float = 69.0  # RealSense D435 colour; iPhone wide camera is ~70
    near_band: tuple[float, float] = (0.6, 1.0)  # image rows (fraction of height): ground just ahead
    hazard_block_frac: float = 0.12  # hazard coverage of a sector's near band that blocks it
    depth_band: tuple[float, float] = (0.3, 0.8)  # rows where upright obstacles show up
    stop_distance_m: float = 0.6
    min_valid_depth_m: float = 0.15  # below this the sensor is returning noise


@dataclass(frozen=True)
class Sector:
    index: int
    x_range: tuple[int, int]
    angle_deg: float  # centre direction; negative is left
    hazard_frac: float
    clearance_m: float | None  # nearest depth in the band, if depth is available
    blocked_by: str | None  # e.g. "water", "depth 0.42 m"; None when open

    @property
    def blocked(self) -> bool:
        return self.blocked_by is not None


@dataclass(frozen=True)
class Decision:
    action: str  # "drive_to_target" | "explore" | "stop"
    angle_deg: float | None
    target: Detection | None
    distance_m: float | None
    sectors: list[Sector] = field(default_factory=list)

    def to_payload(self) -> dict:
        """The JSON sent to the Raspberry Pi."""
        payload = {
            "action": self.action,
            "angle_deg": None if self.angle_deg is None else round(self.angle_deg, 1),
            "blocked": [{"angle_deg": round(s.angle_deg, 1), "by": s.blocked_by} for s in self.sectors if s.blocked],
        }
        if self.target is not None:
            payload["target"] = self.target.label
            payload["target_px"] = list(self.target.point_px)
        if self.distance_m is not None:
            payload["distance_cm"] = round(self.distance_m * 100)
        return payload


def pixel_to_angle(x: float, width: int, hfov_deg: float) -> float:
    """Horizontal angle of image column ``x`` from the optical axis (pinhole)."""
    focal = (width / 2) / math.tan(math.radians(hfov_deg) / 2)
    return math.degrees(math.atan((x - width / 2) / focal)) + 0.0  # + 0.0 turns -0.0 into 0.0


def hazard_mask(hazards: list[Detection], shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Rasterise hazard detections → (bool mask, int label map). Label map
    values index into ``hazards`` (+1; 0 is free). Boxes stand in for
    missing polygons."""
    labels = np.zeros(shape[:2], dtype=np.int32)
    for i, det in enumerate(hazards, start=1):
        if det.role is not Role.HAZARD:
            continue
        if det.polygon_px is not None:
            cv2.fillPoly(labels, [det.polygon_px.astype(np.int32)], i)
        else:
            x1, y1, x2, y2 = det.box_xyxy
            labels[y1 : y2 + 1, x1 : x2 + 1] = i
    return labels > 0, labels


def _rows(band: tuple[float, float], height: int) -> slice:
    return slice(int(band[0] * height), max(int(band[0] * height) + 1, int(band[1] * height)))


def evaluate_sectors(
    shape: tuple[int, int],
    hazards: list[Detection],
    depth_m: np.ndarray | None = None,
    cfg: NavConfig = NavConfig(),
) -> list[Sector]:
    h, w = shape[:2]
    _, label_map = hazard_mask(hazards, (h, w))
    near = _rows(cfg.near_band, h)
    band = _rows(cfg.depth_band, h)
    edges = np.linspace(0, w, cfg.sectors + 1).astype(int)

    sectors = []
    for i, (x0, x1) in enumerate(zip(edges[:-1], edges[1:])):
        near_labels = label_map[near, x0:x1]
        covered = near_labels[near_labels > 0]
        hazard_frac = covered.size / max(near_labels.size, 1)
        blocked_by = None
        if hazard_frac >= cfg.hazard_block_frac:
            dominant = np.bincount(covered).argmax()
            blocked_by = hazards[dominant - 1].label

        clearance = None
        if depth_m is not None:
            region = depth_m[band, x0:x1]
            valid = region[region >= cfg.min_valid_depth_m]
            if valid.size:
                # 5th percentile, not min: ignores isolated noisy pixels.
                clearance = float(np.percentile(valid, 5))
                if blocked_by is None and clearance < cfg.stop_distance_m:
                    blocked_by = f"depth {clearance:.2f} m"

        sectors.append(
            Sector(
                index=i,
                x_range=(int(x0), int(x1)),
                angle_deg=pixel_to_angle((x0 + x1) / 2, w, cfg.hfov_deg),
                hazard_frac=hazard_frac,
                clearance_m=clearance,
                blocked_by=blocked_by,
            )
        )
    return sectors


def _depth_at(depth_m: np.ndarray | None, point: tuple[int, int], cfg: NavConfig, radius: int = 3) -> float | None:
    if depth_m is None:
        return None
    x, y = point
    patch = depth_m[max(0, y - radius) : y + radius + 1, max(0, x - radius) : x + radius + 1]
    valid = patch[patch >= cfg.min_valid_depth_m]
    return float(np.median(valid)) if valid.size else None


def decide(
    shape: tuple[int, int],
    leaves: list[Detection],
    hazards: list[Detection],
    depth_m: np.ndarray | None = None,
    cfg: NavConfig = NavConfig(),
) -> Decision:
    h, w = shape[:2]
    sectors = evaluate_sectors(shape, hazards, depth_m, cfg)
    in_hazard, _ = hazard_mask(hazards, (h, w))

    def sector_of(x: int) -> Sector:
        return sectors[min(int(x * cfg.sectors / w), cfg.sectors - 1)]

    reachable = []
    for leaf in leaves:
        x, y = leaf.point_px
        if in_hazard[min(y, h - 1), min(x, w - 1)] or sector_of(x).blocked:
            continue  # e.g. a leaf floating on water, or behind a rock
        distance = _depth_at(depth_m, leaf.point_px, cfg)
        # Nearest first: true depth when we have it, otherwise lower in the
        # image means closer for a camera looking ahead at the ground.
        nearness = -distance if distance is not None else leaf.box_xyxy[3] / h
        reachable.append((nearness, leaf.confidence, leaf, distance))

    if reachable:
        _, _, target, distance = max(reachable, key=lambda r: (r[0], r[1]))
        return Decision("drive_to_target", pixel_to_angle(target.point_px[0], w, cfg.hfov_deg), target, distance, sectors)

    open_sectors = [s for s in sectors if not s.blocked]
    if open_sectors:
        best = min(open_sectors, key=lambda s: (abs(s.angle_deg), s.hazard_frac))
        return Decision("explore", best.angle_deg, None, best.clearance_m, sectors)
    return Decision("stop", None, None, None, sectors)


def draw_navigation(frame: np.ndarray, decision: Decision, cfg: NavConfig = NavConfig()) -> np.ndarray:
    """Sector bar along the bottom (red = blocked, green = open) with
    the reason, plus a heading arrow from the rover's position."""
    h, w = frame.shape[:2]
    overlay = frame.copy()
    bar_top = h - max(18, h // 24)
    for s in decision.sectors:
        x0, x1 = s.x_range
        color = (40, 40, 230) if s.blocked else (60, 190, 60)
        cv2.rectangle(overlay, (x0 + 1, bar_top), (x1 - 2, h - 1), color, -1)
    out = cv2.addWeighted(overlay, 0.55, frame, 0.45, 0)
    for s in decision.sectors:
        if s.blocked:
            x0, x1 = s.x_range
            cv2.putText(out, s.blocked_by[:12], (x0 + 3, h - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255, 255, 255), 1, cv2.LINE_AA)

    origin = (w // 2, bar_top - 4)
    if decision.angle_deg is not None:
        length = h // 4
        rad = math.radians(decision.angle_deg)
        tip = (int(origin[0] + length * math.sin(rad)), int(origin[1] - length * math.cos(rad)))
        color = (0, 140, 255) if decision.action == "drive_to_target" else (255, 255, 255)
        cv2.arrowedLine(out, origin, tip, (0, 0, 0), 6, cv2.LINE_AA, tipLength=0.2)
        cv2.arrowedLine(out, origin, tip, color, 3, cv2.LINE_AA, tipLength=0.2)

    text = decision.action.upper().replace("_", " ")
    if decision.angle_deg is not None:
        text += f"  {decision.angle_deg:+.0f} deg"
    if decision.distance_m is not None:
        text += f"  {decision.distance_m:.2f} m"
    cv2.putText(out, text, (10, bar_top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(out, text, (10, bar_top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    return out
