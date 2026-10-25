# frontend — the web app

One Next.js app (`@soon2026/frontend`), on Vercel at https://soon2026.vercel.app. `/` is the landing page with the
sign-in form, and everything else is behind it (see "Signing in") in Ember's shell (`src/rover/ui/Shell.tsx`; see
`DESIGN.md`): one top bar on every page that switches between Control, the Autopilot sim, the Wildfire map and Live 3D,
says who's signed in and signs out; sign-in lands on `/control`. Two sides share the app:

- **The splat server** (`/live`, `/view/[id]`, `/api/*`; `src/app/(rover)/live`, `src/app/(rover)/view`, `src/app/(splat)/api`, `src/web`,
  `src/live`): Live 3D's Captures module also lists the captures (finished splats, and the ones still uploading or
  training; an upload the phone never finished is called out once its two-hour upload window is over;
  `live/captures-module.tsx`). It
  trains the phone's captures into Gaussian splats and rebuilds recordings live in 3D through a Bun agent on a Mac
  (`src/agent`). The app reaches its API with one access token (`SPLAT_TOKEN`). The whole story is in
  [`mobile/SPLATS.md`](../mobile/SPLATS.md).
- **The laptop pages** (`src/app/(rover)`, `src/rover`, `src/wildfire`), which run in the browser only:
  - `/control` — remote control for the rover's wheels and arm servos over the ESP32's HTTP API
    (`firmware/DualServoBench`), through the site's own `/api/rover` proxy, with a splat viewer and a webcam
    capture panel. See "Rover control" below.
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

A username and the team's password, `DEMO_PASSWORD` (an environment variable on the Vercel project, Secret in
production and preview; `vercel env pull` brings the development copy into `.env.local`). There's no sign-up and no
list of users: any username the rule in `src/rooms.ts` allows (letters, digits, dots, dashes and underscores) works.
The landing page's form (`src/app/(splat)/actions.ts`) checks the password and sets a `splat_session` cookie holding
the username and an HMAC over it keyed by the server's secrets, so nothing is stored, the top bar can say who's signed
in, and changing the password signs every browser out. A page opened without it redirects to `/?next=…`
(`requireSignIn` in `src/web/auth.ts`), and the API takes the cookie too, so the viewers' fetches and the sockets work
from a signed-in browser. **Sign out** in the top bar clears it; `/dashboard` redirects to `/control`.

**The username is the room** (`src/rooms.ts`). The app has the same setting (asked for on its first launch; the ⋯
camera options and All Captures change it), and everything the phone sends goes to that room: the rover brain's live
map (the control page's top view, through `/live/map` and `src/web/rooms.ts`, a Redis pub/sub channel per room), its
Live 3D recordings (the hello's `room`, which `/live/socket` and `/api/live` filter by) and its captures (the
upload's `X-Room` header, which `/api/captures` filters by). So the pages signed in as `leonsilicon` show the phone set
to `leonsilicon` and no other, and the whole team can use the site at once. A browser that came in with the access
token names no room and sees every room, or the one its URL's `?room=` asks for (the app's embedded Live 3D view).

The access token (`SPLAT_TOKEN`) still signs a browser in beside it: opening any page with `?token=` keeps it in a
`splat_token` cookie (`src/proxy.ts`), which is how the app's embedded live view and a sign-in link get in without the
form. The app itself sends the token as a bearer token to `/api/*`.

## Deploying

`.github/workflows/vercel.yml` deploys every push to `main` of SOON-2026/Ember to production, and pull requests
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

Captures train newest first. One Brush trains at a time, and a capture uploaded while another trains takes its place:
that one's Brush is stopped (SIGSTOP, as the app's pause does) and carries on once the newer one is done, and the
viewer and the captures list show it as *on hold* meanwhile. Up to three captures can be on hold at once; past that a
new capture waits for the GPU, still ahead of the held ones. After a restart the agent re-queues whatever it had not
finished, newest first (`src/agent/trainer.ts`).

## Rover control (`/control`)

