# frontend — the web app

One Next.js app (`@soon2026/frontend`), on Vercel at https://soon2026.vercel.app. `/` is the landing page with the
sign-in form, and everything else is behind it (see "Signing in"): the splat pages under a tab bar (`src/app/tool-shell.tsx`)
that switches between the four tools and signs out, the rover pages under Ember's own top bar (`src/rover/ui/Shell.tsx`)
with the same four; sign-in lands on `/control`. Two sides share the app:

- **The splat server** (`/live`, `/view/[id]`, `/api/*`; `src/app/(splat)`, `src/web`, `src/live`): the Live 3D tab also
  lists the captures (finished splats, and the ones still uploading or training; an upload the phone never
  finished is called out once its two-hour upload window is over; `live/captures-panel.tsx`). It
  trains the phone's captures into Gaussian splats and rebuilds recordings live in 3D through a Bun agent on a Mac
  (`src/agent`). The app reaches its API with one access token (`SPLAT_TOKEN`). The whole story is in
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

## Signing in

There's one demo account and no sign-up. It answers to `DEMO_EMAIL` or any of the comma-separated `DEMO_USERNAMES`
(in any case) with `DEMO_PASSWORD`: environment variables on the Vercel project (Secret in production and preview;
`vercel env pull` brings the development copies into `.env.local`). The landing page's form
(`src/app/(splat)/actions.ts`) checks them and sets a `splat_session` cookie holding the login and an HMAC over it keyed
by the server's secrets, so nothing is stored, the tab bar can say who's signed in, and changing the password (or
removing a username) signs that browser out. A page opened without it redirects to
`/?next=…` (`requireSignIn` in `src/web/auth.ts`), and the API takes the cookie too, so the viewers' fetches and the
live socket work from a signed-in browser. **Sign out** in the tab bar clears it; `/dashboard` redirects to `/control`.

The access token (`SPLAT_TOKEN`) still signs a browser in beside it: opening any page with `?token=` keeps it in a
`splat_token` cookie (`src/proxy.ts`), which is how the app's embedded live view and a sign-in link get in without the
form. The app itself sends the token as a bearer token to `/api/*`.

## Deploying

`.github/workflows/vercel.yml` deploys every push to `main` of SOON-2026/soon2026 to production, and pull requests
from branches in that repo to previews, with the Vercel CLI (`vercel pull`, `vercel build`, `vercel deploy
--prebuilt`). It needs the `VERCEL_TOKEN` repository secret. Everything else (root directory `frontend`, the install
command, env vars, region `yul1`) is the Vercel project's settings (`improvelabs/soon2026`), pulled at build time.

### The Mac agent as a service

The agent (`src/agent`) runs on Leon's MacBook as the pm2 process `soon2026-agent` (`pm2.config.cjs`; `pm2 ls`, `pm2
logs soon2026-agent`), from the service's own checkout in `~/.soon2026/agent/repo`. `.github/workflows/agent.yml`
keeps it current: every push to `main` that touches `frontend/` runs on the self-hosted runner (that Mac), fetches the
commit into that checkout, installs dependencies, Brush and the depth worker when needed (`scripts/install-*.sh`),
pulls the project's development env (`REDIS_URL`, and the OIDC token the Blob SDK refreshes through the Mac's `vercel
login`), runs `scripts/install-agent-service.sh` (pm2 delete + start, `pm2 save`, and a launchd agent that runs `pm2
resurrect` at login, plus `scripts/agent-watchdog.sh` every two minutes, which restarts the process when no agent has
a heartbeat) and waits for the new process's heartbeat with `scripts/agent-status.ts`. pm2 restarts the agent after a
crash and gives up, visibly (`errored`), after ten quick ones; the agent exits by itself when two heartbeats in a row
can't reach Redis (a connection the Mac's network change left half-open looks open to it otherwise). Only one agent may run against the Redis
instance (both would take the same work), so `vpx _dev` leaves out its agent pane while the service is online; to run
the dev stack's agent instead, `pm2 stop soon2026-agent` and `vpx _dev --agent`, then `pm2 start soon2026-agent`.

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
- **Capture panel** — frames for the pipeline, from the rover's iPhone when its app is open (see below), otherwise
  from the laptop webcam ("Use laptop webcam"). Choose folder (Chrome's File System Access API) → Record 1 fps
  writes `frame_0001.jpg…` into that folder; "Snap one" takes a single frame. From the iPhone, each frame is a
  full-resolution still (1920 px, `/frame.jpg?size=1920`) encoded fresh on the phone, not a stream frame. Feed the
  folder to `pipeline/reconstruct.py`.
- **iPhone camera** — the capture panel switches to the rover's iPhone as soon as its app is open on the same Wi-Fi:
  the app announces its camera with Bonjour (`_rovercam._tcp`) and the dev server finds it (`src/phone-discovery.ts`,
  `GET /api/phone-camera`; on Vercel there's no local network, so it finds none). Without discovery, enter the
  address from the cast icon at the top of the app's camera screen (port 8787). The page must be on http, since
  browsers block the phone's http stream from an https page. Without the phone, `python3
  scripts/mock-phone-camera.py` serves and advertises a test picture (needs Pillow; advertising uses macOS's dns-sd).

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
