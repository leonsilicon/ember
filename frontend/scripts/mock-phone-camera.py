"""A stand-in for the rover app's Wi-Fi camera, for working on the web app's live mode without the iPhone.

Serves the same routes as the app's CameraStreamServer, /detections included (a box on the leaf and the pile,
and the brain's map for the live top view: a rover working the circle round a pile) (apps/expo-app/modules/splat-capture/ios/
SplatCaptureCore/Sources/SplatCaptureCore/CameraStreamServer.swift): /camera.mjpg, /frame.jpg and /status,
with a moving test picture at about 12 fps. Needs Pillow (`pip install pillow`).

Like the app, it advertises itself with Bonjour as _rovercam._tcp (using macOS's dns-sd), so the web app's
dev server finds it and the Control page's camera panel links up by itself.

    python3 frontend/scripts/mock-phone-camera.py                # port 8787, advertised
    python3 frontend/scripts/mock-phone-camera.py --port 9000 --no-advertise

Without advertising, enter 127.0.0.1 in the iPhone camera panel (Control page, Live mode).
"""

import argparse
import io
import json
import math
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw

WIDTH, HEIGHT, FPS = 480, 640, 12
START = time.time()
# Like the app's, /status counts frames made, not frames sent: it's the same whatever the viewer count.
viewers = 0
lock = threading.Lock()


def leaf_at(t: float):
    """Where the test picture's leaf is at time t, in pixels."""
    cx, cy = WIDTH / 2, HEIGHT * 0.68
    return cx + math.cos(t) * 150, cy + math.sin(t) * 60


def detections(t: float) -> bytes:
    """Boxes as the app streams them: fractions of the frame, with the camera screen's colours and tags."""
    x, y = leaf_at(t)
    cx, cy = WIDTH / 2, HEIGHT * 0.68
    boxes = [
        {"id": 1, "x0": (x - 20) / WIDTH, "y0": (y - 15) / HEIGHT, "x1": (x + 20) / WIDTH, "y1": (y + 15) / HEIGHT,
         "color": "#FFD60A", "text": f"dry leaf {1.2 + math.sin(t) * 0.4:.1f} m", "coasting": False},
        {"id": 2, "x0": (cx - 76) / WIDTH, "y0": (cy - 34) / HEIGHT, "x1": (cx + 76) / WIDTH, "y1": (cy + 34) / HEIGHT,
         "color": "#FF9F0A", "text": "pile of leaves 1.0 m · ✕ in the pile", "coasting": False},
    ]
    return json.dumps({"t": int(time.time() * 1000), "width": WIDTH, "height": HEIGHT, "boxes": boxes}).encode() + b"\n"


# The brain's map, as the app streams it beside the boxes (mobile/src/lib/rover-brain/live-map.ts): a
# rover working a 6 ft circle round a pile, a binful at a time, with a few leaves about.
PILE = (0.0, 0.0)
MAP_LEAVES = [(1, 1.1, -0.6), (2, -0.9, 0.8), (3, 0.4, 1.4), (4, -1.3, -1.0), (5, 1.5, 0.9), (6, -0.2, -1.6)]


