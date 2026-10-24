"""Frame sources: webcam, video file / stream, single image, or an Intel
RealSense with depth aligned to colour."""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


@dataclass
class Frame:
    color: np.ndarray  # BGR
    depth_m: np.ndarray | None = None  # metres, aligned to color; 0 = no reading


@contextmanager
def open_source(source: str) -> Iterator[Iterator[Frame]]:
    """``source``: ``"realsense"``, a webcam index (``"0"``), an image path,
    or a video path / stream URL. Yields an iterator of frames and releases
    the device on exit."""
    if source == "realsense":
        with _realsense() as frames:
            yield frames
    elif Path(source).suffix.lower() in IMAGE_SUFFIXES:
        image = cv2.imread(source)
        if image is None:
            raise FileNotFoundError(f"Could not read image {source}")
        yield iter([Frame(image)])
    else:
        cap = cv2.VideoCapture(int(source) if source.isdigit() else source)
        if not cap.isOpened():
            hint = " (on macOS, allow camera access for your terminal in System Settings)" if source.isdigit() else ""
            raise RuntimeError(f"Could not open video source {source!r}{hint}")
        try:
            yield _capture_frames(cap)
        finally:
            cap.release()


def _capture_frames(cap: cv2.VideoCapture) -> Iterator[Frame]:
    while True:
        ok, image = cap.read()
        if not ok:
            return
        yield Frame(image)


@contextmanager
def _realsense(width: int = 640, height: int = 480, fps: int = 30) -> Iterator[Iterator[Frame]]:
    try:
        import pyrealsense2 as rs
    except ImportError as exc:
        raise RuntimeError(
            "RealSense SDK missing. On Apple Silicon: python -m pip install pyrealsense2-macosx"
        ) from exc

    pipeline = rs.pipeline()
    config = rs.config()
    config.enable_stream(rs.stream.depth, width, height, rs.format.z16, fps)
    config.enable_stream(rs.stream.color, width, height, rs.format.bgr8, fps)
    profile = pipeline.start(config)
    depth_scale = profile.get_device().first_depth_sensor().get_depth_scale()
    align = rs.align(rs.stream.color)

    def frames() -> Iterator[Frame]:
        while True:
            aligned = align.process(pipeline.wait_for_frames())
            depth, color = aligned.get_depth_frame(), aligned.get_color_frame()
            if not depth or not color:
                continue
            yield Frame(
                color=np.asanyarray(color.get_data()).copy(),
                depth_m=np.asanyarray(depth.get_data()).astype(np.float32) * depth_scale,
            )

    try:
        yield frames()
    finally:
        pipeline.stop()
