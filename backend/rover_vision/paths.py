"""Filesystem layout. Everything is relative to the backend folder so the
commands work no matter where they are launched from."""

from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
RAW_DIR = DATA_DIR / "raw"  # downloaded datasets, untouched
YOLO_DIR = DATA_DIR / "yolo"  # converted training sets, one folder per task
RUNS_DIR = BACKEND_DIR / "runs"  # training output
