"""Loading the hazard model and leaf detector with compatible devices."""

from pathlib import Path

from rover_vision.detect import Detector
from rover_vision.tasks import HAZARDS


def load_models(
    hazard_model: bool = True,
    hazard_weights: Path | None = None,
    hazard_conf: float = 0.35,
    hazard_imgsz: int = 512,  # its training size; ~75 ms/frame on an M4 CPU vs ~135 ms at 640
    hazard_device: str | None = None,
    leaf_detector: bool = True,
    leaf_threshold: float = 0.05,
    tile_grid: int = 2,
):
    """Returns ``(hazard_detector | None, leaf_detector | None)``.

    PyTorch's MPS backend is not thread-safe: two threads using the Apple
    GPU at once abort the process ("A command encoder is already
    encoding"). OWL-ViT needs the GPU most (~1.5 s/frame vs ~5 s on CPU),
    and the nano hazard model is quick on CPU, so the hazard model goes on
    the CPU whenever OWL-ViT is on MPS.
    """
    leaves = None
    if leaf_detector:
        from rover_vision.leaves import LeafDetector  # heavy import (transformers)

        leaves = LeafDetector(leaf_threshold, tile_grid)
    if hazard_device is None and leaves is not None and leaves.device == "mps":
        hazard_device = "cpu"
    hazards = None
    if hazard_model:
        weights = {HAZARDS.name: hazard_weights} if hazard_weights else None
        hazards = Detector([HAZARDS], weights, conf=hazard_conf, imgsz=hazard_imgsz, device=hazard_device)
    return hazards, leaves
