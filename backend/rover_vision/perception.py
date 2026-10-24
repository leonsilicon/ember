"""One camera frame → what the rover needs to know (the Mac-side twin of the
app's ``src/lib/rover-brain``).

Input (:class:`FrameInput`): an image, its intrinsics, which way is up,
and optionally depth and leaf boxes already found on the phone.

Output (:class:`PerceptionResult`, JSON schema ``rover-perception/2``):

- ``leaves``: each leaf's position in metres in the rover frame, distance,
  bearing, and whether the rover can reach it;
- ``rejected``: detections depth ruled out (off the ground, wrong size, too far);
- ``grid``: a top-down occupancy map of free / obstacle / drop from depth;
- ``corridors``: per steering bearing, how far the rover can safely drive;
- ``suggestion``: one possible next move.

Obstacles come from depth only. (The trained hazard model that also spotted
water is archived in ``archive/hazard-model``.)
"""

import base64
import math
import time
from dataclasses import dataclass, field

import numpy as np

from rover_vision.detection import Detection
from rover_vision.navigation import Suggestion, suggest
from rover_vision.occupancy import Corridor, GridSpec, OccupancyGrid, RoverSpec, build_grid, corridors
from rover_vision.spatial import Intrinsics, Mount, RoverCamera, bearing_deg, estimate_camera_height, up_from_mount

SCHEMA = "rover-perception/2"


@dataclass
class FrameInput:
    image: np.ndarray  # BGR, as captured
    intrinsics: Intrinsics  # for `image`
    up: np.ndarray | None = None  # world up in OpenCV camera coords; None → from the mount
    depth_m: np.ndarray | None = None  # metres along the optical axis, same aspect as `image`
    confidence: np.ndarray | None = None  # ARKit 0-2, same size as depth
    leaves: list[Detection] | None = None  # in `image` pixels; None → run the leaf detector here
    camera_height_m: float | None = None  # overrides the mount and depth estimate


@dataclass(frozen=True)
class LeafCheck:
    """Same rules as the app's ``DEFAULT_LEAF_CHECK`` (perceive.ts)."""

    max_height_above_floor_m: float = 0.25
    max_size_m: float = 1.5
    min_size_m: float = 0.02
    max_range_m: float = 8.0


@dataclass(frozen=True)
class GroundPosition:
    x_m: float
    y_m: float
    z_m: float
    source: str  # "depth" or "ground_plane" (ray onto flat ground)

    @property
    def distance_m(self) -> float:
        return math.hypot(self.x_m, self.z_m)

    @property
    def bearing_deg(self) -> float:
        return bearing_deg(self.x_m, self.z_m)

    def to_dict(self) -> dict:
        return {
            "x_m": round(self.x_m, 3),
            "y_m": round(self.y_m, 3),
            "z_m": round(self.z_m, 3),
            "distance_m": round(self.distance_m, 3),
            "bearing_deg": round(self.bearing_deg, 1),
            "source": self.source,
        }


@dataclass(frozen=True)
class LeafInfo:
    detection: Detection
    position: GroundPosition
    size_m: float
    reachable: bool
    blocked_by: str | None  # why not reachable

    def to_dict(self) -> dict:
        d = self.detection
        return {
            "label": d.label,
            "score": round(d.confidence, 3),
            "box_px": list(d.box_xyxy),
            "point_px": list(d.point_px),
            "position": self.position.to_dict(),
            "size_m": round(self.size_m, 3),
            "reachable": self.reachable,
            "blocked_by": self.blocked_by,
        }


@dataclass(frozen=True)
class Rejected:
    detection: Detection
    reason: str  # "off_ground" | "too_big" | "too_small" | "too_far" | "unplaceable"
    position: GroundPosition | None = None

    def to_dict(self) -> dict:
        return {
            "box_px": list(self.detection.box_xyxy),
            "reason": self.reason,
            "position": self.position.to_dict() if self.position else None,
        }


