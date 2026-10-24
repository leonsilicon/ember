# soon2026

Hackathon project: a rover with a simple robotic arm, controlled from a laptop web
app, plus a Gaussian splat of the surroundings built from captured images.

| Folder | What |
|---|---|
| [`frontend/`](frontend/) | React + Vite + TS + Tailwind remote control (drive, stop, arm, status), Gaussian splat viewer, webcam capture stand-in |
| [`pipeline/`](pipeline/) | `reconstruct.py`: folder of images → COLMAP → OpenSplat → `.splat` for the viewer (CPU/Metal, no CUDA) |
| [`firmware/rover_ws/`](firmware/rover_ws/) | ESP32 Arduino sketch: Wi-Fi access point + WebSocket command endpoint |

Milestone 1 (done, verified on an ESP32): drive from the laptop, release to stop, trigger
the arm once, receive completion confirmation.

Milestone 2: capture images → `python3 pipeline/reconstruct.py <images>` → load the
resulting `.splat` in the web app's viewer. The depth camera is still unspecified, so the
Capture panel uses the laptop webcam; the pipeline only needs a folder of RGB frames.
