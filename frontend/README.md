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
