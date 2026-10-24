"""RUGD (Robot Unstructured Ground Driving) → ``hazards`` task.

About 7.4k off-road frames from a small ground robot (creeks, trails, parks),
with dense colour-coded semantic masks for 24 classes. Download:
https://huggingface.co/datasets/WilliamBonilla62/RUGD (a mirror of
http://rugd.vision). The licence is for research use; see the RUGD site.

Layout::

    RUGD_frames-with-annotations/<scene>/<scene>_00001.png
    RUGD_annotations/<scene>/<scene>_00001.png
    RUGD_annotation-colormap.txt          "<id> <name> <r> <g> <b>" per line

Semantic masks are split into instances by connected component. Validation
holds out whole scenes (see :func:`group_split`).
"""

from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

from rover_vision.datasets.yolo import YoloSegWriter, group_split
from rover_vision.geometry import mask_to_polygons
from rover_vision.paths import RAW_DIR
from rover_vision.tasks import HAZARDS

SOURCE = "rugd"
DEFAULT_SRC = RAW_DIR / "rugd"

# RUGD class → hazards class. Unlisted classes (dirt, sand, grass, gravel,
# mulch, asphalt, concrete, bridge, sky, void) are drivable or irrelevant
# and stay background.
RUGD_TO_HAZARD = {
    "water": "water",
    "rock": "rock",
    "rock-bed": "rock",
    "log": "log",
    "tree": "tree",
    "bush": "bush",
    "person": "person",
    "vehicle": "structure",
    "container/generic-object": "structure",
    "building": "structure",
    "fence": "structure",
    "pole": "structure",
    "sign": "structure",
    "picnic-table": "structure",
    "bicycle": "structure",
}


def load_colormap(path: Path) -> dict[str, tuple[int, int, int]]:
    colormap = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) == 5:
            _, name, r, g, b = parts
            colormap[name] = (int(r), int(g), int(b))
    if not colormap:
        raise ValueError(f"No colours parsed from {path}")
    return colormap


def _pack_rgb(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.uint32)
    return (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]


def decode_annotation(
    annotation: np.ndarray,
    colormap: dict[str, tuple[int, int, int]],
    mapping: dict[str, str] = RUGD_TO_HAZARD,
) -> dict[int, np.ndarray]:
    """Colour-coded (H, W, 3) annotation → {hazard class id: bool mask}.
    Several RUGD classes can feed one hazard class (e.g. rock + rock-bed)."""
    packed = _pack_rgb(annotation[..., :3])
    colours_by_class: dict[int, list[int]] = {}
    for rugd_name, hazard_name in mapping.items():
        if rugd_name in colormap:
            r, g, b = colormap[rugd_name]
            colours_by_class.setdefault(HAZARDS.class_id(hazard_name), []).append((r << 16) | (g << 8) | b)
    masks = {}
    for class_id, colours in colours_by_class.items():
        mask = np.isin(packed, colours)
        if mask.any():
            masks[class_id] = mask
    return masks


def find_samples(src: Path) -> list[tuple[str, Path, Path]]:
    """(scene, frame, annotation) triples, sorted for reproducibility."""
    samples = []
    for ann in sorted((src / "RUGD_annotations").glob("*/*.png")):
        scene = ann.parent.name
        frame = src / "RUGD_frames-with-annotations" / scene / ann.name
        if frame.exists():
            samples.append((scene, frame, ann))
    return samples


def convert(src: Path = DEFAULT_SRC, stride: int = 2, val_frac: float = 0.15, seed: int = 0, min_area_frac: float = 0.0005):
    """``stride`` keeps every Nth annotated frame. Neighbouring frames are
    nearly identical, so 2 halves the training time for little loss."""
    colormap = load_colormap(src / "RUGD_annotation-colormap.txt")
    samples = find_samples(src)
    if not samples:
        raise FileNotFoundError(f"No RUGD frames under {src}. Expected {src}/RUGD_annotations/<scene>/*.png")
    samples = samples[:: max(1, stride)]

    val_scenes = group_split(Counter(scene for scene, _, _ in samples), val_frac, seed)
    print(f"RUGD: {len(samples)} frames, validation scenes: {sorted(val_scenes)}")

    with YoloSegWriter(HAZARDS, SOURCE) as writer:
        for scene, frame, ann in samples:
            annotation = np.array(Image.open(ann).convert("RGB"))
            instances = [
                (class_id, polygon)
                for class_id, mask in decode_annotation(annotation, colormap).items()
                for polygon in mask_to_polygons(mask, min_area_frac=min_area_frac)
            ]
            split = "val" if scene in val_scenes else "train"
            writer.add(Image.open(frame), instances, split, f"{scene}_{frame.stem}")
    return writer.stats
