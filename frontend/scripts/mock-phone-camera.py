"""A stand-in for the rover app's Wi-Fi camera, for working on the web app's live mode without the iPhone.

Serves the same routes as the app's CameraStreamServer (apps/expo-app/modules/splat-capture/ios/
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


def render(t: float, size: int | None = None) -> bytes:
    """A lawn with a leaf circling a pile, and the time, so motion and latency are easy to see. With
    `size`, a still that big (longer side), as the app sends for capturing."""
    image = Image.new("RGB", (WIDTH, HEIGHT), (70, 105, 45))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, HEIGHT * 0.3), fill=(150, 185, 215))
    cx, cy = WIDTH / 2, HEIGHT * 0.68
    draw.ellipse((cx - 70, cy - 28, cx + 70, cy + 28), fill=(160, 105, 45))
    x = cx + math.cos(t) * 150
    y = cy + math.sin(t) * 60
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
            body = json.dumps({"device": "Mock iPhone", "viewers": viewers, "frames": frames, "width": WIDTH, "height": HEIGHT}).encode()
            self.headers_common(200, "application/json", len(body))
            self.wfile.write(body)
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
                 "device=Mock iPhone", "path=/camera.mjpg"],
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
