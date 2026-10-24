# soon2026

Hackathon project: a rover with a simple robotic arm, controlled from a laptop web
app, plus a Gaussian splat of the surroundings built from captured images.

| Folder | What |
|---|---|
| [`frontend/`](frontend/) | React + Vite + TS + Tailwind remote control (drive, stop, arm, status, splat viewer placeholder) |
| [`firmware/rover_ws/`](firmware/rover_ws/) | ESP32 Arduino sketch: Wi-Fi access point + WebSocket command endpoint |

Milestone 1: drive from the laptop, release to stop, trigger the arm once, receive
completion confirmation. Milestone 2: display a Gaussian splat reconstructed from
captured images.
