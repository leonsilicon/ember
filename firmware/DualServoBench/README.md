# DualServoBench — the rover's ESP32 firmware (V7)

The exact source flashed on the rover's ESP32 (Matthew's handoff, October 2026). The web app's
`/control` page drives it; see `API.md` for the wire contract and `frontend/src/rover/protocol.ts`
for the app's side. **No firmware change or reflash is needed to use the app.**

- Board: original ESP32-WROOM family, FQBN `esp32:esp32:esp32`, Arduino-ESP32 3.3.11. No libraries beyond the core.
- Wi-Fi: the ESP32 hosts **Leaf-Rover**, password **leafrover**, and answers at **http://192.168.4.1**
  (its own built-in page is there too, from `Dashboard.h`). It takes **one Wi-Fi client at a time**:
  opening a second controlling page replaces the session and stops any jogging.
- API: `POST /session` → token; `POST /control` full-state frame (`token, seq, wheel, pan, lift, power, speed`,
  form-encoded) every 100 ms while held; `GET /status`. Wheels and jogging stop 500 ms after the last accepted
  frame. No CORS, so browsers go through the app's same-origin proxy (`/api/rover/*`).
- Serial 115200: `STATUS`, `WIFI`, `STOP` (servos keep holding), `OFF` (detach servo pulses — support the arm first).

## What the controls mean

- **Wheels**: forward / back / pivot left / pivot right at 0..100 % PWM duty — not a measured speed or current.
  Left forward is GPIO 25, left back 26; right forward 33, right back 32. Different drivers/motors mean equal PWM
  does not give equal wheel speeds.
- **Pan servo** GPIO 19, **lift servo** GPIO 18. Both may jog while the wheels drive. Release stops jogging; an
  enabled servo **keeps holding its last target**, including after link loss. Positions are commanded pulse-width
  estimates (first use starts from 1500 µs and may jump); there is no angle feedback. The 500..2500 µs bounds are
  electrical, **not** collision-safe limits of the assembly. Servo speed 100 % jumps straight to the endpoint;
  lower values jog gradually; 0 disables position changes.
- `/status`'s `ready` is the wheel PWM initialisation, not hardware readiness; `pwm` is software duty 0..255 in
  GPIO 25, 26, 32, 33 order.

## Known hardware issue / what is not verified

- Matthew reports the left wheel reverses but does not go forward. The code maps forward to GPIO 25 and reverse to
  26; this firmware does not repair the fault. Inspect GPIO 25 → left driver input, its enables / common ground, and
  the driver half-bridge. The right driver may have been replaced with an L298N (32 → IN1, 33 → IN2, ENA HIGH).
- Motor startup / stall current margins and assembly-safe servo endpoints are unverified. Keep the wheels raised
  and the arm supported while commissioning, with a battery cutoff within reach.
- Firmware upload and non-moving serial status checks passed. `tests/test_manual.cpp` covers the control logic
  (continuous holds, signs, endpoints, stale packets, lease timeout, clock rollover). None of the software tests
  establish physical movement, current, clearance or stopping distance.

## Files

- `DualServoBench.ino`, `ManualControl.h` (control logic), `Dashboard.h` (the ESP32's own page).
- `API.md`: the HTTP contract.
- `tests/test_manual.cpp`: `c++ -std=c++11 tests/test_manual.cpp -o /tmp/rover-test && /tmp/rover-test`.
- `mock_server.py`: a laptop stand-in that speaks the same API with the same rules, for the app without the ESP32:
  `python3 firmware/DualServoBench/mock_server.py` (http://127.0.0.1:8788), then **Live rover** → address
  `http://127.0.0.1:8788` → **Connect**.

## Flash (only if necessary, with motor and servo power disconnected)

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/DualServoBench
arduino-cli upload --fqbn esp32:esp32:esp32 --port /dev/cu.usbserial-0001 firmware/DualServoBench
```
