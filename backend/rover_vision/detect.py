"""Run one or more task models on a camera, video, stream, image or folder
of images, and draw the results."""

import json
import sys
import time
from collections.abc import Iterator, Sequence
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

from rover_vision.datasets.yolo import IMAGE_SUFFIXES
from rover_vision.detection import Detection, detections_from_result
from rover_vision.device import default_device
from rover_vision.render import draw_detections, draw_hud
from rover_vision.tasks import TaskSpec

WINDOW = "rover vision (q to quit)"


class Detector:
    """Holds one model per task and runs all of them on each frame."""

    def __init__(
        self,
        tasks: Sequence[TaskSpec],
        weights: dict[str, Path] | None = None,
        conf: float = 0.35,
        imgsz: int = 640,
        device: str | None = None,
    ):
        weights = weights or {}
        self.models: list[tuple[TaskSpec, YOLO]] = []
        for task in tasks:
            path = Path(weights.get(task.name, task.best_weights))
            if not path.exists():
                raise FileNotFoundError(f"No {task.name} weights at {path}. Train first: python -m rover_vision train {task.name}")
            self.models.append((task, YOLO(str(path))))
        self.conf = conf
        self.imgsz = imgsz
        self.device = device or default_device()

    def __call__(self, frame: np.ndarray) -> list[Detection]:
        detections = []
        for task, model in self.models:
            result = model.predict(frame, conf=self.conf, imgsz=self.imgsz, device=self.device, verbose=False)[0]
            detections += detections_from_result(result, task)
        return detections


def _is_image_source(source: str) -> bool:
    path = Path(source)
    return path.is_dir() or path.suffix.lower() in IMAGE_SUFFIXES


def _image_paths(source: str) -> Iterator[Path]:
    path = Path(source)
    if path.is_file():
        yield path
    else:
        yield from sorted(p for p in path.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)


def _emit_json(frame_index: int, detections: list[Detection]):
    payload = {"frame": frame_index, "detections": [d.to_dict() for d in detections]}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def run_images(detector: Detector, source: str, save_dir: Path | None, show: bool, emit_json: bool):
    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)
    for i, path in enumerate(_image_paths(source)):
        frame = cv2.imread(str(path))
        if frame is None:
            print(f"skip unreadable image {path}", file=sys.stderr)
            continue
        detections = detector(frame)
        if emit_json:
            _emit_json(i, detections)
        annotated = draw_hud(draw_detections(frame, detections), None, detections)
        if save_dir:
            cv2.imwrite(str(save_dir / f"{path.stem}_pred.jpg"), annotated)
        if show:
            cv2.imshow(WINDOW, annotated)
            if cv2.waitKey(0) & 0xFF == ord("q"):
                break
    cv2.destroyAllWindows()


def run_stream(detector: Detector, source: str, save_path: Path | None, show: bool, emit_json: bool):
    capture_source = int(source) if source.isdigit() else source
    cap = cv2.VideoCapture(capture_source)
    if not cap.isOpened():
        hint = " (on macOS, allow camera access for your terminal in System Settings)" if source.isdigit() else ""
        raise RuntimeError(f"Could not open video source {source!r}{hint}")

    writer = None
    fps = None
    frame_index = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            start = time.perf_counter()
            detections = detector(frame)
            elapsed = time.perf_counter() - start
            fps = 1 / elapsed if fps is None else 0.9 * fps + 0.1 / elapsed  # smoothed

            if emit_json:
                _emit_json(frame_index, detections)
            annotated = draw_hud(draw_detections(frame, detections), fps, detections)

            if save_path:
                if writer is None:
                    save_path.parent.mkdir(parents=True, exist_ok=True)
                    h, w = annotated.shape[:2]
                    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
                    writer = cv2.VideoWriter(str(save_path), cv2.VideoWriter_fourcc(*"mp4v"), src_fps, (w, h))
                writer.write(annotated)
            if show:
                cv2.imshow(WINDOW, annotated)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
            frame_index += 1
    finally:
        cap.release()
        if writer:
            writer.release()
        cv2.destroyAllWindows()


def run(detector: Detector, source: str, save: Path | None = None, show: bool = True, emit_json: bool = False):
    """``save`` is an output folder for image sources and a video file for streams."""
    if _is_image_source(source):
        run_images(detector, source, save, show, emit_json)
    else:
        run_stream(detector, source, save, show, emit_json)
