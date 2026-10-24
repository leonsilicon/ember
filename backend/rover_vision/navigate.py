"""Live loop: hazards + leaves + (optional) depth → driving decision.

The hazard model is fast (~30 ms) and runs on every frame. OWL-ViT is slow
(~1.5 s), so it runs in a background thread on the newest frame while the
loop keeps going, and its latest result is reused until a new one lands.
Leaf boxes can therefore lag a moving camera by a second or so; hazards
never do.
"""

import json
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import cv2

from rover_vision.camera import IMAGE_SUFFIXES, open_source
from rover_vision.detect import Detector
from rover_vision.detection import Detection
from rover_vision.navigation import NavConfig, decide, draw_navigation
from rover_vision.render import draw_detections
from rover_vision.tasks import HAZARDS

WINDOW = "rover navigation (q to quit)"


def run(
    source: str = "0",
    use_hazard_model: bool = True,
    hazard_weights: Path | None = None,
    hazard_conf: float = 0.35,
    hazard_device: str | None = None,
    hazard_imgsz: int = 512,  # training size; ~75 ms/frame on M4 CPU vs ~135 ms at 640
    leaf_threshold: float = 0.05,
    tile_grid: int = 2,
    cfg: NavConfig = NavConfig(),
    show: bool = True,
    save: Path | None = None,
    emit_json: bool = False,
):
    from rover_vision.leaves import LeafDetector  # heavy import (transformers); keep CLI startup fast

    leaf_model = LeafDetector(leaf_threshold, tile_grid)
    # PyTorch's MPS backend is not thread-safe: OWL-ViT encoding on the GPU in
    # its background thread while the hazard model also uses the GPU aborts
    # the process ("A command encoder is already encoding"). The nano hazard
    # model is fast enough on CPU, so the GPU stays OWL-ViT's alone.
    if hazard_device is None:
        hazard_device = "cpu" if leaf_model.device == "mps" else None
    hazards_model = (
        Detector(
            [HAZARDS],
            {HAZARDS.name: hazard_weights} if hazard_weights else None,
            conf=hazard_conf,
            imgsz=hazard_imgsz,
            device=hazard_device,
        )
        if use_hazard_model
        else None
    )
    single_image = Path(source).suffix.lower() in IMAGE_SUFFIXES

    leaves: list[Detection] = []
    pending: Future | None = None
    writer = None
    fps = None
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="owlvit") as pool, open_source(source) as frames:
        for index, frame in enumerate(frames):
            start = time.perf_counter()
            if single_image:
                leaves = leaf_model(frame.color)  # nothing to overlap with; just wait
            else:
                if pending is not None and pending.done():
                    leaves = pending.result()
                    pending = None
                if pending is None:
                    pending = pool.submit(leaf_model, frame.color.copy())

            hazards = hazards_model(frame.color) if hazards_model else []
            decision = decide(frame.color.shape, leaves, hazards, frame.depth_m, cfg)
            elapsed = time.perf_counter() - start
            fps = 1 / elapsed if fps is None else 0.9 * fps + 0.1 / elapsed

            if emit_json:
                sys.stdout.write(json.dumps({"frame": index, **decision.to_payload()}) + "\n")
                sys.stdout.flush()

            view = draw_navigation(draw_detections(frame.color, hazards + leaves), decision, cfg)
            if not single_image:
                label = f"{fps:.0f} FPS" + ("  leaves: updating" if pending is not None else "")
                origin = (view.shape[1] - 230, 22)  # top-right, clear of box labels at the top-left
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
