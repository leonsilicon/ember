#!/usr/bin/env python3
"""Laptop-side stand-in for rover_ws.ino (no dependencies, Python 3.8+).

Speaks the same JSON protocol and applies the same rules (300 ms drive watchdog,
arm busy rejection, 3 s sequence, 1 s heartbeat) so the frontend's Live mode can
be exercised without an ESP32:

    python3 mock_server.py            # ws://127.0.0.1:8080/ws
    python3 mock_server.py --port 80  # then use ws://127.0.0.1/ws
"""
import argparse
import base64
import hashlib
import json
import socket
import struct
import threading
import time

DRIVE_TIMEOUT_S = 0.3
STATUS_INTERVAL_S = 1.0
ARM_SEQUENCE_S = 3.0
DRIVE_COMMANDS = ("forward", "back", "left", "right", "stop")

_lock = threading.Lock()
_state = {"drive": "stop", "arm": "idle", "last_drive": 0.0, "arm_started": 0.0}
_clients = set()
_started = time.monotonic()


def _log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def _frame(text):
    payload = text.encode()
    n = len(payload)
    if n < 126:
        header = struct.pack("!BB", 0x81, n)
    elif n < 65536:
        header = struct.pack("!BBH", 0x81, 126, n)
    else:
        header = struct.pack("!BBQ", 0x81, 127, n)
    return header + payload


def _send(conn, obj):
    try:
        conn.sendall(_frame(json.dumps(obj)))
    except OSError:
        pass


def _status():
    return {
        "type": "status",
        "drive": _state["drive"],
        "arm": _state["arm"],
        "uptime_ms": int((time.monotonic() - _started) * 1000),
        "clients": len(_clients),
    }


def _broadcast_status():
    msg = _status()
    for c in list(_clients):
        _send(c, msg)


def _apply_drive(value):
    if _state["drive"] != value:
        _log(f"[drive] {value}")
    _state["drive"] = value


def _handle_command(conn, cmd):
    with _lock:
        if cmd in DRIVE_COMMANDS:
            _apply_drive(cmd)
            _state["last_drive"] = time.monotonic()
        elif cmd == "arm_run":
            if _state["arm"] == "running":
                _send(conn, {"type": "error", "message": "arm busy"})
                return
            _state["arm"] = "running"
            _state["arm_started"] = time.monotonic()
            _log("[arm] sequence started")
        else:
            _send(conn, {"type": "error", "message": "unknown command"})
            return
        _broadcast_status()


def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError
        buf += chunk
    return buf


def _read_message(conn):
    b1, b2 = _recv_exact(conn, 2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(conn, 8))[0]
    mask = _recv_exact(conn, 4) if masked else None
    data = _recv_exact(conn, length)
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def _handshake(conn):
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = conn.recv(4096)
        if not chunk:
            raise ConnectionError
        request += chunk
    head, _, _ = request.partition(b"\r\n\r\n")
    lines = head.decode(errors="replace").split("\r\n")
    path = lines[0].split(" ")[1] if len(lines[0].split(" ")) > 1 else "/"
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    key = headers.get("sec-websocket-key")
    if path != "/ws" or key is None:
        body = b"rover_ws mock OK. WebSocket endpoint: /ws"
        conn.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )
        return False
    accept = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode()
    conn.sendall(
        b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
        b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n"
    )
    return True


def _client_thread(conn, addr):
    try:
        if not _handshake(conn):
            return
        with _lock:
            _clients.add(conn)
            _log(f"[ws] client {addr[0]}:{addr[1]} connected")
            _send(conn, _status())
        while True:
            opcode, data = _read_message(conn)
            if opcode == 0x8:
                break
            if opcode == 0x9:
                conn.sendall(b"\x8a" + bytes([len(data)]) + data)
                continue
            if opcode != 0x1:
                continue
            try:
                cmd = json.loads(data.decode()).get("cmd")
            except (ValueError, AttributeError):
                _send(conn, {"type": "error", "message": "invalid json"})
                continue
            if not isinstance(cmd, str):
                _send(conn, {"type": "error", "message": "missing cmd"})
                continue
            _handle_command(conn, cmd)
    except (ConnectionError, OSError):
        pass
    finally:
        with _lock:
            _clients.discard(conn)
            _log(f"[ws] client {addr[0]}:{addr[1]} disconnected")
            if _state["drive"] != "stop":
                _apply_drive("stop")
        conn.close()


def _loop_thread():
    last_status = time.monotonic()
    while True:
        time.sleep(0.02)
        now = time.monotonic()
        with _lock:
            if _state["drive"] != "stop" and now - _state["last_drive"] > DRIVE_TIMEOUT_S:
                _log("[drive] watchdog timeout")
                _apply_drive("stop")
                _broadcast_status()
            if _state["arm"] == "running" and now - _state["arm_started"] >= ARM_SEQUENCE_S:
                _state["arm"] = "completed"
                _log("[arm] sequence completed")
                _broadcast_status()
            if now - last_status >= STATUS_INTERVAL_S:
                last_status = now
                if _clients:
                    _broadcast_status()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    threading.Thread(target=_loop_thread, daemon=True).start()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen()
    _log(f"mock rover_ws listening on ws://{args.host}:{args.port}/ws")
    try:
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=_client_thread, args=(conn, addr), daemon=True).start()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