@dataclass
class PerceptionResult:
    image_size: tuple[int, int]  # (width, height)
    upright_turns: int
    camera: RoverCamera
    height_source: str
    leaves: list[LeafInfo]
    rejected: list[Rejected]
    grid: OccupancyGrid
    corridors: list[Corridor]
    suggestion: Suggestion
    timing_ms: dict[str, float] = field(default_factory=dict)

    def to_dict(self, include_grid: bool = True) -> dict:
        out = {
            "schema": SCHEMA,
            "image": {"width": self.image_size[0], "height": self.image_size[1], "upright_turns": self.upright_turns},
            "camera": {
                "height_m": round(self.camera.height_m, 3),
                "height_source": self.height_source,
                "pitch_deg": round(self.camera.pitch_deg, 1),
                "roll_deg": round(self.camera.roll_deg, 1),
            },
            "leaves": [leaf.to_dict() for leaf in self.leaves],
            "rejected": [r.to_dict() for r in self.rejected],
            "corridors": [c.to_dict() for c in self.corridors],
            "suggestion": self.suggestion.to_dict(),
            "timing_ms": {k: round(v, 1) for k, v in self.timing_ms.items()},
        }
        if include_grid:
            spec = self.grid.spec
            rows, cols = spec.shape
            out["grid"] = {
                "resolution_m": spec.resolution_m,
                "x_min_m": spec.x_min_m,
                "x_max_m": spec.x_max_m,
                "z_max_m": spec.z_max_m,
                "rows": rows,
                "cols": cols,
                "order": "row-major uint8; row 0 nearest the rover, col 0 leftmost",
                "codes_b64": base64.b64encode(self.grid.codes.tobytes()).decode(),
                "legend": {str(k): v for k, v in self.grid.legend().items()},
            }
        return out


# --- image orientation ---------------------------------------------------------


def upright_turns(up: np.ndarray) -> int:
    """Quarter turns (``np.rot90`` k, counter-clockwise) that make the image
    upright: the leaf detector does best on upright photos, and ARKit's
    captured image is in sensor orientation, sideways when the phone is held
    in portrait."""
    # Direction of world-up within the image plane: 90° = towards the top of
    # the image, 0° = towards its right edge. Each counter-clockwise quarter
    # turn of the image adds 90°.
    angle = math.degrees(math.atan2(-up[1], up[0]))
    return round(((90 - angle) % 360) / 90) % 4


def rotate_points_back(points: np.ndarray, turns: int, size: tuple[int, int]) -> np.ndarray:
    """Undo ``np.rot90(image, turns)`` for (N, 2) pixel coordinates found in
    the rotated image. ``size`` is the original (width, height)."""
    w, h = size
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2).copy()
    for i in range(turns % 4):
        # The rotated image at step i (counting back) is the original turned (turns - 1 - i) times.
        k = (turns - 1 - i) % 4
        cw = w if k % 2 == 0 else h  # width of the image before this quarter turn
        x, y = pts[:, 0].copy(), pts[:, 1].copy()
        pts[:, 0], pts[:, 1] = cw - 1 - y, x
    return pts


def _unrotate(det: Detection, turns: int, size: tuple[int, int]) -> Detection:
    if turns % 4 == 0:
        return det
    x1, y1, x2, y2 = det.box_xyxy
    (a, b), (c, d) = rotate_points_back(np.array([[x1, y1], [x2, y2]]), turns, size)
    return Detection.from_box(det.label, det.confidence, (int(min(a, c)), int(min(b, d)), int(max(a, c)), int(max(b, d))))


# --- pipeline ------------------------------------------------------------------