Drives the rover's ESP32 (`firmware/DualServoBench`, Matthew's V7 firmware, flashed) over its plain-HTTP API
([`firmware/DualServoBench/API.md`](../firmware/DualServoBench/API.md)): the ESP32 hosts the Wi-Fi **Leaf-Rover**
(password `leafrover`) at `http://192.168.4.1`. It has no CORS, so the page never calls it directly: the browser calls
`/api/rover/{session,control,status}` on its own origin (`src/app/(rover)/api/rover/[endpoint]/route.ts`) and the
server forwards to the rover. That server has to be on the rover's Wi-Fi, so drive from the dev server on the laptop
(http://localhost:8899/control); on the Vercel URL the proxy answers 503 (the cloud has no route to the rover). The
proxy forwards to `ROVER_URL`, else the rover's address, else the `?rover=` the page names (a mock), and only to a
local-network address. The live top view works from either: on the dev server the map comes from the phone over the
Wi-Fi, and on the Vercel URL through the server, from the phone set to the username the browser signed in with (see
"Signing in").

- **Connect**: `POST /session` → a token; the rover takes one controller at a time, so connecting replaces whoever
  was driving (and a stale tab reconnecting would steal the session back, which is why there is no auto-reconnect:
  after a drop, click **Connect** again).
- **Drive**: hold a D-pad button or `WASD` / arrow keys, release to stop. Every change sends the **full desired
  state** (`token, seq, wheel, pan, lift, power, speed`, form-encoded) with a strictly increasing `seq`; while
  anything is held the same frame repeats every 100 ms, and the firmware stops everything on its own 500 ms after the
  last accepted frame. Window blur / tab hidden / `pagehide` also stop. Any failed request zeroes everything, sends one
  best-effort zero frame and drops to **error**.
- **Wheel power** slider: 0..100 % PWM duty (not a measured speed; equal duty is not equal wheel speed).
- **Stop**: large red button, `Space` or `Esc`: one frame with wheel and both jogs at 0 (there is no `/stop`).
- **Arm**: hold **Pan** / **Lift** back / forward (`Q`/`E`, `F`/`R`) to jog that servo at the **Servo speed** (100 %
  jumps straight to the endpoint); let go and it holds where it is, even after link loss. The µs readouts are the
  commanded pulse estimate from `/status`, not a measured angle; 500..2500 µs is electrical, not what the arm can
  safely reach. There is no arm sequence on this firmware, so the autopilot's scoop step only drives.
- **Connection panel**: toggle **Simulated** / **Live rover**, enter the rover address (default
  `http://192.168.4.1`), connect / disconnect, see the Wi-Fi to join, last message age, errors, and from `/status`
  (polled every 700 ms) `ready`, the frame number and the four wheel PWM duties (GPIO 25, 26, 32, 33). The D-pad's
  "rover reports" dot comes from those duties.

Live rover is the default. Simulated mode is labelled everywhere (amber banner, `SIMULATED` source) and runs the
firmware's own rules in the browser (`src/rover/manualControl.ts` is a port of `ManualControl.h`: token, seq,
500 ms lease, servo step maths, PWM duties). Nothing in simulated mode reflects hardware. Without the ESP32, `python3
firmware/DualServoBench/mock_server.py` speaks the same API on http://127.0.0.1:8788 for Live rover mode.

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
- **Live top view** — in live mode the stage is the rover brain's map from the phone (`src/rover/components/LiveMapView.tsx`):
  the linked phone's `/detections` lines over the Wi-Fi (`useLiveMap`), or, with no phone linked, the same lines through
  the server from the phone set to the browser's username (`useRoomMap`, `/live/map`); the autopilot steers by it either way.
- **iPhone camera** — the capture panel switches to the rover's iPhone as soon as its app is open on the same Wi-Fi:
  the app announces its camera with Bonjour (`_rovercam._tcp`) and the dev server finds it (`src/phone-discovery.ts`,
  `GET /api/phone-camera`; on Vercel there's no local network, so it finds none). Without discovery, enter the
  address from the cast icon at the top of the app's camera screen (port 8787). The page must be on http, since
  browsers block the phone's http stream from an https page. Without the phone, `python3
  scripts/mock-phone-camera.py` serves and advertises a test picture (needs Pillow; advertising uses macOS's dns-sd).

Code map:

```
src/rover/protocol.ts                 the V7 HTTP contract: wheel codes, jogs, frame / status types, timings
src/rover/manualControl.ts            port of the firmware's ManualControl.h (the simulator's rules)
src/rover/clients/RoverClient.ts      client interface + snapshot store
src/rover/clients/SimulatedClient.ts  in-browser stand-in for the ESP32
src/rover/clients/HttpRoverClient.ts  the real rover, through /api/rover (session, seq, heartbeat, failure stop, status poll)
src/app/(rover)/api/rover/            the same-origin proxy to the rover (src/web/rover-proxy.ts filters the address)
src/rover/hooks/useRover.ts           hold-to-drive / hold-to-jog, keyboard, mode switching
src/rover/components/                 DPad, StopButton, ServoPanel, PercentSlider, ConnectionPanel, SplatViewer, ScenePanel, CapturePanel
src/rover/components/sim/             the autopilot simulator's views; src/rover/sim and src/rover/sim3d drive them
```
