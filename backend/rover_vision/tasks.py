"""The trained perception tasks and their class lists.

- ``hazards``: what not to drive into (water, rocks, logs, trees, ...), a
  YOLOv8-seg model trained here.

Leaves are found by the open-vocabulary detector in ``leaf_detector.py``,
which needs no training. The earlier trained ``litter`` task is in
``archive/leaf-training``.

Class order is the model's class id order and must not change once a model
has been trained; append new classes at the end.
"""

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from rover_vision.paths import RUNS_DIR, YOLO_DIR


class Role(str, Enum):
    TARGET = "target"  # pick up: the grasp point is the mask centroid
    AVOID = "avoid"  # don't pick up, but safe to drive near
    HAZARD = "hazard"  # don't drive into: the key point is the ground contact


@dataclass(frozen=True)
class TaskSpec:
    name: str
    description: str
    classes: tuple[tuple[str, Role], ...]
    # Ultralytics augmentation overrides, tuned to how the camera sees the scene.
    augment: dict = field(default_factory=dict)

    @property
    def names(self) -> list[str]:
        return [name for name, _ in self.classes]

    def class_id(self, name: str) -> int:
        try:
            return self.names.index(name)
        except ValueError:
            raise KeyError(f"{name!r} is not a {self.name} class; expected one of {self.names}") from None

    def role_of(self, name: str) -> Role:
        return dict(self.classes)[name]

    @property
    def dataset_dir(self) -> Path:
        return YOLO_DIR / self.name

    @property
    def data_yaml(self) -> Path:
        return self.dataset_dir / "data.yaml"

    @property
    def run_dir(self) -> Path:
        return RUNS_DIR / "segment" / self.name

    @property
    def best_weights(self) -> Path:
        return self.run_dir / "weights" / "best.pt"


HAZARDS = TaskSpec(
    name="hazards",
    description="Things the rover must not drive into",
    classes=(
        ("water", Role.HAZARD),
        ("rock", Role.HAZARD),
        ("log", Role.HAZARD),
        ("tree", Role.HAZARD),
        ("bush", Role.HAZARD),
        ("person", Role.HAZARD),
        ("structure", Role.HAZARD),  # fences, poles, buildings, vehicles, man-made objects
    ),
    # Forward-facing camera: sky is always up, so no vertical flips; keep
    # rotation small. Mild hue jitter so muddy and blue water both count.
    augment=dict(hsv_h=0.01, hsv_s=0.6, hsv_v=0.4, degrees=5.0, flipud=0.0, fliplr=0.5),
)

TASKS: dict[str, TaskSpec] = {t.name: t for t in (HAZARDS,)}


def get_task(name: str) -> TaskSpec:
    try:
        return TASKS[name]
    except KeyError:
        raise KeyError(f"Unknown task {name!r}; expected one of {sorted(TASKS)}") from None
