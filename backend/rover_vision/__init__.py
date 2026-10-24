"""Rover perception on the Mac: the OWL-ViT leaf detector, depth-based
obstacle mapping, and an HTTP service mirroring the iPhone app's rover brain."""

import sys

if sys.version_info < (3, 10):
    sys.exit(
        f"rover_vision needs Python 3.10+, but this is {sys.version.split()[0]} ({sys.executable}).\n"
        "Use the backend's own environment: cd backend && source .venv/bin/activate "
        "(or run .venv/bin/python -m rover_vision ...)."
    )
