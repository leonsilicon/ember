"""Camera geometry in the rover's frame.

**Rover frame** (every metric output uses it): origin on the ground
directly below the camera; ``x`` metres to the right, ``y`` metres up
(height above the ground), ``z`` metres forward along the ground.
``bearing_deg = atan2(x, z)``: 0 is straight ahead, positive is right.

The camera can be tilted or rolled. All that's needed is which way is up
in camera coordinates:

- with ARKit, from the frame's camera-to-world pose (world +Y is up);
- otherwise, from the mount's pitch and roll.

Pixel and camera conventions follow OpenCV: ``u`` right, ``v`` down;
camera ``x`` right, ``y`` down, ``z`` forward along the optical axis.
"""

import math
from dataclasses import dataclass

import numpy as np

# ARKit's camera axes are x right, y up, z backward; OpenCV's are x right,
# y down, z forward. This flips one into the other (it is its own inverse).
ARKIT_TO_CV = np.diag([1.0, -1.0, -1.0])


@dataclass(frozen=True)
class Intrinsics:
    """Pinhole intrinsics for an image of ``width`` x ``height`` pixels."""

    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int

    def scaled(self, width: int, height: int) -> "Intrinsics":
        sx, sy = width / self.width, height / self.height
        return Intrinsics(self.fx * sx, self.fy * sy, self.cx * sx, self.cy * sy, width, height)

    @classmethod
    def from_hfov(cls, width: int, height: int, hfov_deg: float) -> "Intrinsics":
        """For cameras without calibration data (webcams): square pixels,
        principal point at the centre."""
        f = (width / 2) / math.tan(math.radians(hfov_deg) / 2)
        return cls(f, f, width / 2, height / 2, width, height)


@dataclass(frozen=True)
class Mount:
    """How the camera sits on the rover, used when there is no ARKit pose.

    ``pitch_deg`` is how far the camera looks down from horizontal and
    ``roll_deg`` its clockwise roll as seen from behind. ``camera_height_m``
    is the lens height above the ground; ``None`` means estimate it from
    depth, falling back to ``default_height_m``.
    """

    pitch_deg: float = 15.0
    roll_deg: float = 0.0
    camera_height_m: float | None = None
    default_height_m: float = 0.30


def up_from_mount(mount: Mount) -> np.ndarray:
    """World up, in OpenCV camera coordinates, for a camera pitched down by
    ``pitch`` and rolled by ``roll``."""
    p, r = math.radians(mount.pitch_deg), math.radians(mount.roll_deg)
    # Level camera: up is -y. Pitching down tips up toward -z; rolling
    # clockwise tips it toward -x.
    up = np.array([-math.sin(r) * math.cos(p), -math.cos(r) * math.cos(p), -math.sin(p)])
    return up / np.linalg.norm(up)


def up_from_arkit_pose(camera_to_world_column_major: list[float]) -> np.ndarray:
    """World up (+Y in ARKit's world), in OpenCV camera coordinates."""
    m = np.asarray(camera_to_world_column_major, dtype=np.float64).reshape(4, 4).T  # column-major → rows
    up_arkit_camera = m[:3, :3].T @ np.array([0.0, 1.0, 0.0])
    up = ARKIT_TO_CV @ up_arkit_camera
    return up / np.linalg.norm(up)


