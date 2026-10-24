# frontend — Rover Control web app

React + Vite + TypeScript + Tailwind. Runs on the laptop and talks to the ESP32
(`firmware/rover_ws`) over a WebSocket.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build into dist/
npm run lint
```

## What it does

- **Drive**: hold a D-pad button or `WASD` / arrow keys to drive, release to stop.
  While held, the direction is re-sent every 100 ms; the firmware stops on its own
  after 300 ms without a command. Window blur / tab hidden also releases.
- **Stop**: large red button, `Space` or `Esc`. Always sends `stop`.
- **Run arm sequence**: sends `arm_run` once; disabled while the device reports `running`.
- **Connection panel**: toggle **Simulated** / **Live**, enter the ESP32 WebSocket URL
  (default `ws://192.168.4.1/ws`), connect / disconnect, see last message age and errors.
- **Status**: connection (disconnected / connecting / connected / error), device-reported
  drive state, arm state (idle / running / completed / error).
- **Viewer area**: placeholder for the Gaussian splat renderer and live camera (milestone 2).

## Simulated vs device

Simulated mode is the default and is labelled everywhere (amber banner, `SIMULATED`
source). It runs the same rules as the firmware in the browser (watchdog stop, arm busy
rejection, 3 s sequence). Nothing in simulated mode reflects hardware.

Live mode shows `DEVICE` and only displays what the ESP32 reports. There is no
auto-reconnect: after a drop, click **Connect** again. No motion command is ever
re-sent on reconnect.

## Code map

```
src/protocol.ts                 command / status message types shared with firmware
src/clients/RoverClient.ts      client interface + snapshot store
src/clients/SimulatedClient.ts  in-browser stand-in for the ESP32
src/clients/WebSocketClient.ts  real transport
src/hooks/useRover.ts           hold-to-drive repeat, keyboard, mode switching
src/components/                 DPad, StopButton, ArmPanel, ConnectionPanel, ViewerPlaceholder
```

## Viewer, scene and capture (milestone 2)

- **Viewer** — renders a Gaussian splat (`.splat`, `.ply`, `.ksplat`) with `@mkkellogg/gaussian-splats-3d`. Drag to orbit, scroll to zoom, right-drag to pan; Bird's-eye and Reset view buttons. Runs without `SharedArrayBuffer` (no COOP/COEP headers needed).
- **Scene panel** — "Leaf floor" (the bundled sample, `public/splats/leaf-floor.splat`, made by `scripts/make-leaf-splat.mjs`), "Open .splat / .ply…" for a local file, or a URL such as `/splats/scene.splat` for pipeline output dropped into `public/splats/`.
- **iPhone camera** — what the rover sees, from the iPhone riding on it. Open the rover app on the iPhone and
  this panel links up by itself: the app announces its camera with Bonjour and the dev server finds it
  (`phone-discovery.ts`, `GET /api/phone-camera`). It shows in Live mode, and in Simulated mode too once a phone
  is found. Without discovery, enter the address from the cast icon at the top of the app's camera screen. Laptop and phone must be on the same network, and the page must be on http (browsers block the
  phone's http stream from an https page). The panel reconnects to the last address, shows the frame rate, and
  reports a phone that's gone or a frozen picture. Without the phone, `python3 scripts/mock-phone-camera.py`
  serves and advertises a test picture on port 8787 (needs Pillow; advertising uses macOS's dns-sd).
- **Capture panel** — records from the iPhone camera whenever the leaf detector app is open and linked (above),
  otherwise from the laptop webcam ("Use laptop webcam"). Choose folder (Chrome's File System Access API) →
  Record 1 fps writes `frame_0001.jpg…` into that folder; "Snap one" takes a single frame. From the iPhone, each
  frame is a full-resolution still (1920 px, `/frame.jpg?size=1920`) encoded fresh on the phone, not a stream
  frame. Feed the folder to `pipeline/reconstruct.py`.
