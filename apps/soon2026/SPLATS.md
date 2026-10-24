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
server and show the result. `server/` is a small Bun server that accepts a capture zip, trains it
with Brush (one job at a time), and serves progressive snapshots plus a three.js + Spark viewer page.

```bash
./server/scripts/install-brush.sh     # Brush v0.3.0 into server/bin (sha256-checked)
bun run splat-server                  # http://localhost:8899 — prints the address the phone should use
```

In the app, **Captures** → *Debug: splat preview* (on by default in development builds; the server
address defaults to the Mac running Metro) → **Preview splat** on a capture. It uploads the zip,
shows training progress, and **Open splat** renders it on the phone. The same viewer page,
`http://<mac>:8899/view/<capture id>`, works in any browser, so it can sit next to the teammate's
viewer. **Retrain splat** re-runs it, e.g. after changing the server settings below. Without the app:
`curl --data-binary @capture-….zip -H 'X-Capture-Id: <id>' http://localhost:8899/api/captures`.

| Server request | Returns |
|---|---|
| `POST /api/captures` (body: capture zip) | `201` with the job |
| `GET /api/captures`, `GET /api/captures/:id` | jobs: `state`, `step`/`steps`, `gaussians`, `error` |
| `GET /api/captures/:id/splat.ply?step=N` | the splat at step N (newest if omitted) |
| `GET /view/:id` | three.js + Spark viewer page |

Server settings (environment variables for `bun run splat-server`): `SPLAT_STEPS` (5000),
`SPLAT_MAX_RESOLUTION` (960), `SPLAT_EXPORT_EVERY` (steps/10), `SPLAT_SH_DEGREE` (1),
`SPLAT_GROWTH` (0.5, Brush's growth-select-fraction), `SPLAT_MAX_SPLATS` (600k, keeps a long
capture's splat loadable in a phone browser, ~100 bytes each), `SPLAT_PORT` (8899),
`SPLAT_DATA_DIR` (`server/data`), `BRUSH_BIN` (`server/bin/brush_app`).

The viewer starts at the first camera and orbits around what it was looking at (the median
depth of the seed points in view), so dragging pivots on the subject.

## Tests

```bash
bun run test:native    # XCTest: capture library (zip/list/delete), projection math, frame selection,
                       #         colour sampling, PLY and transforms.json writers
bun run test:server    # optional server: upload → unzip → train (fake Brush) → serve
bun run typecheck
```
