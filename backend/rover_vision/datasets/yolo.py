"""Writing YOLO-seg training sets.

Layout per task::

    data/yolo/<task>/
        data.yaml
        images/{train,val}/<source>__<stem>.jpg
        labels/{train,val}/<source>__<stem>.txt

Every converter writes through :class:`YoloSegWriter`, tagged with a source
name. Several sources can be stacked into one task, and re-running a
converter replaces only that source's files.
"""

import random
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path

import numpy as np
import yaml
from PIL import Image

from rover_vision.tasks import TaskSpec

SPLITS = ("train", "val")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
SOURCE_SEP = "__"

Instance = tuple[int, np.ndarray]  # (class id, normalised (N, 2) polygon)


def format_label_line(class_id: int, polygon: np.ndarray) -> str:
    coords = " ".join(f"{v:.5f}" for v in np.asarray(polygon, dtype=np.float64).reshape(-1))
    return f"{class_id} {coords}"


def write_data_yaml(task: TaskSpec, root: Path | None = None) -> Path:
    root = root or task.dataset_dir
    path = root / "data.yaml"
    root.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(
            {
                "path": str(root.resolve()),
                "train": "images/train",
                "val": "images/val",
                "names": dict(enumerate(task.names)),
            },
            sort_keys=False,
        )
    )
    return path


def random_split(n: int, val_frac: float, seed: int) -> list[str]:
    """Per-item split for datasets of independent photos."""
    n_val = max(1, round(n * val_frac)) if n > 1 else 0
    order = list(range(n))
    random.Random(seed).shuffle(order)
    val = set(order[:n_val])
    return ["val" if i in val else "train" for i in range(n)]


def group_split(group_sizes: Mapping[str, int], val_frac: float, seed: int) -> set[str]:
    """Pick whole groups (e.g. video sequences) for validation until they
    hold at least ``val_frac`` of the items.

    Splitting by sequence rather than by frame stops near-identical
    neighbouring frames from leaking into validation and inflating scores.
    """
    groups = sorted(group_sizes)
    if len(groups) < 2:
        return set()
    random.Random(seed).shuffle(groups)
    total = sum(group_sizes.values())
    val, count = set(), 0
    for g in groups[:-1]:  # always leave at least one group for training
        if count >= val_frac * total:
            break
        val.add(g)
        count += group_sizes[g]
    return val


def parse_class_mapping(text: str, task: TaskSpec) -> dict[str, str]:
    """``"src_a=dst_x,src_b=dst_y"`` → dict, validated against the task."""
    mapping = {}
    for pair in filter(None, (p.strip() for p in text.split(","))):
        if "=" not in pair:
            raise ValueError(f"Bad mapping entry {pair!r}; expected source_class=task_class")
        src, dst = (s.strip() for s in pair.split("=", 1))
        task.class_id(dst)  # raises with the valid options
        mapping[src] = dst
    if not mapping:
        raise ValueError("Class mapping is empty")
    return mapping


class YoloSegWriter:
    """Accumulates (image, instances) pairs for one source into a task's
    dataset folder. Use as a context manager; data.yaml is written on exit."""

    def __init__(self, task: TaskSpec, source: str, max_side: int = 1280, root: Path | None = None):
        if SOURCE_SEP in source:
            raise ValueError(f"source name may not contain {SOURCE_SEP!r}")
        self.task = task
        self.source = source
        self.max_side = max_side
        self.root = root or task.dataset_dir
        self.stats: Counter = Counter()
        self._clear_previous()

    def __enter__(self) -> "YoloSegWriter":
        return self

    def __exit__(self, exc_type, *_):
        if exc_type is None:
            write_data_yaml(self.task, self.root)

    def _clear_previous(self):
        prefix = f"{self.source}{SOURCE_SEP}"
        for kind in ("images", "labels"):
            for split in SPLITS:
                d = self.root / kind / split
                d.mkdir(parents=True, exist_ok=True)
                for f in d.glob(f"{prefix}*"):
                    f.unlink()
        # Ultralytics label caches would otherwise describe the old file set.
        for cache in (self.root / "labels").glob("*.cache"):
            cache.unlink()

    def add(self, image: Image.Image, instances: Iterable[Instance], split: str, stem: str):
        if split not in SPLITS:
            raise ValueError(f"split must be one of {SPLITS}, got {split!r}")
        name = f"{self.source}{SOURCE_SEP}{stem}"
        image = image.convert("RGB")
        if max(image.size) > self.max_side:
            image = image.copy()
            image.thumbnail((self.max_side, self.max_side))
        image.save(self.root / "images" / split / f"{name}.jpg", quality=92)

        # Polygons are normalised, so resizing the image doesn't affect them.
        instances = list(instances)
        lines = [format_label_line(cls, poly) for cls, poly in instances]
        (self.root / "labels" / split / f"{name}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))

        self.stats[split] += 1
        self.stats["instances"] += len(instances)
        if not instances:
            self.stats["background"] += 1
        for cls, _ in instances:
            self.stats[self.task.names[cls]] += 1
