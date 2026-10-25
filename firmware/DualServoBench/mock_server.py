#!/usr/bin/env python3
"""Laptop-side stand-in for DualServoBench.ino (no dependencies, Python 3.8+).

Speaks the firmware's V7 HTTP API (API.md) and applies ManualControl.h's rules (session token,
increasing seq, 500 ms lease, servo jog maths, PWM duties) so the web app's Live rover mode can
be exercised without the ESP32:

    python3 firmware/DualServoBench/mock_server.py            # http://127.0.0.1:8788
    python3 firmware/DualServoBench/mock_server.py --port 80  # then use http://127.0.0.1

Then on /control: Live rover, address http://127.0.0.1:8788, Connect. Like the firmware it sends
no CORS headers: the app reaches it through its own proxy (/api/rover).
"""
import argparse
import json
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

LEASE_MS = 500
MIN_US, MAX_US = 500, 2500


class ManualState:
    """Port of firmware/DualServoBench/ManualControl.h."""

    def __init__(self):
        self.token = 0
        self.sequence = 0
        self.last_packet = 0
        self.last_tick = 0
        self.wheel = self.pan = self.lift = 0
        self.wheel_power, self.servo_speed = 20, 10
        self.position = [1500, 1500]
        self.enabled = [False, False]
        self.linked = False

    def stop(self):
        self.wheel = self.pan = self.lift = 0
        self.linked = False

    def session(self, key, now):
        self.stop()
        self.token, self.sequence = key, 0
        self.last_packet = self.last_tick = now

    def accept(self, key, seq, w, p, l, wp, sp, now):
        if not key or key != self.token or seq <= self.sequence:
            return False
        if not (0 <= w <= 4 and -1 <= p <= 1 and -1 <= l <= 1 and 0 <= wp <= 100 and 0 <= sp <= 100):
            return False
        self.sequence, self.wheel, self.pan, self.lift = seq, w, p, l
        self.wheel_power, self.servo_speed = wp, sp
        self.last_packet, self.linked = now, True
        return True

    def tick(self, now):
        if self.linked and now - self.last_packet >= LEASE_MS:
            self.stop()
        elapsed = now - self.last_tick
        if elapsed < 20:
            return
        self.last_tick = now
        dt = min(elapsed, 50)
        for i, direction in enumerate((self.pan, self.lift)):
            if not self.linked or not direction or not self.servo_speed:
                continue
            self.enabled[i] = True
            if self.servo_speed == 100:
                self.position[i] = MAX_US if direction > 0 else MIN_US
            else:
                step = max(1, self.servo_speed * 20 * dt // 1000)
                self.position[i] = max(MIN_US, min(MAX_US, self.position[i] + direction * step))

    def targets(self):
        if not self.linked:
            return 0, 0
        p = self.wheel_power
        return {1: (p, -p), 2: (-p, p), 3: (-p, -p), 4: (p, p)}.get(self.wheel, (0, 0))

    def duties(self):
        left, right = (v * 255 // 100 if v >= 0 else -((-v) * 255 // 100) for v in self.targets())
        return [max(left, 0), max(-left, 0), max(right, 0), max(-right, 0)]


_lock = threading.Lock()
_state = ManualState()
_last_logged = None


def _now_ms():
    return int(time.monotonic() * 1000)


def _log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def _loop():
    global _last_logged
    while True:
        with _lock:
            _state.tick(_now_ms())
            key = (tuple(_state.duties()), tuple(_state.position), _state.linked)
        if key != _last_logged:
            _last_logged = key
            _log("pwm=%s pan=%dus lift=%dus linked=%s" % (list(key[0]), key[1][0], key[1][1], key[2]))
        time.sleep(0.005)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body, ctype="application/json"):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _form(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        return {k: v[-1] for k, v in parse_qs(raw, keep_blank_values=True).items()}

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.split("?")[0] == "/status":
            with _lock:
                s = _state
                body = {"ready": True, "sequence": s.sequence, "pan": s.position[0], "lift": s.position[1], "pwm": s.duties()}
            return self._send(200, json.dumps(body))
        if self.path.split("?")[0] == "/":
            return self._send(200, "DualServoBench mock (V7 API): POST /session, POST /control, GET /status", "text/plain")
        self._send(404, "Not found", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        form = self._form()
        if path == "/session":
            key = random.randrange(1, 0x3FFFFFFF)
            with _lock:
                _state.session(key, _now_ms())
            _log("new session %d" % key)
            return self._send(200, json.dumps({"token": key}))
        if path == "/control":
            try:
                v = [int(form[k]) for k in ("token", "seq", "wheel", "pan", "lift", "power", "speed")]
            except (KeyError, ValueError):
                return self._send(400, "Invalid command", "text/plain")
            if v[0] <= 0 or v[1] <= 0:
                return self._send(400, "Invalid command", "text/plain")
            with _lock:
                ok = _state.accept(*v, _now_ms())
            if ok:
                return self._send(200, "{}")
            return self._send(409, "Stale session or invalid command", "text/plain")
        self._send(404, "Not found", "text/plain")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8788)
    args = ap.parse_args()
    threading.Thread(target=_loop, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    _log("mock rover at http://%s:%d (no CORS, like the firmware)" % (args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
