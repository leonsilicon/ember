# Splat captures

The app records a scene with ARKit and saves it as a zip that's ready to turn into a
Gaussian splat. Whoever builds the splat (and the web app that shows it) only needs the zip.
LiDAR is used when the phone has it; without LiDAR, ARKit's tracked feature points seed the
splat instead (tested on an iPhone 13 mini).

## Recording and getting the zip off the phone

1. **Capture** tab → record → walk slowly around the subject (keep the chip green: "Tracking")
   → stop. The capture is saved.
2. **Share…** opens the share sheet: AirDrop it to a Mac, send it over Messages/Slack, or Save to Files.
3. Every capture is also listed on the **Captures** tab, in the Files app under
   *On My iPhone › soon2026 › Captures*, and in Finder (iPhone › Files) when the phone is plugged in.

Frames are only kept while ARKit tracking is normal, at most 3 per second, and only when the
phone has moved 5 cm or turned 5° since the last kept frame (or 1.5 s has passed), so a
30-second walk-around gives roughly 60–90 frames.

## What's in a capture zip

```
capture-20261024050847-ab12/
├── images/frame_00000.jpg …   camera frames, 1280×960, landscape (the sensor's orientation)
├── transforms.json            cameras, Nerfstudio format
├── points.ply                 seed point cloud (absent if no points were found)
└── capture.json               mode, counts, device, and these conventions in plain text
```

`transforms.json` has one entry per image:

```json
{
  "camera_model": "PINHOLE",
  "ply_file_path": "points.ply",
  "frames": [
    {
      "file_path": "images/frame_00000.jpg",
      "transform_matrix": [[r00, r01, r02, tx], [r10, r11, r12, ty], [r20, r21, r22, tz], [0, 0, 0, 1]],
      "fl_x": 1080.4, "fl_y": 1080.4, "cx": 639.1, "cy": 478.6, "w": 1280, "h": 960
    }
  ]
}
```

- **`transform_matrix`** is ARKit's `camera.transform`, unchanged: camera-to-world, row-major,
  OpenGL camera axes (+x right, +y up, the camera looks down −z). That is exactly the Nerfstudio
  convention, so no conversion is needed. (COLMAP / OpenCV tools want world-to-camera with +y down
  and +z forward: invert it and negate the y and z axes.)
- **World frame** is ARKit's: metres, gravity-aligned, +y up — the same as three.js, so a splat
  trained from it displays upright with no rotation. The origin is where the phone started.
- **Intrinsics** (`fl_x fl_y cx cy`) are in pixels of the saved 1280×960 image, per frame.
- **`points.ply`** is binary little-endian `x y z` (float) + `red green blue` (uchar), in the
  same world frame. LiDAR captures (`mode: "lidar"`) seed from depth, deduplicated on a 2 cm grid;
  no-LiDAR captures (`mode: "features"`) seed from ARKit's feature points, coloured from the frame
  they were seen in. Feature-point seeds are sparse (hundreds to a few thousand points); trainers
  densify from there.

## Turning a capture into a splat

Any trainer that reads Nerfstudio datasets works on the unzipped folder:

```bash
# Brush (runs on Macs, Windows, Linux; github.com/ArthurBrussee/brush)
brush_app capture-20261024050847-ab12 --total-steps 5000 --max-resolution 960 \
  --growth-select-fraction 0.5 --export-path out

# Nerfstudio (NVIDIA GPU)
ns-train splatfacto --data capture-20261024050847-ab12
```

