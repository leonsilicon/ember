import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from rover_vision.perception import Perception
from rover_vision.protocol import ProtocolError, decode_frame, encode_message
from rover_vision.server import create_app
from tests.scenes import camera, render_depth

W, H = 160, 120


def message(leaves=None, pose=True, depth=True, frame=None):
    cam = camera(w=W, h=H)
    ok, jpeg = cv2.imencode(".jpg", np.full((H, W, 3), 90, np.uint8))
    k = cam.intrinsics
    header = {"type": "keyframe", "intrinsics": {"fx": k.fx, "fy": k.fy, "cx": k.cx, "cy": k.cy, "width": W, "height": H},
              "jpegBytes": len(jpeg)}
    payloads = [jpeg.tobytes()]
    if pose:
        header["pose"] = np.eye(4).reshape(-1).tolist()
    if depth:
        d = np.nan_to_num(render_depth(cam)[::2, ::2])
        header["depth"] = {"width": d.shape[1], "height": d.shape[0], "confidence": True}
        payloads += [d.astype("<f4").tobytes(), np.full(d.shape, 2, np.uint8).tobytes()]
    if leaves is not None:
        header["leaves"] = leaves
    if frame is not None:
        header["leavesFrame"] = frame
    return encode_message(header, *payloads)


def test_decode_full_message():
    f = decode_frame(message(leaves=[{"box": [10, 20, 30, 40], "score": 0.3, "label": "dry leaf"}]))
    assert f.image.shape == (H, W, 3)
    assert f.depth_m.shape == (H // 2, W // 2) and f.confidence.dtype == np.uint8
    assert np.allclose(f.up, [0, -1, 0])  # identity ARKit pose: level camera
    assert f.leaves[0].box_xyxy == (10, 20, 30, 40) and f.leaves[0].confidence == pytest.approx(0.3)


def test_leaves_frame_scaling_and_rotation_map_back_to_the_jpeg():
    # Boxes from an upright frame: the JPEG rotated a quarter turn clockwise
    # (np.rot90 k=3) and scaled to half size (60 x 80).
    f = decode_frame(message(leaves=[{"box": [0, 0, 10, 10]}], frame={"width": 60, "height": 80, "turns": 3}))
    x1, y1, x2, y2 = f.leaves[0].box_xyxy
    # The rotated image's top-left corner is the JPEG's bottom-left.
    assert x1 == 0 and y2 == H - 1 and x2 == pytest.approx(20, abs=1) and y1 == pytest.approx(H - 21, abs=1)


@pytest.mark.parametrize("bad", [b"", b"\x05\x00\x00\x00{}", b"\x02\x00\x00\x00[]"])
def test_bad_messages_raise(bad):
    with pytest.raises(ProtocolError):
        decode_frame(bad)


def test_missing_intrinsics_and_short_depth_raise():
    with pytest.raises(ProtocolError, match="intrinsics"):
        decode_frame(encode_message({"jpegBytes": 1}, b"x"))
    data = bytearray(message())
    with pytest.raises(ProtocolError, match="depth"):
        decode_frame(bytes(data[:-100]))


def test_server_endpoints():
    client = TestClient(create_app(Perception()))
    assert client.get("/v1/health").json()["schema"] == "rover-perception/1"
    r = client.post("/v1/perceive", content=message(leaves=[{"box": [70, 100, 90, 115]}]))
    assert r.status_code == 200
    body = r.json()
    assert body["camera"]["height_source"] == "depth_fit"
    assert body["leaves"][0]["position"]["source"] == "depth"
    assert "grid" not in client.post("/v1/perceive?grid=0", content=message(leaves=[])).json()
    img = client.post("/v1/perceive/annotated", content=message(leaves=[]))
    assert img.headers["content-type"] == "image/jpeg" and img.content[:2] == b"\xff\xd8"
    assert client.post("/v1/perceive", content=b"junk").status_code == 400