class Perception:
    """Holds the leaf detector and settings; call :meth:`perceive` per frame.

    The leaf detector is optional: without it, leaves come from ``FrameInput.leaves``.
    """

    def __init__(
        self,
        leaf_detector=None,
        rover: RoverSpec = RoverSpec(),
        grid: GridSpec = GridSpec(),
        mount: Mount = Mount(),
        check: LeafCheck = LeafCheck(),
    ):
        self.leaf_detector = leaf_detector
        self.rover = rover
        self.grid_spec = grid
        self.mount = mount
        self.check = check

    def perceive(self, frame: FrameInput) -> PerceptionResult:
        timing: dict[str, float] = {}
        t0 = time.perf_counter()
        h, w = frame.image.shape[:2]
        intrinsics = frame.intrinsics if (frame.intrinsics.width, frame.intrinsics.height) == (w, h) else frame.intrinsics.scaled(w, h)
        up = frame.up if frame.up is not None else up_from_mount(self.mount)

        turns = upright_turns(up)
        if frame.leaves is not None:
            detections = frame.leaves
        elif self.leaf_detector is not None:
            # The detector sees the image upright; boxes are mapped back to it.
            upright = np.ascontiguousarray(np.rot90(frame.image, turns)) if turns else frame.image
            t = time.perf_counter()
            detections = [_unrotate(d, turns, (w, h)) for d in self.leaf_detector(upright)]
            timing["leaves"] = (time.perf_counter() - t) * 1000
        else:
            detections = []

        t = time.perf_counter()
        camera, height_source, depth_points = self._place_camera(intrinsics, up, frame)
        grid = build_grid(self.grid_spec, self.rover, depth_points)
        lanes = corridors(grid, self.rover)
        leaves: list[LeafInfo] = []
        rejected: list[Rejected] = []
        for det in detections:
            self._check_leaf(det, camera, frame, lanes, leaves, rejected)
        timing["geometry"] = (time.perf_counter() - t) * 1000
        timing["total"] = (time.perf_counter() - t0) * 1000

        return PerceptionResult(
            image_size=(w, h),
            upright_turns=turns,
            camera=camera,
            height_source=height_source,
            leaves=leaves,
            rejected=rejected,
            grid=grid,
            corridors=lanes,
            suggestion=suggest(leaves, lanes),
            timing_ms=timing,
        )

    # -- helpers

    def _place_camera(self, k: Intrinsics, up: np.ndarray, frame: FrameInput):
        """Pick the camera height and unproject depth into the rover frame."""
        if frame.camera_height_m is not None:
            height, source = frame.camera_height_m, "request"
        elif self.mount.camera_height_m is not None:
            height, source = self.mount.camera_height_m, "mount"
        else:
            height, source = self.mount.default_height_m, "default"

        points = None
        if frame.depth_m is not None:
            relative = RoverCamera(k, up, 0.0)
            points, _ = relative.unproject_depth(frame.depth_m, frame.confidence)
            if source == "default":
                estimate = estimate_camera_height(points)
                if estimate is not None:
                    height, source = estimate, "depth_fit"
            points[:, 1] += height
        return RoverCamera(k, up, height), source, points

    def _box_depth(self, det: Detection, frame: FrameInput, inner: float = 0.5, grid: int = 5) -> float | None:
        """Median valid depth over a grid in the middle of the box (like the app's ``boxDepth``)."""
        if frame.depth_m is None:
            return None
        dh, dw = frame.depth_m.shape
        h, w = frame.image.shape[:2]
        x1, y1, x2, y2 = det.box_xyxy
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        hw, hh = (x2 - x1) * inner / 2, (y2 - y1) * inner / 2
        samples = []
        for fx in np.linspace(-1, 1, grid):
            for fy in np.linspace(-1, 1, grid):
                u = int((cx + fx * hw) * dw / w)
                v = int((cy + fy * hh) * dh / h)
                if not (0 <= u < dw and 0 <= v < dh):
                    continue
                z = frame.depth_m[v, u]
                if not (np.isfinite(z) and 0.1 <= z <= 6.0):
                    continue
                if frame.confidence is not None and frame.confidence[v, u] < 1:
                    continue
                samples.append(float(z))
        return float(np.median(samples)) if samples else None

    def _check_leaf(self, det, camera: RoverCamera, frame: FrameInput, lanes, leaves: list, rejected: list):
        c = self.check
        z = self._box_depth(det, frame)
        if z is not None:
            ray = camera.pixel_rays(np.array([det.point_px], dtype=np.float64))[0]
            x, y, zz = camera.camera_to_rover((ray * z)[None, :])[0]
            position, depth_along_axis = GroundPosition(float(x), float(y), float(zz), "depth"), z
        else:
            ground = camera.pixels_to_ground(np.array([det.point_px], dtype=np.float64))[0]
            if not np.isfinite(ground[0]):
                rejected.append(Rejected(det, "unplaceable"))
                return
            position = GroundPosition(float(ground[0]), 0.0, float(ground[2]), "ground_plane")
            # Depth along the optical axis of that ground point, for sizing the box.
            point_camera = np.linalg.solve(camera.basis, np.array([ground[0], -camera.height_m, ground[2]]))
            depth_along_axis = float(point_camera[2])

        k = camera.intrinsics
        x1, y1, x2, y2 = det.box_xyxy
        size_m = max((x2 - x1) / k.fx, (y2 - y1) / k.fy) * depth_along_axis
        reason = (
            "too_far" if position.distance_m > c.max_range_m
            else "off_ground" if position.source == "depth" and position.y_m > c.max_height_above_floor_m
            else "too_big" if size_m > c.max_size_m
            else "too_small" if size_m < c.min_size_m
            else None
        )
        if reason:
            rejected.append(Rejected(det, reason, position))
            return
        lane = min(lanes, key=lambda l: abs(l.bearing_deg - position.bearing_deg))
        if abs(position.bearing_deg - lane.bearing_deg) > 10:
            leaves.append(LeafInfo(det, position, size_m, False, "outside corridors"))
        elif lane.blocked_by is not None and lane.clearance_m + 0.15 < position.distance_m:
            leaves.append(LeafInfo(det, position, size_m, False, lane.blocked_by))
        else:
            leaves.append(LeafInfo(det, position, size_m, True, None))