Both write a standard 3DGS `.ply` that web viewers such as [Spark](https://sparkjs.dev) load directly.

**Grow harder than Brush's default.** Brush's `--growth-select-fraction 0.1` is tuned for dense
COLMAP seeds and under-grows phone captures. Measured on an M2 Max, 5000 steps at 960 px:

| Capture | growth 0.1 | growth 0.5 |
|---|---|---|
| iPhone 13 mini, no LiDAR, 51 frames, 479 feature points | 3.7k gaussians — a blur | 109k (~100 s) |
| iPhone 17 Pro, LiDAR, 19 frames (7 s), 13.8k points | 36k — good | 124k (~108 s) — sharper text and fabric |

LiDAR captures are good either way; without LiDAR, 0.5 is the difference between a blur and a scene.

**Checked on device:** projecting the seed cloud back into every frame, colours match the photos
(median |Δrgb| ≈ 11 for LiDAR, ≈ 26 for feature points) versus ≈ 41–78 for a deliberately wrong
axis convention — i.e. poses, intrinsics and depth unprojection line up.

## Debug: preview the splat from the phone

To compare against the production reconstruction, the app can train a capture with the reference
pipeline and show the result. It has two halves, so a phone only ever needs the public URL:

- **The splat server** (`server/`): a Next.js app on Vercel (region `yul1`). It serves the pages and
  API, relays the live 3D sockets, and keeps the capture jobs in Redis (from the Vercel Marketplace)
  and the zips and splats in a private Vercel Blob store.
- **The Mac agent** (`server/src/agent`, `bun run splat-agent` or `vpx _dev`): a Bun process with no
  server of its own. It trains queued captures with Brush (one at a time) and runs the live
  reconstruction, talking to the same Redis and Blob store. Nothing trains while it's offline; the
  queue waits for it.

```bash
./server/scripts/install-brush.sh     # Brush v0.3.0 into server/bin (sha256-checked)
cd server && vercel link && vercel env pull .env.local   # once: the agent's Redis and Blob credentials
bun run splat-agent                   # or `vpx _dev`
```

Everything needs the access token, `SPLAT_TOKEN` (a Vercel environment variable): the app has it
built in from `EXPO_PUBLIC_SPLAT_TOKEN`, with the server's address in `EXPO_PUBLIC_SPLAT_SERVER_URL`
(both in `apps/soon2026/.env.local` for local builds, and EAS environment variables for EAS builds).
A browser signs in once by opening any page with `?token=<SPLAT_TOKEN>` (or entering it on the page);
it keeps it in a cookie. API clients send `Authorization: Bearer <SPLAT_TOKEN>`.

In the app, **Captures** → *Debug: splat preview* (on by default in development builds) → **Preview
splat** on a capture. The phone asks the server for an upload URL, uploads the zip straight to Blob,
and the agent picks it up; the app shows training progress, and **Open splat** renders it. The viewer
page, `<server>/view/<capture id>`, works in any signed-in browser, so it can sit next to the
teammate's viewer. **Retrain splat** uploads it again, e.g. after changing the agent's settings.

| Server request | Returns |
|---|---|
| `POST /api/captures` (`X-Capture-Id`) | `201` with the job and `uploadUrl`, a presigned Blob URL to `PUT` the zip to |
| `POST /api/captures/:id/uploaded` | `201` with the job, now queued for the agent |
| `GET /api/captures`, `GET /api/captures/:id` | jobs: `state`, `step`/`steps`, `gaussians`, `error` |
| `GET /api/captures/:id/splat.ply?step=N` | the splat at step N (newest if omitted) |
| `GET /health` | whether the agent is connected, and whether it has Brush and the depth worker |
| `GET /view/:id` | three.js + Spark viewer page |

Agent settings (environment variables for `bun run splat-agent`): `SPLAT_STEPS` (5000),
`SPLAT_MAX_RESOLUTION` (960), `SPLAT_EXPORT_EVERY` (steps/10), `SPLAT_SH_DEGREE` (1),
`SPLAT_GROWTH` (0.5, Brush's growth-select-fraction), `SPLAT_MAX_SPLATS` (600k, keeps a long
capture's splat loadable in a phone browser, ~100 bytes each), `SPLAT_DATA_DIR` (`server/data`,
where it unpacks and trains), `BRUSH_BIN` (`server/bin/brush_app`). `SPLAT_REDIS_PREFIX`
(`splat:`) separates deployments sharing one Redis.

The viewer starts at the first camera and orbits around what it was looking at (the median
depth of the seed points in view), so dragging pivots on the subject.

## Live reconstruction in the browser

While the phone records, the same server can rebuild the scene live: open `<server>/live`, start
recording, and coloured points appear as you move the phone, with its camera frustum, path and
latest keyframe drawn in. The viewer follows the newest recording; drag to orbit (that stops
following, **F** resumes), **C** hides points few keyframes agreed on, and **Download PLY** saves
the cloud.

```bash
./server/scripts/install-depth.sh     # once: Depth Anything V2 (Core ML, sha256-checked) + the Swift worker
bun run splat-agent                   # or `vpx _dev`
bun server/scripts/live-replay.ts server/data/captures/<id>/<id>   # try it without the phone
```

In the app it's *Live 3D while recording* in the Gallery's debug card (on by default in development
builds, sent to the same server address); while recording, the cube in the status rail says how
many keyframes the server has fused (tap it), and the reconstruction floats top left of the
viewfinder. Tap it to swap it with the camera, FaceTime style (drag the full-screen one to orbit;
it follows the phone again a few seconds later), and tap the floating camera to swap back. That view is the same page
for this one recording, `/live/<capture id>?embed`, without its controls.

How it works (`modules/splat-capture/ios/LiveStreamer.swift` → `server/src/web/relay.ts` →
Redis → `server/src/agent` and `server/src/live`, and back):

- The phone sends its pose ~15×/s and a keyframe whenever it has moved 3 cm or turned 3° (at most
  5/s, and at least 1/s): a 640×480 JPEG, pose, intrinsics, and the ARKit feature points it sees in
  that frame. LiDAR phones send their depth map instead.
- A socket stays on whichever Vercel function instance accepted it, and instances share nothing, so
  each instance relays its sockets through two Redis streams (`server/src/bus.ts`): messages in to
  the agent, and messages out to whichever sockets they're for. Vercel closes sockets after 5
  minutes (Hobby); the phone and viewers reconnect and the session carries on by its id. If the
  agent restarts, the relays announce their sockets (and phones' hellos) to it again.
- Without LiDAR, `server/depth-worker` runs Depth Anything V2 Small on the Mac's Neural Engine
  (~30–50 ms). Its depth is relative, so each keyframe's scale and shift are fitted (RANSAC, then
  reweighted least squares) to that frame's ARKit points and to what's already reconstructed, which
  keeps overlapping views from doubling surfaces. Frames the anchors can't pin down are skipped.
- Depth is unprojected at 256×192 (edges dropped, up to 4 m) into a 2 cm voxel cloud, and every
  viewer gets the voxels that changed.
- Measured against the LiDAR seed clouds of two iPhone 17 Pro captures, the fitted depth's median
  error was 1.4% and 5% (with 60 anchors per frame).

Settings: `LIVE_VOXEL_SIZE` (0.02 m), `LIVE_MAX_DEPTH` (4 m), `DEPTH_WORKER_BIN`, `DEPTH_MODEL`.
`GET /api/live` lists sessions (the agent keeps the newest 4 in memory).

## Tests

```bash
bun run test:native    # XCTest: capture library (zip/list/delete), projection math, frame selection,
                       #         colour sampling, PLY and transforms.json writers
bun run test:server    # optional server (starts a throwaway redis-server, `brew install redis`):
                       #   download → unzip → train (fake Brush) → snapshots; API auth; live depth
                       #   fitting, voxel fusion, and phone → relay → Redis → agent → viewer
bun run typecheck
```
