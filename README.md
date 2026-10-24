# soon2026

An autonomous rover that finds **dry leaves and pine needles** on the ground and collects them,
breaking up the fuel that lets small ignitions grow into wildfires. An iPhone rides on the rover
and is its brain: camera, LiDAR depth, AR tracking and leaf detection all run on the phone, which
drives an ESP32 motor board over Bluetooth.

```bash
bun install        # from the repo root: one hoisted node_modules for every workspace
vpx _dev           # Metro + the splat server in mprocs; --force replaces a running stack
vpx _ios           # build the dev build onto the cabled iPhone and open it on that Metro (--simulator for no ARKit)
vpx _ios production  # the production app (dev.improve.soon2026) in Release beside the dev build (com.leonsilicon.soon2026.development): no dev client or Metro
```

| Path | What |
|---|---|
| `apps/soon2026` | The Expo / React Native iPhone app: camera, leaf detection, the rover's brain and autopilot, rover controls, 3D splat capture. Plus its splat server (`server/`) and the ESP32 firmware (`firmware/rover`). |
| `apps/soon2026/src/lib/rover-brain` | Leaf localisation, obstacle scanning and the drive-to-leaf autopilot (pure TypeScript, unit-tested). |
| `packages/owlvit` | Builds the on-device OWL-ViT leaf detector the app embeds. |
| `packages/dev` | The `vpx _dev` and `vpx _ios` scripts, and the TestFlight workflow's group step. |
| `.github/workflows/testflight.yml` | Ships every push to `main` to TestFlight from a self-hosted Mac; see "TestFlight" in [`apps/soon2026/AGENTS.md`](apps/soon2026/AGENTS.md). |
| `backend` | Python on the Mac: the same leaf detector, a trained **hazard** model (water, rocks, logs…), and an HTTP perception service. See [`backend/README.md`](backend/README.md). |

---

## How the rover finds and drives to dry leaves

```
 camera frame ──► OWL-ViT ("dry brown leaf", ...) ──► boxes
                                                        │  box centre + LiDAR depth (or ray onto the floor)
 ARKit pose + intrinsics ───────────────────────────────┤
                                                        ▼
                                   leaf placed in the AR world (x, y, z metres)
                                                        │  merged with earlier sightings
                                                        ▼
                                   LEAF MAP: tentative → confirmed (seen 3×) → collected
                                                        │
 LiDAR depth (5 Hz) ──► world points ──► floor fit ──► corridors: how far the rover can drive
                                                        │  along each of 13 bearings (−45°…+45°)
                                                        ▼
                     AUTOPILOT: search ─► approach nearest reachable leaf ─► collect ─► repeat
                                                        │
                                                        ▼
                                        drive(left, right) ──Bluetooth──► ESP32 motors
```

**Why this design.** The obvious approach, steering towards whichever box is in the current frame,
fails on a rover. Detections flicker. On-device detection takes a few hundred milliseconds per
frame. And as the rover closes in, the leaf drops out of the bottom of the view. So detection and
driving are decoupled:

1. **Detect and place.** Each leaf box is turned into a fixed point in ARKit's world, using the
   LiDAR depth at its centre (accurate to a few cm within about 5 m). Beyond LiDAR range, or on
   phones without LiDAR, the box centre's ray is intersected with the floor instead: leaves lie on
   the ground, so that's a good estimate on flat terrain.
2. **Remember.** Sightings within 25 cm are the same leaf. A leaf is only *confirmed* after three
   sightings, which filters out one-off false detections. Collected leaves are never revisited.
3. **Drive on pose, not on pixels.** The autopilot steers to the leaf's *world* position using the
   phone's live AR pose, polled 5 times a second independently of detection. It reaches the leaf
   even after the leaf has left the frame.
