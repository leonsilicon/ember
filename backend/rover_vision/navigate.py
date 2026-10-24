"""Live loop on a webcam, video, image or RealSense: perception per frame,
drawn with the top-down minimap.

The hazard model (~75 ms) and the geometry run on every frame. OWL-ViT is
slow (~1.5 s), so it runs in a background thread on the newest frame while
the loop keeps going, and its latest boxes are reused until new ones land.
Leaf boxes can lag a moving camera by a second or so; hazards never do.
"""

import json
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import cv2

from rover_vision.camera import IMAGE_SUFFIXES, open_source
from rover_vision.detection import Detection
from rover_vision.navigation import draw_perception
from rover_vision.perception import FrameInput, Perception
from rover_vision.spatial import Intrinsics

WINDOW = "rover perception (q to quit)"


def run(
    perception: Perception,
    leaf_detector=None,
    source: str = "0",
    hfov_deg: float = 69.0,
    show: bool = True,
    save: Path | None = None,
    emit_json: bool = False,
):
    """``perception`` should have no leaf detector of its own; pass it as
    ``leaf_detector`` so it can run in the background."""
    single_image = Path(source).suffix.lower() in IMAGE_SUFFIXES
    leaves: list[Detection] = []
    pending: Future | None = None
    writer = None
    fps = None
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="owlvit") as pool, open_source(source) as frames:
        for index, frame in enumerate(frames):
            start = time.perf_counter()
            if leaf_detector is not None:
                if single_image:
                    leaves = leaf_detector(frame.color)
                else:
                    if pending is not None and pending.done():
                        leaves = pending.result()
                        pending = None
                    if pending is None:
                        pending = pool.submit(leaf_detector, frame.color.copy())

            h, w = frame.color.shape[:2]
            intrinsics = frame.intrinsics or Intrinsics.from_hfov(w, h, hfov_deg)
            result = perception.perceive(FrameInput(frame.color, intrinsics, depth_m=frame.depth_m, leaves=leaves))
            elapsed = time.perf_counter() - start
            fps = 1 / elapsed if fps is None else 0.9 * fps + 0.1 / elapsed

            if emit_json:
                sys.stdout.write(json.dumps({"frame": index, **result.to_dict(include_grid=False)}) + "\n")
                sys.stdout.flush()

            view = draw_perception(frame.color, result)
            if not single_image:
                label = f"{fps:.0f} FPS" + ("  leaves: updating" if pending is not None else "")
                origin = (10, 22)
                cv2.putText(view, label, origin, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 3, cv2.LINE_AA)
                cv2.putText(view, label, origin, cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)

            if save:
                if single_image:
                    cv2.imwrite(str(save), view)
                else:
                    if writer is None:
                        save.parent.mkdir(parents=True, exist_ok=True)
                        writer = cv2.VideoWriter(str(save), cv2.VideoWriter_fourcc(*"mp4v"), 15, view.shape[1::-1])
                    writer.write(view)
            if show:
                cv2.imshow(WINDOW, view)
                if cv2.waitKey(0 if single_image else 1) & 0xFF == ord("q"):
                    break
    if writer:
        writer.release()
    if show:
        cv2.destroyAllWindows()
