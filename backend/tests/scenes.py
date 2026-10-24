"""Synthetic depth maps rendered from known geometry, for tests."""

import numpy as np

from rover_vision.spatial import Intrinsics, Mount, RoverCamera, up_from_mount


def camera(pitch_deg=20.0, height_m=0.4, w=160, h=120, hfov=70.0, roll_deg=0.0) -> RoverCamera:
    return RoverCamera(Intrinsics.from_hfov(w, h, hfov), up_from_mount(Mount(pitch_deg, roll_deg)), height_m)


def render_depth(cam: RoverCamera, walls=(), holes=()) -> np.ndarray:
    """Depth (metres along the optical axis) of flat ground plus boxes.

    walls: (x_min, x_max, z_near, height) upright faces facing the rover.
    holes: (x_min, x_max, z_min, z_max, depth) patches where the ground is lower.
    """
    k = cam.intrinsics
    vs, us = np.mgrid[0 : k.height, 0 : k.width]
    rays = cam.pixel_rays(np.stack([us.ravel(), vs.ravel()], axis=1))  # camera frame, z = 1
    d = rays @ cam.basis.T  # rover-frame direction per unit optical depth
    depth = np.full(len(d), np.nan)

    down = d[:, 1] < -1e-9
    t = np.where(down, -cam.height_m / np.where(down, d[:, 1], -1), np.nan)
    x, z = t * d[:, 0], t * d[:, 2]
    for x0, x1, z0, z1, dip in holes:
        inside = (x >= x0) & (x <= x1) & (z >= z0) & (z <= z1)
        t_low = -(cam.height_m + dip) / np.where(down, d[:, 1], -1)
        t = np.where(inside & down, t_low, t)
    depth[down] = t[down]

    for x0, x1, z_near, top in walls:
        forward = d[:, 2] > 1e-9
        tw = np.where(forward, z_near / np.where(forward, d[:, 2], 1), np.nan)
        px, py = tw * d[:, 0], cam.height_m + tw * d[:, 1]
        hit = forward & (px >= x0) & (px <= x1) & (py >= 0) & (py <= top) & ~(depth < tw)
        depth[hit] = tw[hit]
    return depth.reshape(k.height, k.width).astype(np.float32)
