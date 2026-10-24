"""Existing YOLO-seg labels → any task, remapping class names. Source
classes not in the mapping are dropped.

Two layouts are understood:

- **Split export** (Roboflow, CVAT, ...): ``data.yaml`` plus
  ``{train,valid,test}/{images,labels}``. ``valid`` and ``test`` go to validation.
- **Labelling workspace** (``frames`` / ``prelabel`` / X-AnyLabeling):
  ``images/``, ``labels/`` and ``classes.txt`` (or ``data.yaml``). Split
  randomly here.
"""

from collections.abc import Iterator
from pathlib import Path

import numpy as np
import yaml
from PIL import Image, ImageOps

from rover_vision.datasets.yolo import IMAGE_SUFFIXES, YoloSegWriter, random_split
from rover_vision.tasks import TaskSpec

SPLIT_ALIASES = {"train": "train", "valid": "val", "val": "val", "test": "val"}


def read_class_names(src: Path) -> list[str]:
    if (src / "data.yaml").exists():
        names = yaml.safe_load((src / "data.yaml").read_text())["names"]
        return [names[k] for k in sorted(names)] if isinstance(names, dict) else list(names)
    if (src / "classes.txt").exists():
        return [line.strip() for line in (src / "classes.txt").read_text().splitlines() if line.strip()]
    raise FileNotFoundError(f"{src} has neither data.yaml nor classes.txt")


def read_label_file(path: Path) -> list[tuple[int, np.ndarray]]:
    """YOLO-seg label → [(class id, (N, 2) polygon)]. Skips detection-only
    (box) rows, which have exactly 4 coordinates."""
    instances = []
    if not path.exists():
        return instances
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 7 or len(parts) % 2 == 0:
            continue
        coords = np.array(parts[1:], dtype=np.float32).reshape(-1, 2)
        instances.append((int(parts[0]), coords))
    return instances


def _images(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES) if folder.is_dir() else []


def iter_samples(src: Path, val_frac: float, seed: int) -> Iterator[tuple[Path, Path, str, str]]:
    """(image, label file, split, stem) for either layout."""
    split_dirs = sorted(p for p in src.iterdir() if p.is_dir() and p.name in SPLIT_ALIASES)
    if split_dirs:
        for split_dir in split_dirs:
            for image in _images(split_dir / "images"):
                label = split_dir / "labels" / f"{image.stem}.txt"
                yield image, label, SPLIT_ALIASES[split_dir.name], f"{split_dir.name}_{image.stem}"
        return

    images = _images(src / "images")
    if not images:
        raise FileNotFoundError(f"No images in {src}/images or {src}/<train|valid>/images")
    for image, split in zip(images, random_split(len(images), val_frac, seed)):
        yield image, src / "labels" / f"{image.stem}.txt", split, image.stem


def convert(
    src: Path,
    task: TaskSpec,
    mapping: dict[str, str] | None = None,
    source: str | None = None,
    val_frac: float = 0.15,
    seed: int = 0,
    skip_unlabelled: bool = True,
):
    """``mapping`` defaults to identity for source classes that share a name
    with a task class, which is the case for workspaces made by ``prelabel``.

    ``skip_unlabelled`` drops images whose label file doesn't exist yet
    (not labelled). An *empty* label file is kept as a deliberate background
    example.
    """
    src_names = read_class_names(src)
    if mapping is None:
        mapping = {name: name for name in src_names if name in task.names}
    unknown = set(mapping) - set(src_names)
    if unknown:
        raise KeyError(f"{sorted(unknown)} not among {src}'s classes {src_names}")
    if not mapping:
        raise ValueError(f"None of {src_names} match {task.name} classes; pass --map")
    remap = {i: task.class_id(mapping[name]) for i, name in enumerate(src_names) if name in mapping}

    with YoloSegWriter(task, source or src.name) as writer:
        for image_path, label_path, split, stem in iter_samples(src, val_frac, seed):
            if skip_unlabelled and not label_path.exists():
                writer.stats["unlabelled"] += 1
                continue
            instances = [(remap[c], poly) for c, poly in read_label_file(label_path) if c in remap]
            writer.add(ImageOps.exif_transpose(Image.open(image_path)), instances, split, stem)
    return writer.stats