@dataclass(frozen=True)
class RoverCamera:
    """A calibrated camera placed in the rover frame."""

    intrinsics: Intrinsics
    up: np.ndarray  # unit world-up in OpenCV camera coordinates
    height_m: float

    @property
    def basis(self) -> np.ndarray:
        """Rows are the rover's right, up and forward axes in camera
        coordinates, so ``basis @ p_camera`` gives (x, y - height, z)."""
        up = self.up
        # Forward is the optical axis made horizontal. Looking straight down
        # it vanishes; then the top of the image counts as forward.
        forward = np.array([0.0, 0.0, 1.0]) - up[2] * up
        if np.linalg.norm(forward) < 1e-3:
            forward = np.array([0.0, -1.0, 0.0]) - up[1] * up
        forward /= np.linalg.norm(forward)
        right = np.cross(forward, up)
        return np.stack([right, up, forward])

    @property
    def pitch_deg(self) -> float:
        """How far the optical axis points below horizontal."""
        return math.degrees(math.asin(np.clip(-self.up[2], -1.0, 1.0)))

    @property
    def roll_deg(self) -> float:
        return math.degrees(math.atan2(-self.up[0], -self.up[1]))

    def camera_to_rover(self, points_camera: np.ndarray) -> np.ndarray:
        """(N, 3) camera-frame points → (N, 3) rover-frame points."""
        rover = points_camera @ self.basis.T
        rover[:, 1] += self.height_m
        return rover

    def pixel_rays(self, uv: np.ndarray) -> np.ndarray:
        """(N, 2) pixels → (N, 3) unnormalised camera-frame ray directions."""
        k = self.intrinsics
        uv = np.asarray(uv, dtype=np.float64).reshape(-1, 2)
        return np.stack([(uv[:, 0] - k.cx) / k.fx, (uv[:, 1] - k.cy) / k.fy, np.ones(len(uv))], axis=1)

    def pixels_to_ground(self, uv: np.ndarray, max_range_m: float = 30.0) -> np.ndarray:
        """Where each pixel's ray meets flat ground, in the rover frame;
        rows are NaN for rays at or above the horizon or beyond
        ``max_range_m``. Right for things lying on the ground (leaves,
        water) and for the contact line of upright objects."""
        rays = self.pixel_rays(uv) @ self.basis.T  # rover-frame directions
        with np.errstate(divide="ignore", invalid="ignore"):
            t = -self.height_m / rays[:, 1]  # where y reaches 0
        points = rays * t[:, None]
        points[:, 1] += self.height_m
        bad = ~(rays[:, 1] < -1e-6) | (np.hypot(points[:, 0], points[:, 2]) > max_range_m)
        points[bad] = np.nan
        return points

    def unproject_depth(
        self,
        depth_m: np.ndarray,
        confidence: np.ndarray | None = None,
        min_confidence: int = 1,
        stride: int = 1,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Depth map (any resolution with the image's aspect ratio, metres
        along the optical axis; 0/NaN = no reading) → rover-frame points and
        the depth-map pixels they came from."""
        h, w = depth_m.shape
        k = self.intrinsics.scaled(w, h)
        vs, us = np.mgrid[0:h:stride, 0:w:stride]
        z = depth_m[::stride, ::stride]
        valid = np.isfinite(z) & (z > 0)
        if confidence is not None:
            valid &= confidence[::stride, ::stride] >= min_confidence
        us, vs, z = us[valid], vs[valid], z[valid].astype(np.float64)
        camera = np.stack([(us - k.cx) / k.fx * z, (vs - k.cy) / k.fy * z, z], axis=1)
        return self.camera_to_rover(camera), np.stack([us, vs], axis=1)


def estimate_camera_height(points_relative: np.ndarray, bin_m: float = 0.02, max_forward_m: float = 3.0) -> float | None:
    """Camera height from depth points expressed with the camera at y = 0
    (i.e. rover frame with height 0): the ground is the most common level
    below the camera. Returns None if there's too little ground in view."""
    near = points_relative[(points_relative[:, 2] > 0.2) & (points_relative[:, 2] < max_forward_m)]
    below = -near[:, 1]
    below = below[(below > 0.05) & (below < 3.0)]
    if below.size < 200:
        return None
    hist, edges = np.histogram(below, bins=np.arange(0.05, 3.0 + bin_m, bin_m))
    i = int(hist.argmax())
    in_peak = below[(below >= edges[max(i - 1, 0)]) & (below < edges[min(i + 2, len(edges) - 1)])]
    return float(np.median(in_peak))


def bearing_deg(x: float, z: float) -> float:
    return math.degrees(math.atan2(x, z)) + 0.0  # + 0.0 turns -0.0 into 0.0
