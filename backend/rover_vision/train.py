from pathlib import Path

from ultralytics import YOLO

from rover_vision.device import default_device
from rover_vision.tasks import TaskSpec


def train(
    task: TaskSpec,
    base_model: str = "yolov8n-seg.pt",
    epochs: int = 100,
    imgsz: int = 640,
    batch: int = 16,
    device: str | None = None,
    patience: int = 25,
    resume: bool = False,
) -> Path:
    """Fine-tune a YOLOv8-seg model on ``task``'s dataset and return the path
    of the best weights.

    yolov8n-seg is the default because it runs in real time on the iPhone's
    Neural Engine; try s/m if accuracy matters more than frame rate.
    """
    if not task.data_yaml.exists():
        raise FileNotFoundError(f"{task.data_yaml} not found. Run `python -m rover_vision prepare ...` first.")

    if resume:
        model = YOLO(str(task.run_dir / "weights" / "last.pt"))
        model.train(resume=True)
    else:
        model = YOLO(base_model)
        model.train(
            data=str(task.data_yaml),
            epochs=epochs,
            imgsz=imgsz,
            batch=batch,
            device=device or default_device(),
            project=str(task.run_dir.parent),  # pinned so Ultralytics' global runs_dir doesn't apply
            name=task.name,
            exist_ok=True,
            patience=patience,
            **task.augment,
        )
    return task.best_weights
