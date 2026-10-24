import json
from pathlib import Path

from ultralytics import YOLO

from rover_vision.tasks import TaskSpec


def export_coreml(task: TaskSpec, weights: Path | None = None, imgsz: int = 640, half: bool = True) -> Path:
    """Export to a CoreML ``.mlpackage`` for the iPhone app, plus a
    ``<name>.labels.json`` sidecar with each class's role (target / avoid /
    hazard). The app needs the roles to decide which key point to depth-sample."""
    weights = Path(weights or task.best_weights)
    if not weights.exists():
        raise FileNotFoundError(f"No weights at {weights}. Train first: python -m rover_vision train {task.name}")

    package = Path(YOLO(str(weights)).export(format="coreml", imgsz=imgsz, half=half))
    sidecar = package.with_name(f"{task.name}.labels.json")
    sidecar.write_text(
        json.dumps(
            {
                "task": task.name,
                "imgsz": imgsz,
                "classes": [{"id": i, "name": name, "role": role.value} for i, (name, role) in enumerate(task.classes)],
            },
            indent=2,
        )
    )
    return package
