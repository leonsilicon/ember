"""HTTP API for the phone app.

    python -m rover_vision serve            # http://0.0.0.0:8765

``POST /v1/perceive``: body is one frame in the app's keyframe format
(see ``protocol.py``); returns ``rover-perception/1`` JSON (see
``perception.py``). ``?grid=0`` leaves out the occupancy grid.

``POST /v1/perceive/annotated``: same input, returns a JPEG of the overlay,
for debugging.

``GET /v1/health``: which models are loaded.
"""

import threading

import cv2
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

from rover_vision.navigation import draw_perception
from rover_vision.perception import SCHEMA, Perception
from rover_vision.protocol import ProtocolError, decode_frame
from rover_vision.spatial import Mount

MAX_BODY_BYTES = 32 * 1024 * 1024


def create_app(perception: Perception, mount: Mount = Mount()) -> FastAPI:
    app = FastAPI(title="rover-vision", version="1")
    # One frame at a time: PyTorch's MPS backend (OWL-ViT on the Apple GPU)
    # crashes if two threads use it at once.
    lock = threading.Lock()

    async def read_frame(request: Request):
        body = await request.body()
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(413, f"frame larger than {MAX_BODY_BYTES} bytes")
        try:
            frame = decode_frame(body, mount)
        except ProtocolError as e:
            raise HTTPException(400, str(e)) from None
        if frame.leaves is None and perception.leaf_detector is None:
            frame.leaves = []  # nothing to detect them with; say so in /v1/health
        return frame

    @app.get("/v1/health")
    def health():
        return {
            "ok": True,
            "schema": SCHEMA,
            "leaf_detector": perception.leaf_detector is not None,
            "mount": {"pitch_deg": mount.pitch_deg, "roll_deg": mount.roll_deg, "camera_height_m": mount.camera_height_m},
        }

    @app.post("/v1/perceive")
    async def perceive(request: Request, grid: bool = True):
        frame = await read_frame(request)
        with lock:
            result = perception.perceive(frame)
        return result.to_dict(include_grid=grid)

    @app.post("/v1/perceive/annotated")
    async def perceive_annotated(request: Request):
        frame = await read_frame(request)
        with lock:
            result = perception.perceive(frame)
        ok, jpeg = cv2.imencode(".jpg", draw_perception(frame.image, result), [cv2.IMWRITE_JPEG_QUALITY, 85])
        return Response(jpeg.tobytes(), media_type="image/jpeg")

    return app
