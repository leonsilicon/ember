"""One camera frame → what the rover needs to know.

Input (:class:`FrameInput`): an image, its intrinsics, which way is up,
and optionally LiDAR depth and leaf boxes found on the phone.

Output (:class:`PerceptionResult`, JSON schema ``rover-perception/1``):

- ``leaves``: each leaf's position in metres in the rover frame, its
  distance and bearing, and whether the rover can reach it;
- ``hazards``: each detected hazard (water, rock, ...) and where it meets
  the ground;
- ``grid``: a top-down occupancy map of free / blocked ground;
- ``corridors``: per steering bearing, how far the rover can safely drive;
- ``suggestion``: one possible next move. Optional to use.

See ``INTEGRATION.md`` for the full field reference.
"""

import base64
import math
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from rover_vision.detection import Detection
from rover_vision.navigation import Suggestion, suggest
from rover_vision.occupancy import Corridor, GridSpec, OccupancyGrid, RoverSpec, build_grid, corridors
from rover_vision.spatial import Intrinsics, Mount, RoverCamera, bearing_deg, estimate_camera_height, up_from_mount
from rover_vision.tasks import HAZARDS

SCHEMA = "rover-perception/1"
FLAT_HAZARDS = frozenset({"water"})  # lie on the ground: every pixel of the mask is ground


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
class GroundPosition:
    x_m: float
    y_m: float
    z_m: float
    source: str  # "depth" (LiDAR) or "ground_plane" (ray onto flat ground)

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
    position: GroundPosition | None  # None: above the horizon and no depth
    reachable: bool
    blocked_by: str | None  # why not reachable

    def to_dict(self) -> dict:
        d = self.detection
        return {
            "label": d.label,
            "score": round(d.confidence, 3),
            "box_px": list(d.box_xyxy),
            "point_px": list(d.point_px),
            "position": self.position.to_dict() if self.position else None,
            "reachable": self.reachable,
            "blocked_by": self.blocked_by,
        }


@dataclass(frozen=True)
class HazardInfo:
    detection: Detection
    contact: GroundPosition | None  # where it meets the ground, nearest the rover

    def to_dict(self) -> dict:
        d = self.detection
        out = {
            "label": d.label,
            "score": round(d.confidence, 3),
            "box_px": list(d.box_xyxy),
            "contact_px": list(d.point_px),
            "contact": self.contact.to_dict() if self.contact else None,
        }
        if d.polygon_px is not None:
            out["polygon_px"] = np.asarray(d.polygon_px).round().astype(int).tolist()
        return out


@dataclass
class PerceptionResult:
    image_size: tuple[int, int]  # (width, height)
    upright_turns: int
    camera: RoverCamera
    height_source: str
    leaves: list[LeafInfo]
    hazards: list[HazardInfo]
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
            "hazards": [h.to_dict() for h in self.hazards],
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
    upright: the detectors were trained on upright photos, and ARKit's
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
    corners = rotate_points_back(np.array([[x1, y1], [x2, y2]]), turns, size)
    (a, b), (c, d) = corners
    point = rotate_points_back(np.array([det.point_px]), turns, size)[0]
    polygon = rotate_points_back(det.polygon_px, turns, size) if det.polygon_px is not None else None
    return Detection(
        det.task, det.label, det.role, det.confidence,
        (int(min(a, c)), int(min(b, d)), int(max(a, c)), int(max(b, d))),
        (int(point[0]), int(point[1])), polygon,
    )


# --- pipeline ------------------------------------------------------------------


