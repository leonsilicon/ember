# soon2026

An autonomous rover that finds **dry leaves and pine needles** on the ground and collects them,
breaking up the fuel that lets small ignitions grow into wildfires. An iPhone rides on the rover
and is its brain: camera, LiDAR depth, AR tracking and leaf detection all run on the phone, which
drives an ESP32 motor board over Bluetooth.

```bash
bun install        # from the repo root: one hoisted node_modules for every workspace
vpx _dev           # Metro + the splat server's Mac agent in mprocs; --force replaces a running stack
vpx _ios           # build the dev build onto the cabled iPhone and open it on that Metro (--simulator for no ARKit)
vpx _ios production  # the production app (dev.improve.soon2026) in Release beside the dev build (com.leonsilicon.soon2026.development): no dev client or Metro
```

| Path | What |
|---|---|
| `mobile` | The Expo / React Native iPhone app: camera, leaf detection, the rover's brain and autopilot, rover controls, 3D splat capture. Plus the ESP32 firmware (`firmware/rover`). |
| `mobile/src/lib/rover-brain` | Leaf localisation, obstacle scanning and the drive-to-leaf autopilot (pure TypeScript, unit-tested). |
| `frontend` | The web app, a Next.js app on Vercel (https://soon2026.vercel.app): the splat server, which trains captures into splats and rebuilds recordings live in 3D through a Bun agent on a Mac (see "Train and preview the splat" in [`mobile/SPLATS.md`](mobile/SPLATS.md)), plus the laptop pages: rover remote control at `/control`, the autopilot simulator at `/sim` and the wildfire hazard map at `/wildfire`. See [`frontend/README.md`](frontend/README.md). |
| `packages/owlvit` | Builds the on-device OWL-ViT leaf detector the app embeds. |
| `packages/dev` | The `vpx _dev` and `vpx _ios` scripts. |
| `.github/workflows/testflight.yml` | Ships every push to `main` to TestFlight from a self-hosted Mac; see "TestFlight" in [`mobile/AGENTS.md`](mobile/AGENTS.md). |
| `.github/workflows/vercel.yml` | Deploys every push to `main` to Vercel from GitHub Actions; see "Deploying" in [`frontend/README.md`](frontend/README.md). |
| `firmware/rover_ws` | ESP32 Arduino sketch: Wi-Fi access point + WebSocket command endpoint for the web app. |
| `data/wildfire` | Ontario wildfire hazard pipeline that feeds the web app's map. |
| `backend` | Python on the Mac: the same leaf detector and depth logic as the app, for testing with a webcam, photo or RealSense, plus an HTTP perception service. See [`backend/README.md`](backend/README.md). |

---

## How the rover finds dry leaves and piles them up

```
 camera frame ──► OWL-ViT ("dry brown leaf", ...) ──► boxes
                                                        │  LiDAR depth over the box (or ray onto the floor)
 ARKit pose + intrinsics ───────────────────────────────┤
                                                        ▼
                                   leaf placed in the AR world (x, y, z metres)
                                                        │  LiDAR check: on the ground? leaf-sized?
                                                        │  merged with earlier sightings
                                                        ▼
                                   LEAF MAP: tentative → confirmed (seen 3×) → collected
                                                        │         (seen again later = missed: retry, ≤3×)
                                                        │
 LiDAR depth (5 Hz) ──► world points ──► floor fit ──► obstacle memory (last 10 s)
                                                        │  corridors: how far the rover can drive
                                                        │  along each of 13 bearings (−45°…+45°)
                                                        ▼
   AUTOPILOT: search ─► approach ─► line up ─► scoop ─► lift ─► to the pile ─► dump ─► back off ─┐
                 ▲                                                                              │
                 └──────────────────────────────────────────────────────────────────────────────┘
                                                        │
                                                        ▼
                         drive(left, right) + scoop up/down/dump ──Bluetooth──► ESP32
```

**Why this design.** The obvious approach, steering towards whichever box is in the current frame,
fails on a rover. Detections flicker. On-device detection takes a few hundred milliseconds per
frame. And as the rover closes in, the leaf drops out of the bottom of the view. So detection and
driving are decoupled:

1. **Detect and place.** Each leaf box is turned into a fixed point in ARKit's world, using the
   median LiDAR depth over the middle of the box (accurate to a few cm within about 5 m). Beyond
   LiDAR range, or on phones without LiDAR, the box centre's ray is intersected with the floor
   instead: leaves lie on the ground, so that's a good estimate on flat terrain.
2. **Check with LiDAR.** OWL-ViT also fires on brown things that aren't leaves on the ground. LiDAR
   knows where each box really is, so it's rejected if it's more than 25 cm off the ground (bark,
   a fence, furniture), more than 1.5 m across (a hillside rather than a pile), under 2 cm, or more
   than 8 m away. Rejected boxes show the reason, e.g. `✕ 0.6 m off the ground`.
3. **Remember.** Sightings within 25 cm are the same leaf. A leaf is only *confirmed* after three
   sightings, which filters out one-off false detections. A scooped leaf seen on the ground again
   later was missed, so it's retried, up to 3 times.
4. **Drive on pose, not on pixels.** The autopilot steers to the leaf's *world* position using the
   phone's live AR pose, polled 5 times a second independently of detection. It reaches the leaf
   even after the leaf has left the frame.
5. **Never into an obstacle.** LiDAR points are classified by height above the fitted floor:
   higher than 8 cm (and below 60 cm, so branches overhead don't count) is an **obstacle**, and
   more than 10 cm below the floor is a **drop**. For 13 steering bearings, a rover-wide strip says
   how far it is clear. The phone only sees about 50° side to side, so points from the last 10 s
   are remembered in world coordinates. A rock the rover just turned away from stays blocked, while
   whatever the camera sees now always replaces what it remembered there. Something remembered
   right beside the body blocks steering towards that side.
6. **Scoop, then pile.** See below.

### Scooping and the pile

Put the rover where the pile should be and press **Pile here** in the HUD: the pile goes where the
rover stands, so the rover starts from the pile. It collects the leaves within its **work circle**
round the pile (`workRadiusM`, 6 ft = 1.83 m by default) and leaves everything outside it alone.
Leaves within 0.75 m (2.5 ft) of the pile's centre count as piled. Then **Auto**:

1. **Choose a leaf**: the nearest confirmed one, plus half its distance from the pile (so it
   clears outwards from the pile), plus 2 m if something is in the way. It sticks with its choice
   unless another is clearly better.
2. **Approach** to 50 cm. If the way is blocked, it **detours**: it holds the world direction of the
   open corridor nearest the goal for 3 s, then tries straight again. Boxed in, it backs up first.
   A leaf it can't reach in 90 s is given up on.
3. **Line up**, stopped at 50 cm, where the leaf is still in view (closer in, it's below the
   camera): turn slowly until it's within 5° of dead ahead, then hold still 0.8 s so close-up
   sightings correct its position. If it isn't seen again, it's gone.
4. **Scoop**: lower the scoop, drive straight until the lip (15 cm ahead of the camera) is 10 cm
   past the leaf, lift. That last stretch is blind and steered on the AR pose. Every leaf the
   lip passed over counts as scooped.
5. **To the pile** once the bin holds `capacity` scoops (default 4: each scoop tips into a bin
   on the rover), or with a part-full bin once nothing is left nearby, detouring the same way.
   Dump at 60 cm from its centre, facing it, or wherever the grown pile blocks the way first.
   The bin tips out, then it backs up 35 cm and searches again.
6. **Park** once a full look round finds nothing left in the circle, and look again every 20 s.

The scoop position (`up` / `down` / `dump`) is part of every autopilot step, but the firmware has
no scoop yet, so the app only sends the wheel speeds for now.

### Simulator (for the web app)

`src/lib/rover-brain/sim.ts` runs the same `Brain` the phone runs against a virtual world: flat
ground, leaves, cylinders for trunks and rocks, optional static scene points (a downsampled
splat), and a pile. It simulates the camera (54° × 69° view, detections less likely and noisier
further away, optional false detections), the LiDAR, differential drive turning about the axle,
and the scoop. The brain only gets those sightings and scans, never the true positions. It's pure
TypeScript, so a web app can import it directly:

```ts
import { RoverSim } from '<repo>/mobile/src/lib/rover-brain';

const sim = new RoverSim({
  leaves: [[0.5, -2], [-1, -1.5]],                                // [x, z] metres, floor at y = 0
  obstacles: [{ center: [0, -1.6], radiusM: 0.25, heightM: 1 }],
  pile: { center: [0, 0, 1], radiusM: 1 },
  // points: splatCentres,                                         // seen by the simulated LiDAR
}, { seed: 1 });
sim.start();
// Each animation frame (one step = 200 ms of rover time):
const frame = sim.step();
// frame.rover.pose: the phone's camera-to-world matrix (column-major), for a camera or a rover model
// frame.leaves: the truth (ground / scoop / pile); frame.tracked: what the brain believes
// frame.tick.step: mode, message, wheel speeds, scoop; frame.tick.corridors; frame.stats
```

World axes are ARKit's (metres, +y up, yaw 0 facing −z, + clockwise from above), so a splat
captured with the app's splat capture lines up once its floor is at y = 0. `SimOptions` sets the
sensor and scoop odds; `Brain` options (autopilot, leaf map, obstacle memory) are the phone's.

`tests/rover-brain/sim.test.ts` runs whole jobs: an open patch, leaves behind a trunk, a
cluttered yard, false detections with a scoop that misses 30% of the time, a pile it must leave
alone, a leaf that never comes up, and a bigger scoop. With the default sensors, 20 seeds per
world (open patch, trunk, yard) all end with every leaf in the pile and no collisions, in 3 to
6 minutes of rover time. With false detections, double the position noise and a 70% scoop,
16–18 of 20 runs per world clear everything within 20 minutes, also without collisions.

**Safety.** The autopilot stops when:
- AR tracking isn't normal;
- the LiDAR scan is older than 1.5 s;
- you open the manual rover controls, or the camera screen loses focus;
- the rover disconnects.

It never drives forward into less than 45 cm of clearance. The firmware also stops the motors on
its own if commands stop arriving for 500 ms.

### Watching the rover's camera from the laptop

While its camera screen is open, the rover app serves the camera on the Wi-Fi as MJPEG (about 12 fps,
640 px) and announces it with Bonjour (`_rovercam._tcp`). The web app's dev server listens for that
(`frontend/src/phone-discovery.ts`, `GET /api/phone-camera`), so opening the app on the iPhone is enough: the
Control page's camera panel switches to the **iPhone camera** and links up by itself, in either mode. If
discovery can't help (another subnet, a static build), type the address from the cast icon at the top
of the camera screen, e.g. `192.168.1.23` (port 8787). The same panel's **Record 1 fps** / **Snap one**
capture from the phone too, as full-resolution stills it encodes on request (`/frame.jpg?size=1920`).
Frames are only encoded while someone watches. The server is `CameraStreamServer` in
`modules/splat-capture/ios/SplatCaptureCore` (routes `/camera.mjpg`, `/frame.jpg`, `/status`), fed by
`CaptureController`; `swift test` covers it. Phone and laptop must share a network.

### Coordinates (what "where the leaf is" means)

- **World:** ARKit's gravity-aligned frame, in metres, with +y up. It's fixed for the session, so
  this is what to log or put on a map.
- **Rover-relative:** `distance` (horizontal metres) and `bearingDeg` (0 straight ahead,
  **+ right**), measured from the phone's position and its viewing direction flattened onto the
  ground. These match the drive mixer, where `+turn` is right.
- In the app, every detection box shows how far the leaf is from the phone, measured with LiDAR on
  the same frame: `dry leaf 1.4 m` (straight-line, so slightly more than the horizontal
  `distance`; `45 cm` under a metre, `– m` where LiDAR has no reading). Without LiDAR, boxes show
  the detector's confidence instead, plus the floor-plane estimate: `dry leaf 23% · ~1.4 m · 12° R`
  (the front camera shows only the confidence). Boxes LiDAR rules out say why. The HUD shows the nearest
  confirmed leaf, how many have been found and collected, and the corridor fan (bar height is the
  clearance; red is blocked).

### Mounting the phone

Mount it in **portrait**, back camera facing forward and tilted roughly 10–30° down, about
20–40 cm above the ground. The maths works for any mount because it uses the AR pose, but the
leaf detector sees the frame upright only in portrait. The floor is fitted from LiDAR
automatically; if it can't be seen, the rover falls back to `DEFAULT_ROVER.cameraHeightM`
(0.30 m), so set that to the real mount height.

---

## Leaf detection

**OWL-ViT** (`google/owlvit-base-patch32`) is an open-vocabulary detector: it finds whatever the
text queries describe, with no training. The queries ("a photo of a dead leaf", "a dry brown leaf",
"fallen brown leaves", "a pile of autumn leaves", …) are set in `packages/owlvit/export.py` for the
phone and in `backend/rover_vision/leaf_detector.py` for the Mac.

- **On the phone:** `packages/owlvit` exports it as an ExecuTorch / Core ML program,
  `mobile/plugins/with-leaf-detector.js` embeds it in the app when it's prebuilt, and
  `src/hooks/use-detections.ts` runs it on the AR camera's frames. To change what it looks for,
  edit `QUERIES`, rebuild the model (`bun run --filter @soon2026/owlvit build`), then rebuild the
  app (`vpx _ios`).
- **On the Mac:** `python -m rover_vision.leaf_detector --image photo.jpg` for quick tests with
  2×2 tiling (better for small, distant leaves).
- **Scores are low in absolute terms** (0.05–0.3 is normal for OWL-ViT). Keep the threshold low
  and let the three-sighting confirmation filter out noise.
- **The boxes on screen are tracked, not raw.** The detector runs about nine times a second and
  scores each frame on its own, so a leaf scoring around the threshold blinks on and off, jitters,
  and swaps between synonymous labels. `src/lib/detection-tracker.ts` matches each frame's
  detections to the boxes already being tracked (as fractions of the whole frame, so zooming
  doesn't break a track): a box shows after two sightings at the threshold (or one strong one),
  stays through 400 ms without a sighting and on sightings down to 60% of the threshold, moves
  halfway towards each new sighting, and keeps its label until another clearly wins. The rover
  brain places only the frame's actual sightings in the world, never a coasting box. Tuning:
  `trackerOptions` there.
- **It's meant to run the whole time the app is open.** The leaf indicator spins while the model
  loads (Core ML compiles it on the phone the first time) and while it runs its first frames; a
  load that fails is tried again after 5, 10, 30, then 60 s; switching detection off in the camera
  options leaves a dimmed leaf that turns it back on when tapped; and the camera screen keeps the
  phone awake, since a locked screen stops ARKit and detection with it.

**What we tried first** (`backend/archive/`, gitignored): a YOLOv8-seg model trained on a
beet/rye leaf-disease dataset (green leaves 0.54 mAP50, but dead leaves only 0.04 because that data
has no forest-floor litter), YOLOE text prompts (0 detections on rover-height photos of leaf-covered
paths), and colour thresholding (fires on road lines and dry grass). OWL-ViT with LiDAR placement
and multi-sighting confirmation is the most reliable option without collecting our own labelled
data.

**Next step for accuracy:** record rover-height footage of the terrain you'll work on, label a few
hundred frames, and fine-tune. The archive has the frame-extraction and pre-labelling tools. Every
detection the app makes already comes with its 3D position, which makes labelling and evaluation
much easier.

---

## Integration reference (app)

**Native: `modules/splat-capture`**

- `nextDetectionFrame(maxSize)` now also returns `camera`: the AR pose (column-major
  camera-to-world), sensor-image intrinsics, a tracking flag, and the LiDAR depth (float32 metres
  plus confidence). The frame is the sensor image turned a quarter turn clockwise.
- `currentCamera(includeDepth)` returns the newest frame's camera without an image. The steering
  loop polls it.

**Logic: `src/lib/rover-brain`** (no React Native imports; reusable on a server or in a web app)

| Module | Use |
|---|---|
| `perceive.ts` | `locateDetections(detections, frameSize, camera, floorY)` → `{ leaves, rejected }`: each leaf's world point, distance, bearing, height above the floor and size; rejected boxes with the reason |
| | `lidarDistances(detections, frameSize, camera)` → each box's straight-line LiDAR distance from the phone (null without a reading; undefined without depth). `useDetections` returns it with every result as `distances` |
| `leaf-map.ts` | `LeafMap.observe(...)`, `.snapshot()`, `.markCollected(id, now)`, `.markFailed(id)` |
| `obstacles.ts` | `scanDepth(camera)` → world points + floor; `ObstacleMemory` keeps the last few seconds; `corridors(scan, heading)` → clearance per bearing |
| `autopilot.ts` | `stepAutopilot(state, input)` → `{ left, right, scoop, message, collectedIds, ... }` for `drive()` |
| `brain.ts` | `Brain`: leaf map, obstacle memory, pile and autopilot together. `.observe(...)`, `.addScan(...)`, `.tick(now, heading)` |
| `sim.ts` | `RoverSim`: the brain in a virtual world (see Simulator above) |
| `geometry.ts` | pose maths, `headingFromPose`, `toRover`, upright↔sensor pixel mapping |

**React:**
- `src/hooks/use-rover-brain.ts` wires it together. The camera screen uses it for distance
  captions and the HUD.
- `src/components/rover-brain-hud.tsx` is the HUD with the **Auto**/**STOP** button.
- The scoop command is `step.scoop` in the steering loop of `use-rover-brain.ts`. That's where it
  goes to the firmware once the scoop is wired up.

**Tuning:**
- `DEFAULT_ROVER` (width, step height, drop depth, camera height) and `DEFAULT_OBSTACLE_MEMORY`
  in `obstacles.ts`;
- `DEFAULT_LEAF_CHECK` (height off the ground, size, range) in `perceive.ts`;
- `DEFAULT_AUTOPILOT` (line-up distance, scoop geometry and timings, capacity, dump distance,
  speeds, stop distance) in `autopilot.ts`. Set `scoopLipM` and `scoopWidthM` to the real scoop.
  Then try changes in the simulator first (`bun run test:brain`).

**Mac service:** `python -m rover_vision serve` (in `backend/`) accepts the app's existing
live-keyframe message. Post a frame, optionally with the phone's leaf boxes, to `/v1/perceive` and
get back the same result computed on the Mac: leaf positions, depth-rejected boxes, a top-down
occupancy grid and corridors. See [`backend/README.md`](backend/README.md).

**The leaf model for the phone** is built by `packages/owlvit` into `packages/owlvit/dist/`
(gitignored), and the app bundles it at prebuild (`plugins/with-leaf-detector.js`). Leon's default fp16 build currently fails his own
drift check by a hair (16.8 px against a 16 px limit, on a candidate scoring a few percent), so use
`uv run export.py --precision fp32` from `packages/owlvit` (358 MB, exact, runs on the GPU rather
than the Neural Engine) until that limit is revisited.

**Checks:**

```bash
cd mobile
bun run test:brain      # rover-brain unit tests (synthetic AR scenes with known answers)
bun run typecheck
cd ../../backend && .venv/bin/python -m pytest -q
```

---

## Product ideas: the web app

The phone already knows, in metres, where every leaf was found and collected, where the rover
drove, and (with splat capture) what the site looks like in 3D. A web app turns that into
something landowners, fire departments and municipalities would pay for.

1. **Live mission view.** A map of the rover's path, leaves found vs. collected, blocked areas
   and battery, streamed from the phone over the existing live WebSocket. Includes a remote STOP
   and a "go here" tap for supervised autonomy.
2. **Fuel-load heatmaps.** Aggregate leaf detections per square metre into a fuel-density map for
   each property. Re-run weekly to show build-up, and schedule the rover where it's worst.
3. **Before/after reports.** Splat captures before and after a run, with collected-leaf counts and
   coverage. That's proof of work for HOA, insurer or municipal defensible-space requirements,
   such as California's defensible-space zones.
4. **Fire-risk scoring.** Combine fuel maps with weather (wind, humidity, red-flag warnings),
   slope and distance to structures into a per-property risk score, with alerts when a cleared area
   needs another pass.
5. **Fleet and scheduling.** Many rovers across many properties: geofenced zones, no-go areas
   (gardens, ponds), charging and run windows, and a job queue for contractors.
6. **Data flywheel.** Every confirmed detection comes with a photo crop and a 3D position. Owners
   can tap "not a leaf" on misdetections, which builds a labelled dataset to fine-tune a better
   detector. That's a real moat over off-the-shelf models.
7. **Business models.** Rover-as-a-service for HOAs and parks, per-acre clearing contracts,
   insurer partnerships (premium discounts for verified clearance), and municipal fuel-break
   programmes.

---

## Status and limits

- **Verified here:**
  - the rover-brain unit tests;
  - the app type-check (only the two pre-existing CSS-module typing errors remain, and Expo
    generates those typings at dev-server start);
  - lint on all new and changed files;
  - the backend's 37 tests;
  - the iOS JavaScript bundle (`expo export --platform ios`).
- **Not verified here:** the Swift changes and the app on a phone. This machine has no Xcode. The
  native change is small and follows the existing `LiveStreamer` patterns, but the first device
  build should be checked.
- **Floor ray assumes flat ground.** Beyond LiDAR range on slopes, leaf distances are estimates
  until the rover gets within about 5 m.
- **Leaf detection quality is the main limit.** OWL-ViT is general-purpose. Expect misses on leaves
  that blend into soil, and false hits on bark and pine cones. Fine-tuning on our own footage is the
  biggest single improvement.
- **Obstacles are LiDAR-only.** That catches anything solid within about 5 m, but not water, glass
  or thin wire. A trained hazard model (`backend/archive/hazard-model`, gitignored) was dropped: it
  scored 0.47 mAP50 on trees, but 0.05 on water and 0.00 on rocks.