4. **Never into an obstacle.** LiDAR points are classified by height above the fitted floor:
   higher than 8 cm (and below 60 cm, so branches overhead don't count) is an **obstacle**, and
   more than 10 cm below the floor is a **drop**. For 13 steering bearings, a rover-wide strip says
   how far it is clear. The points are kept in world coordinates, so the corridors stay correct as
   the rover turns between scans.

**Safety.** The autopilot stops when:
- AR tracking isn't normal;
- the LiDAR scan is older than 1.5 s;
- you open the manual rover controls, or the camera screen loses focus;
- the rover disconnects.

It never drives forward into less than 45 cm of clearance. The firmware also stops the motors on
its own if commands stop arriving for 500 ms.

### Coordinates (what "where the leaf is" means)

- **World:** ARKit's gravity-aligned frame, in metres, with +y up. It's fixed for the session, so
  this is what to log or put on a map.
- **Rover-relative:** `distance` (horizontal metres) and `bearingDeg` (0 straight ahead,
  **+ right**), measured from the phone's position and its viewing direction flattened onto the
  ground. These match the drive mixer, where `+turn` is right.
- In the app, every detection box shows `dry leaf 23% · 1.4 m · 12° R`. The HUD shows the nearest
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
  `apps/soon2026/plugins/with-leaf-detector.js` embeds it in the app when it's prebuilt, and
  `src/hooks/use-detections.ts` runs it on the AR camera's frames. To change what it looks for,
  edit `QUERIES`, rebuild the model (`bun run --filter @soon2026/owlvit build`), then rebuild the
  app (`vpx _ios`).
- **On the Mac:** `python -m rover_vision.leaf_detector --image photo.jpg` for quick tests with
  2×2 tiling (better for small, distant leaves).
- **Scores are low in absolute terms** (0.05–0.3 is normal for OWL-ViT). Keep the threshold low
  and let the three-sighting confirmation filter out noise.

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
| `perceive.ts` | `locateDetections(detections, frameSize, camera, floorY)` → each leaf's world point, distance and bearing |
| `leaf-map.ts` | `LeafMap.observe(...)`, `.snapshot()`, `.markCollected(id)` |
| `obstacles.ts` | `scanDepth(camera)` → world points + floor; `corridors(scan, heading)` → clearance per bearing |
| `autopilot.ts` | `stepAutopilot(state, input)` → `{ left, right, message, collectedId }` for `drive()` |
| `geometry.ts` | pose maths, `headingFromPose`, `toRover`, upright↔sensor pixel mapping |

**React:**
- `src/hooks/use-rover-brain.ts` wires it together. The camera screen uses it for distance
  captions and the HUD.
- `src/components/rover-brain-hud.tsx` is the HUD with the **Auto**/**STOP** button.
- The pick-up moment is the `collecting` state in `autopilot.ts`, where the rover holds still for
  2.5 s. That's where the arm command goes once the arm exists.

**Tuning:** `DEFAULT_ROVER` (width, step height, drop depth, camera height) in `obstacles.ts`, and
`DEFAULT_AUTOPILOT` (arrival distance, speeds, stop distance) in `autopilot.ts`.

**Water and labelled hazards:** LiDAR can't see water reliably, and depth alone doesn't say *what*
an obstacle is. `backend/` has a hazard segmentation model (water, rock, log, tree, bush, person,
structure) and `python -m rover_vision serve`, which accepts the app's existing live-keyframe
message format. Post a frame (optionally with the phone's leaf boxes) to `/v1/perceive` and get
back leaf positions, hazards, a top-down occupancy grid and corridors. See
[`backend/README.md`](backend/README.md).

**Checks:**

```bash
cd apps/soon2026
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
  - the backend's 60 tests.
- **Not verified here:** the Swift changes and the app on a phone. This machine has no Xcode. The
  native change is small and follows the existing `LiveStreamer` patterns, but the first device
  build should be checked.
- **Floor ray assumes flat ground.** Beyond LiDAR range on slopes, leaf distances are estimates
  until the rover gets within about 5 m.
- **Leaf detection quality is the main limit.** OWL-ViT is general-purpose. Expect misses on leaves
  that blend into soil, and false hits on bark and pine cones. Fine-tuning on our own footage is the
  biggest single improvement.
- **The hazard model is still training** on RUGD, a daytime US off-road dataset. Indoors and at
  night, rely on LiDAR.