class Perception:
    """Holds the models and settings; call :meth:`perceive` per frame.

    Models are optional: without a hazard model, obstacles come from depth
    only; without a leaf detector, leaves come from ``FrameInput.leaves``.
    """

    def __init__(
        self,
        hazard_detector=None,
        leaf_detector=None,
        rover: RoverSpec = RoverSpec(),
        grid: GridSpec = GridSpec(),
        mount: Mount = Mount(),
    ):
        self.hazard_detector = hazard_detector
        self.leaf_detector = leaf_detector
        self.rover = rover
        self.grid_spec = grid
        self.mount = mount

    def perceive(self, frame: FrameInput) -> PerceptionResult:
        timing: dict[str, float] = {}
        t0 = time.perf_counter()
        h, w = frame.image.shape[:2]
        intrinsics = frame.intrinsics if (frame.intrinsics.width, frame.intrinsics.height) == (w, h) else frame.intrinsics.scaled(w, h)
        up = frame.up if frame.up is not None else up_from_mount(self.mount)

        # Detectors see the image upright; results are mapped back to it.
        turns = upright_turns(up)
        upright = np.ascontiguousarray(np.rot90(frame.image, turns)) if turns else frame.image
        t = time.perf_counter()
        hazards = [_unrotate(d, turns, (w, h)) for d in self.hazard_detector(upright)] if self.hazard_detector else []
        timing["hazards"] = (time.perf_counter() - t) * 1000
        if frame.leaves is not None:
            leaves = frame.leaves
        elif self.leaf_detector is not None:
            t = time.perf_counter()
            leaves = [_unrotate(d, turns, (w, h)) for d in self.leaf_detector(upright)]
            timing["leaves"] = (time.perf_counter() - t) * 1000
        else:
            leaves = []

        t = time.perf_counter()
        camera, height_source, depth_points = self._place_camera(intrinsics, up, frame)
        hazard_ground = [(HAZARDS.class_id(d.label), self._hazard_ground_points(d, camera, frame)) for d in hazards]
        grid = build_grid(self.grid_spec, self.rover, HAZARDS.names, depth_points, hazard_ground)
        lanes = corridors(grid, self.rover)
        hazard_mask = _hazard_mask(hazards, (h, w))
        leaf_infos = [self._leaf_info(d, camera, frame, grid, lanes, hazard_mask) for d in leaves]
        hazard_infos = [HazardInfo(d, self._ground_at(d.point_px, camera, frame)) for d in hazards]
        timing["geometry"] = (time.perf_counter() - t) * 1000
        timing["total"] = (time.perf_counter() - t0) * 1000

        return PerceptionResult(
            image_size=(w, h),
            upright_turns=turns,
            camera=camera,
            height_source=height_source,
            leaves=leaf_infos,
            hazards=hazard_infos,
            grid=grid,
            corridors=lanes,
            suggestion=suggest(leaf_infos, lanes),
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

    def _depth_at(self, uv: np.ndarray, frame: FrameInput, radius: int = 1) -> np.ndarray:
        """Median valid depth around each image pixel (NaN where none)."""
        if frame.depth_m is None:
            return np.full(len(uv), np.nan)
        dh, dw = frame.depth_m.shape
        h, w = frame.image.shape[:2]
        out = np.full(len(uv), np.nan)
        for i, (u, v) in enumerate(np.asarray(uv)):
            du, dv = int(u * dw / w), int(v * dh / h)
            patch = frame.depth_m[max(0, dv - radius) : dv + radius + 1, max(0, du - radius) : du + radius + 1]
            ok = np.isfinite(patch) & (patch > 0)
            if frame.confidence is not None:
                conf = frame.confidence[max(0, dv - radius) : dv + radius + 1, max(0, du - radius) : du + radius + 1]
                ok &= conf >= 1
            if ok.any():
                out[i] = float(np.median(patch[ok]))
        return out

    def _points_at(self, uv: np.ndarray, camera: RoverCamera, frame: FrameInput, use_depth: bool) -> tuple[np.ndarray, np.ndarray]:
        """Rover-frame points for pixels: LiDAR where it has a reading (and
        ``use_depth``), else the ray onto flat ground. Returns (points, used_depth)."""
        uv = np.asarray(uv, dtype=np.float64).reshape(-1, 2)
        ground = camera.pixels_to_ground(uv, max_range_m=max(self.grid_spec.z_max_m * 2, 10.0))
        used_depth = np.zeros(len(uv), dtype=bool)
        if use_depth and frame.depth_m is not None:
            z = self._depth_at(uv, frame)
            have = np.isfinite(z)
            if have.any():
                rays = camera.pixel_rays(uv[have])
                ground[have] = camera.camera_to_rover(rays * z[have, None])
                used_depth[have] = True
        return ground, used_depth

    def _ground_at(self, point_px, camera: RoverCamera, frame: FrameInput) -> GroundPosition | None:
        points, used = self._points_at(np.array([point_px]), camera, frame, use_depth=True)
        x, y, z = points[0]
        if not np.isfinite(x):
            return None
        return GroundPosition(float(x), float(y), float(z), "depth" if used[0] else "ground_plane")

    def _hazard_ground_points(self, det: Detection, camera: RoverCamera, frame: FrameInput, stride: int = 4) -> np.ndarray:
        h, w = frame.image.shape[:2]
        mask = np.zeros((h, w), np.uint8)
        if det.polygon_px is not None:
            cv2.fillPoly(mask, [np.asarray(det.polygon_px, dtype=np.int32)], 1)
        else:
            x1, y1, x2, y2 = det.box_xyxy
            mask[y1 : y2 + 1, x1 : x2 + 1] = 1
        if det.label in FLAT_HAZARDS:
            # Water: every pixel is on the ground. Ray-cast, since LiDAR on
            # water is missing or reflects whatever the surface mirrors.
            vs, us = np.nonzero(mask[::stride, ::stride])
            uv = np.stack([us * stride, vs * stride], axis=1)
            points, _ = self._points_at(uv, camera, frame, use_depth=False)
        else:
            # Upright things: only where they touch the ground counts (higher
            # pixels would ray-cast to the ground far behind them).
            cols = np.flatnonzero(mask.any(axis=0))[::stride]
            if not cols.size:
                return np.empty((0, 3))
            bottoms = mask.shape[0] - 1 - np.argmax(mask[::-1, cols], axis=0)
            points, used = self._points_at(np.stack([cols, bottoms], axis=1), camera, frame, use_depth=True)
            points = points.copy()
            points[used, 1] = 0.0  # it's the contact line; mark it on the ground
        return points[np.isfinite(points[:, 0])]

    def _leaf_info(self, det, camera, frame, grid: OccupancyGrid, lanes, hazard_mask) -> LeafInfo:
        position = self._ground_at(det.point_px, camera, frame)
        if position is None:
            return LeafInfo(det, None, False, "beyond horizon")
        u, v = det.point_px
        if 0 <= v < hazard_mask.shape[0] and 0 <= u < hazard_mask.shape[1] and hazard_mask[v, u]:
            return LeafInfo(det, position, False, "in hazard")
        lane = min(lanes, key=lambda c: abs(c.bearing_deg - position.bearing_deg))
        # It must be reachable along the corridor, and not further sideways
        # than the corridors cover.
        if abs(position.bearing_deg - lane.bearing_deg) > 10:
            return LeafInfo(det, position, False, "outside corridors")
        if lane.blocked_by is not None and lane.clearance_m + 0.15 < position.distance_m:
            return LeafInfo(det, position, False, lane.blocked_by)
        return LeafInfo(det, position, True, None)


def _hazard_mask(hazards: list[Detection], shape: tuple[int, int]) -> np.ndarray:
    mask = np.zeros(shape, np.uint8)
    for det in hazards:
        if det.polygon_px is not None:
            cv2.fillPoly(mask, [np.asarray(det.polygon_px, dtype=np.int32)], 1)
        else:
            x1, y1, x2, y2 = det.box_xyxy
            mask[y1 : y2 + 1, x1 : x2 + 1] = 1
    return mask.astype(bool)
