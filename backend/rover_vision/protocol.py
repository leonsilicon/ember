"""Decode frames sent by the iPhone app.

The wire format is the app's live keyframe message (``LiveStreamer.swift``,
``server/src/live/protocol.ts``), so the app can send what it already
builds:

    u32 little-endian header length | JSON header | JPEG | depth | confidence

Header fields used here (all others are ignored):

- ``intrinsics``: ``{fx, fy, cx, cy, width, height}`` for the JPEG.
- ``jpegBytes``: JPEG length.
- ``pose`` *(optional)*: ARKit camera-to-world, 16 floats, column-major.
  Without it, ``mount`` or the server's default mount says which way is up.
- ``depth`` *(optional)*: ``{width, height, confidence}``. float32 metres
  follow the JPEG, then, if ``confidence`` is true, uint8 ARKit confidence.

Additions for perception, all optional:

- ``leaves``: leaf boxes the phone already found, as
  ``[{"box": [x1, y1, x2, y2], "score": 0.12, "label": "dry leaf"}]``.
  Present (even empty) → the server doesn't run its own leaf detector.
- ``leavesFrame``: ``{width, height, turns}`` if those boxes are in a
  different frame than the JPEG: scaled to ``width`` x ``height`` after
  rotating the JPEG ``turns`` quarter turns counter-clockwise
  (``np.rot90``). For example, the app's upright detection frame.
- ``mount``: ``{pitchDeg, rollDeg, cameraHeightM}``, used when there's no pose.
- ``cameraHeightM``: lens height above the ground, if known.
"""

import json
import struct

import cv2
import numpy as np

from rover_vision.detection import Detection
from rover_vision.perception import FrameInput, rotate_points_back
from rover_vision.spatial import Intrinsics, Mount, up_from_arkit_pose, up_from_mount
from rover_vision.tasks import Role


class ProtocolError(ValueError):
    pass


def encode_message(header: dict, *payloads: bytes) -> bytes:
    """Build a message in the same format (for tests and Python clients)."""
    head = json.dumps(header).encode()
    return struct.pack("<I", len(head)) + head + b"".join(payloads)


def parse_message(data: bytes) -> tuple[dict, memoryview]:
    if len(data) < 4:
        raise ProtocolError("message too short")
    (length,) = struct.unpack_from("<I", data, 0)
    if 4 + length > len(data):
        raise ProtocolError("header runs past the message")
    try:
        header = json.loads(bytes(data[4 : 4 + length]))
    except json.JSONDecodeError as e:
        raise ProtocolError(f"header is not JSON: {e}") from None
    if not isinstance(header, dict):
        raise ProtocolError("header must be a JSON object")
    return header, memoryview(data)[4 + length :]


def _intrinsics(header: dict) -> Intrinsics:
    k = header.get("intrinsics")
    try:
        intrinsics = Intrinsics(float(k["fx"]), float(k["fy"]), float(k["cx"]), float(k["cy"]), int(k["width"]), int(k["height"]))
    except (TypeError, KeyError, ValueError):
        raise ProtocolError("intrinsics must be {fx, fy, cx, cy, width, height}") from None
    if min(intrinsics.fx, intrinsics.fy, intrinsics.width, intrinsics.height) <= 0:
        raise ProtocolError("intrinsics must be positive")
    return intrinsics


def _leaves(header: dict, image_size: tuple[int, int]) -> list[Detection] | None:
    raw = header.get("leaves")
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ProtocolError("leaves must be a list")
    w, h = image_size
    frame = header.get("leavesFrame") or {}
    turns = int(frame.get("turns", 0)) % 4
    rot_w, rot_h = (w, h) if turns % 2 == 0 else (h, w)
    sx = rot_w / float(frame.get("width", rot_w))
    sy = rot_h / float(frame.get("height", rot_h))

    leaves = []
    for item in raw:
        try:
            x1, y1, x2, y2 = (float(v) for v in item["box"])
        except (TypeError, KeyError, ValueError):
            raise ProtocolError("each leaf needs box: [x1, y1, x2, y2]") from None
        corners = rotate_points_back(np.array([[x1 * sx, y1 * sy], [x2 * sx, y2 * sy]]), turns, (w, h))
        (a, b), (c, d) = corners
        box = tuple(int(round(v)) for v in (min(a, c), min(b, d), max(a, c), max(b, d)))
        box = (max(0, box[0]), max(0, box[1]), min(w - 1, box[2]), min(h - 1, box[3]))
        leaves.append(
            Detection(
                task="leaves",
                label=str(item.get("label", "leaf")),
                role=Role.TARGET,
                confidence=float(item.get("score", 1.0)),
                box_xyxy=box,
                point_px=((box[0] + box[2]) // 2, (box[1] + box[3]) // 2),
                polygon_px=None,
            )
        )
    return leaves


def decode_frame(data: bytes, default_mount: Mount = Mount()) -> FrameInput:
    header, payload = parse_message(data)
    intrinsics = _intrinsics(header)

    jpeg_bytes = int(header.get("jpegBytes", -1))
    if not 0 < jpeg_bytes <= len(payload):
        raise ProtocolError("jpegBytes missing or longer than the payload")
    image = cv2.imdecode(np.frombuffer(payload[:jpeg_bytes], np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ProtocolError("image payload is not a decodable JPEG/PNG")
    h, w = image.shape[:2]
    rest = payload[jpeg_bytes:]

    depth = confidence = None
    if header.get("depth"):
        d = header["depth"]
        try:
            dw, dh, has_conf = int(d["width"]), int(d["height"]), bool(d.get("confidence"))
        except (TypeError, KeyError, ValueError):
            raise ProtocolError("depth must be {width, height, confidence}") from None
        need = dw * dh * (5 if has_conf else 4)
        if dw <= 0 or dh <= 0 or len(rest) < need:
            raise ProtocolError(f"depth payload needs {need} bytes, got {len(rest)}")
        depth = np.frombuffer(rest[: dw * dh * 4], dtype="<f4").reshape(dh, dw).astype(np.float32)
        if has_conf:
            confidence = np.frombuffer(rest[dw * dh * 4 : need], dtype=np.uint8).reshape(dh, dw)

    up = None
    if header.get("pose") is not None:
        pose = header["pose"]
        if not (isinstance(pose, list) and len(pose) == 16):
            raise ProtocolError("pose must be 16 numbers (column-major camera-to-world)")
        up = up_from_arkit_pose(pose)
    elif header.get("mount"):
        m = header["mount"]
        up = up_from_mount(Mount(float(m.get("pitchDeg", default_mount.pitch_deg)), float(m.get("rollDeg", default_mount.roll_deg))))

    height = header.get("cameraHeightM", (header.get("mount") or {}).get("cameraHeightM"))
    return FrameInput(
        image=image,
        intrinsics=intrinsics,
        up=up,
        depth_m=depth,
        confidence=confidence,
        leaves=_leaves(header, (w, h)),
        camera_height_m=None if height is None else float(height),
    )
