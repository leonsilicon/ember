# soon2026: setup and run guide

How to run the web frontend, ship the iPhone app, and test the backend leaf
detector against a camera. For what the project is and how the rover works,
see [`README.md`](README.md).

## Prerequisites

| Tool | Needed for |
|---|---|
| [Bun](https://bun.sh) 1.4.x | All JS/TS workspaces (`frontend`, `mobile`, `packages/*`) |
| Node 24 | The Vercel CLI, `next build`, Expo CLI |
| Python 3.10+ | `backend/` (the leaf detector and perception service) |
| [uv](https://docs.astral.sh/uv/) | Building the on-device leaf model (`packages/owlvit`) |
| Xcode, CocoaPods (+ fastlane for EAS local builds) | Building the iOS app |
| `redis-server` on your PATH | Frontend tests only |

Install every JS workspace once, from the repo root:

```bash
bun install
```

---

## 1. Running the frontend

The frontend is one Next.js app (`frontend/`, package `@soon2026/frontend`). It
serves the landing page and its sign-in (`/`; the demo account is `DEMO_EMAIL` or one of
`DEMO_USERNAMES`, with `DEMO_PASSWORD`; see `frontend/README.md`), and behind that the splat server
(`/live`, `/view/[id]`, `/api/*`) and the laptop pages (`/control`,
`/sim`, `/wildfire`).

### First-time setup

The dev server runs through `vercel dev` and needs the project's environment
variables (for example `SPLAT_TOKEN`) in `frontend/.env.local`:

```bash
cd frontend
bunx vercel login
bunx vercel link          # pick the improvelabs/soon2026 project
bunx vercel env pull .env.local
```

### Start it

```bash
cd frontend
bun run dev               # http://localhost:8899
```

Useful pages:

- http://localhost:8899/control: rover remote control. It starts in **Simulated**
  mode. Switch to **Live** and enter the ESP32 address (default
  `ws://192.168.4.1/ws`) to drive the real rover. Use the local dev server for
  this, not the Vercel URL, because browsers block `ws://` from an `https://` page.
- http://localhost:8899/sim: the autopilot simulator.
- http://localhost:8899/wildfire: the wildfire hazard map.

No iPhone? To try the capture panel without one, run a fake phone camera (needs
Pillow; it advertises itself with macOS's `dns-sd`):

```bash
python3 frontend/scripts/mock-phone-camera.py
```

### Full dev stack (Metro + Mac agent)

To run the splat server's Mac agent alongside Metro for the mobile app:

```bash
vpx _dev                  # from anywhere in the repo; --force replaces a running stack
# or just the agent:
cd frontend && bun run agent
```

Logs go to `.mprocs-logs/metro.log` and `.mprocs-logs/splat-agent.log` at the repo root.

On Leon's MacBook the agent also runs as a pm2 service (`soon2026-agent`) that GitHub Actions updates on every push to
`main`; `vpx _dev` then leaves out its agent pane, since two agents would take the same work. See "The Mac agent as a
service" in `frontend/README.md`.

### Checks

```bash
cd frontend
bun run typecheck
bun run lint
bun test                  # starts a throwaway Redis, so redis-server must be installed
```

### Deploying the frontend

`.github/workflows/vercel.yml` handles it:

- A push to `main` on `SOON-2026/soon2026` deploys to production (https://soon2026.vercel.app).
- A pull request from a branch in that repo gets a preview deploy.
- The workflow needs the `VERCEL_TOKEN` repository secret. Root directory, env
  vars and region (`yul1`) come from the Vercel project settings.

To deploy by hand:

```bash
bunx vercel pull --yes --environment=production
bunx vercel build --prod
bunx vercel deploy --prebuilt --prod
```

---

## 2. Deploying the mobile app

`mobile/` is an Expo (SDK 58) / React Native iPhone app. It uses native modules
(ARKit, VisionCamera, ExecuTorch), so it **only runs as a development or
production build. It never runs in Expo Go**, and the camera screen needs a real
iPhone because the simulator has no ARKit.

There are two app variants, chosen by `EXPO_PUBLIC_APP_VARIANT`. They install
side by side:

| Variant | Name | Bundle ID |
|---|---|---|
| `development` | soon2026 (Dev) | `com.leonsilicon.soon2026.development` |
| `production` (the default when unset) | soon2026 | `dev.improve.soon2026` |

### Step 1: build the on-device leaf detector (required)

The app embeds an OWL-ViT model from `packages/owlvit/dist/`. That folder is
gitignored, so you have to build it before any prebuild. Otherwise
`plugins/with-leaf-detector.js` stops the build with "The leaf detector isn't built".

```bash
bun run --filter @soon2026/owlvit build
```

> The default fp16 export currently fails its own drift check by a hair. If it
> does, export in fp32 instead (358 MB, exact):
> `cd packages/owlvit && uv run export.py --precision fp32`

### Step 2a: development build on your iPhone

Plug in the iPhone (or have it on the same Wi-Fi), then:

```bash
vpx _dev                  # terminal 1: Metro (+ Mac agent)
vpx _ios                  # terminal 2: prebuild, build, install, and open on that Metro
vpx _ios --device <udid|name>   # a phone on Wi-Fi instead of the cable
vpx _ios --simulator            # simulator (no ARKit / camera screen)
```

Without `vpx`, use the package scripts:

```bash
cd mobile
bun run ios -- --device   # EXPO_PUBLIC_APP_VARIANT=development expo run:ios
bun run start             # Metro with --dev-client
```

**Signing with your own Apple team** (for example a free personal team): set both
of these before prebuilding:

```bash
export SOON2026_APPLE_TEAM_ID=XXXXXXXXXX
export SOON2026_BUNDLE_ID=com.yourname.soon2026
```

### Step 2b: production build on your iPhone (no Metro)

```bash
vpx _ios production
```

This builds the Release configuration with the JS embedded and no dev client.
The splat server URL and token are baked in from `EXPO_PUBLIC_SPLAT_SERVER_URL`
and `EXPO_PUBLIC_SPLAT_TOKEN` (in `mobile/.env.local` or EAS environment variables).

### Step 3: ship to TestFlight

**Automatic.** Every push to `main` on `SOON-2026/soon2026` runs
`.github/workflows/testflight.yml` on the self-hosted Mac runner. It builds the
leaf detector (cached), runs `eas build --local`, and uploads with `eas submit`.
The internal "SOON" TestFlight group gets each build automatically, about 5–15
minutes after the upload finishes processing.

**Manual** (from a Mac with Xcode, CocoaPods, fastlane and about 25 GB free):

```bash
bun run --filter @soon2026/owlvit build            # if dist/ isn't built yet
cd mobile
export LEAF_DETECTOR_DIST="$(cd ../packages/owlvit/dist && pwd)"   # the local build copies the repo without gitignored files
bunx eas-cli@24.12.1 build --platform ios --profile production --local --non-interactive --output ./soon2026.ipa
bunx eas-cli@24.12.1 submit --platform ios --profile production --path ./soon2026.ipa
```

Use `--local`. A cloud EAS build uploads the repo without gitignored files, so
the leaf model would be missing.

**One-time setup** (only once per Expo account/runner): run
`bunx eas-cli@24.12.1 credentials -p ios` in `mobile/` with the `production`
profile. Reuse the distribution certificate, create the App Store provisioning
profile, and assign the App Store Connect API key. Testers must be users on the
App Store Connect team and members of the "SOON" group.

### Checks

```bash
cd mobile
bun run lint
bun run typecheck
bun run test:brain        # rover-brain + detection-tracker unit tests
bun run test:native       # Swift tests for the splat-capture module
```

---

## 3. Testing the backend leaf camera detector

`backend/rover_vision` is the Mac-side twin of the phone's brain. It uses the same
OWL-ViT leaf detector (`google/owlvit-base-patch32`, text prompts, no training)
and the same depth checks. It picks the GPU automatically: CUDA, then Apple MPS,
then CPU.

### Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install pyrealsense2-macosx     # only if you use an Intel RealSense (Apple Silicon)
```

The first run downloads the model weights from Hugging Face. On macOS, give your
terminal camera access in **System Settings → Privacy & Security → Camera**, or
the webcam won't open.

### a. Detector only: on a photo

```bash
python -m rover_vision.leaf_detector --image photo.jpg
# writes photo-detections.jpg next to it
```

### b. Detector only: live camera

```bash
python -m rover_vision.leaf_detector                         # auto: RealSense if present, else webcam
python -m rover_vision.leaf_detector --camera-source webcam
python -m rover_vision.leaf_detector --camera-source realsense
```

Useful flags:

| Flag | Default | What it does |
|---|---|---|
| `--threshold` | `0.05` | Minimum score. OWL-ViT scores of 0.05–0.3 are normal, so keep it low. |
| `--tile-grid {1,2,3}` | `2` | Overlapping crops per side. 2 helps small or distant leaves; 3 is slower. |
| `--query "..."` | | Extra prompt, repeatable, e.g. `--query "brown leaves in grass"`. |
| `--max-frames N` | `0` (forever) | Stop after N frames. |
| `--no-display` | | No preview window. Needs `--max-frames` for a camera. |
| `--output out.jpg` | | Save the last annotated frame. |

Headless smoke test (handy over SSH or in CI on a machine with a camera):

```bash
python -m rover_vision.leaf_detector --camera-source webcam --max-frames 20 --no-display --output last.jpg
```

### c. Full perception: leaves + distance + map

`navigate` adds distance and bearing to each leaf, depth checks, a top-down
minimap and a suggested move:

```bash
python -m rover_vision navigate                              # webcam (no depth: flat-floor estimates)
python -m rover_vision navigate --source realsense           # calibrated, with depth obstacles
python -m rover_vision navigate --source video.mp4 --save out.mp4
python -m rover_vision navigate --source photo.jpg --pitch 25 --camera-height 0.3
python -m rover_vision navigate --json --no-show             # rover-perception/2 JSON per frame
```

Without depth, distances come from projecting onto flat ground. Set `--pitch`
(degrees below horizontal) and `--camera-height` (metres) to match how the camera
is held. OWL-ViT takes about 1.5 s per frame on an M4, so in `navigate` it runs in
the background while depth and geometry update every frame.

### d. The HTTP service the phone talks to

```bash
python -m rover_vision serve                     # http://0.0.0.0:8765
python -m rover_vision serve --no-leaf-detector  # trust the phone's own leaf boxes

curl http://localhost:8765/v1/health             # "leaf_detector": true once loaded
```

`POST /v1/perceive` takes one frame in the app's keyframe format and returns
`rover-perception/2` JSON. `POST /v1/perceive/annotated` returns the overlay as a
JPEG for debugging. The wire format is in [`backend/README.md`](backend/README.md).

### e. Automated tests

```bash
cd backend
.venv/bin/python -m pytest -q
```

These run on synthetic scenes with known geometry (perception, occupancy, spatial
maths, and the protocol/server), so they don't need a camera or the OWL-ViT
weights.

### Troubleshooting

- **`Could not open video source '0'`**: grant camera access to your terminal (see above), or try `--source 1`.
- **`RealSense SDK missing`**: `pip install pyrealsense2-macosx`.
- **Too many false positives**: raise `--threshold` to about 0.1. **Missing distant leaves**: use `--tile-grid 3`.
- **Crashes under load on Apple GPU**: PyTorch MPS can't run two inferences at once. The server already serializes frames, so don't run two detector processes on the same GPU.
