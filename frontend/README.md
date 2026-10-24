# frontend — the web app

One Next.js app (`@soon2026/frontend`), on Vercel at https://soon2026.vercel.app. Two sides share it:

- **The splat server** (`/`, `/view/[id]`, `/live`, `/api/*`; `src/app/(splat)`, `src/web`, `src/live`): trains the
  phone's captures into Gaussian splats and rebuilds recordings live in 3D through a Bun agent on a Mac
  (`src/agent`). One access token (`SPLAT_TOKEN`) guards it. The whole story is in
  [`mobile/SPLATS.md`](../mobile/SPLATS.md).
- **The laptop pages** (`src/app/(rover)`, `src/rover`, `src/wildfire`), which run in the browser only:
  - `/control` — remote control for the rover and arm over a WebSocket to the ESP32 (`firmware/rover_ws`), with a
    splat viewer and a webcam capture panel. See "Rover control" below.
  - `/sim` — the autopilot simulator: the rover's own brain (`mobile/src/lib/rover-brain`, imported as
    `@rover-brain`) clearing a virtual yard. See "Autopilot simulator" in the repo README.
  - `/wildfire` — the wildfire hazard map, from the tiles in `public/wildfire` (see `data/wildfire/README.md`).

The two sides have separate root layouts. The laptop pages are styled with Tailwind, whose base styles would restyle
the splat pages, so each side loads only its own CSS, and moving between them is a full page load.

```sh
bun install          # at the repo root (bun workspace)
bun run dev          # vercel dev on http://localhost:8899; needs .env.local from `vercel env pull`
bun run build        # next build
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint
bun test             # starts a throwaway Redis for the server's tests (redis-server on PATH)
bun run agent        # the Mac agent, or `vpx _dev` for the whole dev stack
```

## Deploying

`.github/workflows/vercel.yml` deploys every push to `main` of SOON-2026/soon2026 to production, and pull requests
from branches in that repo to previews, with the Vercel CLI (`vercel pull`, `vercel build`, `vercel deploy
--prebuilt`). It needs the `VERCEL_TOKEN` repository secret. Everything else (root directory `frontend`, the install
command, env vars, region `yul1`) is the Vercel project's settings (`improvelabs/soon2026`), pulled at build time.

## Rover control (`/control`)

Talks to the ESP32 (`firmware/rover_ws`) over a WebSocket. Browsers refuse a plain `ws://` connection from an
`https://` page, so drive from the dev server on the laptop (http://localhost:8899/control), not from the Vercel URL.

- **Drive**: hold a D-pad button or `WASD` / arrow keys to drive, release to stop. While held, the direction is
  re-sent every 100 ms; the firmware stops on its own after 300 ms without a command. Window blur / tab hidden
  also releases.
- **Stop**: large red button, `Space` or `Esc`. Always sends `stop`.
- **Run arm sequence**: sends `arm_run` once; disabled while the device reports `running`.
- **Connection panel**: toggle **Simulated** / **Live**, enter the ESP32 WebSocket URL (default
  `ws://192.168.4.1/ws`), connect / disconnect, see last message age and errors.
- **Status**: connection (disconnected / connecting / connected / error), device-reported drive state, arm state
  (idle / running / completed / error).

Simulated mode is the default and is labelled everywhere (amber banner, `SIMULATED` source). It runs the same rules
as the firmware in the browser (watchdog stop, arm busy rejection, 3 s sequence). Nothing in simulated mode reflects
hardware. Live mode shows `DEVICE` and only displays what the ESP32 reports. There is no auto-reconnect: after a
drop, click **Connect** again. No motion command is ever re-sent on reconnect.

- **Viewer** — renders a Gaussian splat (`.splat`, `.ply`, `.ksplat`) with `@mkkellogg/gaussian-splats-3d`. Drag to
  orbit, scroll to zoom, right-drag to pan; Bird's-eye and Reset view buttons.
- **Scene panel** — "Leaf floor" (the bundled sample, `public/splats/leaf-floor.splat`, made by
  `scripts/make-leaf-splat.mjs`), "Open .splat / .ply…" for a local file, or a URL such as `/splats/scene.splat`
  for pipeline output dropped into `public/splats/`.
- **Capture panel** — webcam stand-in: Start camera → Choose folder (Chrome's File System Access API) → Record 1 fps
  writes `frame_0001.jpg…` into that folder; "Snap one" takes a single frame. Feed the folder to
  `pipeline/reconstruct.py`.

Code map:

```
src/rover/protocol.ts                 command / status message types shared with the firmware
src/rover/clients/RoverClient.ts      client interface + snapshot store
src/rover/clients/SimulatedClient.ts  in-browser stand-in for the ESP32
src/rover/clients/WebSocketClient.ts  real transport
src/rover/hooks/useRover.ts           hold-to-drive repeat, keyboard, mode switching
src/rover/components/                 DPad, StopButton, ArmPanel, ConnectionPanel, SplatViewer, ScenePanel, CapturePanel
src/rover/components/sim/             the autopilot simulator's views; src/rover/sim and src/rover/sim3d drive them
```