def live_map(t: float) -> bytes:
    """One map line: the rover drives out to each leaf in turn and brings it back to the pile."""
    leg = 9.0  # seconds per leaf: out, scoop, back
    i = int(t // leg) % len(MAP_LEAVES)
    phase = (t % leg) / leg
    leaf_id, lx, lz = MAP_LEAVES[i]
    if phase < 0.45:
        k, mode, msg = phase / 0.45, "approaching", f"To leaf #{leaf_id}"
    elif phase < 0.55:
        k, mode, msg = 1.0, "scooping", f"Scooping leaf #{leaf_id}"
    else:
        k, mode, msg = 1 - (phase - 0.55) / 0.45, "returning", "To the pile"
    x, z = PILE[0] + lx * k, PILE[1] + lz * k
    # Facing where it's going: towards the leaf on the way out, the pile on the way back.
    tx, tz = (lx - x, lz - z) if mode != "returning" else (PILE[0] - x, PILE[1] - z)
    yaw = math.degrees(math.atan2(tx, -tz)) if abs(tx) + abs(tz) > 1e-3 else 0
    # Leaves still on the ground: the ones not reached yet this round, and this one until it's scooped.
    leaves = [{"id": lid, "x": ax, "z": az, "state": "tentative" if lid == 6 else "confirmed"}
              for n, (lid, ax, az) in enumerate(MAP_LEAVES) if n > i or (n == i and phase < 0.55)]
    corridors = [{"bearingDeg": b, "clearanceM": 2.5 if abs(b + 20) > 8 else 0.9, "blocked": abs(b + 20) <= 8}
                 for b in range(-40, 41, 8)]
    line = {
        "type": "map", "t": int(time.time() * 1000),
        "rover": {"x": round(x, 2), "z": round(z, 2), "yawDeg": round(yaw)},
        "pile": {"x": PILE[0], "z": PILE[1], "radiusM": 0.75}, "workRadiusM": 1.83,
        "leaves": leaves, "targetId": leaf_id if mode != "returning" else None, "corridors": corridors,
        "autopilot": {"on": True, "mode": mode, "message": msg},
        "load": 1 if mode == "returning" else 0, "capacity": 4, "dumped": i,
    }
    return json.dumps(line).encode() + b"\n"


def render(t: float, size: int | None = None) -> bytes:
    """A lawn with a leaf circling a pile, and the time, so motion and latency are easy to see. With
    `size`, a still that big (longer side), as the app sends for capturing."""
    image = Image.new("RGB", (WIDTH, HEIGHT), (70, 105, 45))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, HEIGHT * 0.3), fill=(150, 185, 215))
    cx, cy = WIDTH / 2, HEIGHT * 0.68
    draw.ellipse((cx - 70, cy - 28, cx + 70, cy + 28), fill=(160, 105, 45))
    x, y = leaf_at(t)
    draw.ellipse((x - 14, y - 9, x + 14, y + 9), fill=(212, 162, 76))
    draw.text((16, 16), f"MOCK iPhone  {time.strftime('%H:%M:%S')}.{int(t * 10) % 10}", fill=(20, 20, 20))
    if size:
        draw.text((16, 32), f"STILL {size}px", fill=(20, 20, 20))
        scale = size / max(WIDTH, HEIGHT)
        image = image.resize((round(WIDTH * scale), round(HEIGHT * scale)))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=92 if size else 70)
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def headers_common(self, status: int, content_type: str, length: int | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_GET(self):
        global viewers
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        if path == "/status":
            frames = int((time.time() - START) * FPS)
            body = json.dumps({"id": "mock-iphone", "device": "Mock iPhone", "viewers": viewers, "frames": frames, "width": WIDTH, "height": HEIGHT}).encode()
            self.headers_common(200, "application/json", len(body))
            self.wfile.write(body)
        elif path == "/detections":
            self.headers_common(200, "application/x-ndjson")
            try:
                # Boxes about as often as the phone's detector finishes a frame, the map every steering tick.
                tick = 0
                while True:
                    if tick % 5 == 0:
                        self.wfile.write(detections(time.time() * 1.5))
                    self.wfile.write(live_map(time.time() - START))
                    self.wfile.flush()
                    tick += 1
                    time.sleep(0.2)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif path == "/frame.jpg":
            size = int(params["size"]) if params.get("size", "").isdigit() else None
            body = render(time.time(), max(160, min(size, 4096)) if size else None)
            self.headers_common(200, "image/jpeg", len(body))
            self.wfile.write(body)
        elif path == "/camera.mjpg":
            self.headers_common(200, "multipart/x-mixed-replace; boundary=frame")
            with lock:
                viewers += 1
            try:
                while True:
                    jpeg = render(time.time() * 1.5)
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpeg) + jpeg + b"\r\n")
                    time.sleep(1 / FPS)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with lock:
                    viewers -= 1
        else:
            body = b"Not found. Try /camera.mjpg, /frame.jpg or /status\n"
            self.headers_common(404, "text/plain; charset=utf-8", len(body))
            self.wfile.write(body)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8787)
    # All interfaces: discovery reaches the "phone" at its Wi-Fi address, as it would the real one.
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--no-advertise", action="store_true", help="don't announce it with Bonjour")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    advert = None
    if not args.no_advertise:
        if shutil.which("dns-sd"):
            advert = subprocess.Popen(
                ["dns-sd", "-R", "Rover camera (Mock iPhone)", "_rovercam._tcp", "local", str(args.port),
                 "device=Mock iPhone", "id=mock-iphone", "path=/camera.mjpg"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            print("No dns-sd here (it's macOS's), so not advertised: enter the address by hand.")
    print(f"Mock iPhone camera on http://{args.host}:{args.port}{' (advertised)' if advert else ''} (Ctrl-C to stop)")
    # Stopped by a kill as well as by Ctrl-C, take the advert down with it: a phone that's gone mustn't linger.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if advert:
            advert.terminate()
